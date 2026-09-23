// Paddle: turning a click into a checkout, and a webhook back into a plan.
//
// Paddle is the merchant of record here. It sells to the customer, handles VAT
// in every country and invoices us — which is the whole reason for the 5% it
// takes. We never see a card number and never file an OSS return.
//
// Two secrets live on the host, both 0600 and outside the repo:
//   config/paddle-api-key.txt          — scoped to this service only
//   config/paddle-webhook-secret.txt   — for verifying notifications

import fs from "node:fs";
import crypto from "node:crypto";

const API = "https://api.paddle.com";

export class Paddle {
  constructor({ apiKeyFile, webhookSecretFile, clientTokenFile, prices, checkoutUrl }) {
    this.apiKeyFile = apiKeyFile;
    this.webhookSecretFile = webhookSecretFile;
    this.clientTokenFile = clientTokenFile;
    this.prices = prices;
    this.checkoutUrl = checkoutUrl;
  }

  // Shown in the page source by design: this token can only open a checkout,
  // never read or change anything.
  get clientToken() {
    return this.#secret(this.clientTokenFile);
  }

  #secret(file) {
    try {
      const value = fs.readFileSync(file, "utf8").trim();
      return value || null;
    } catch {
      return null;
    }
  }

  get configured() {
    return Boolean(this.#secret(this.apiKeyFile));
  }

  async #call(method, path, body) {
    const key = this.#secret(this.apiKeyFile);
    if (!key) throw new Error("Paddle API key is not configured on this host.");
    const res = await fetch(API + path, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "paddle-version": "1",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Paddle returned non-JSON (HTTP ${res.status}).`);
    }
    if (parsed.error) {
      // Never let Paddle's message reach the visitor verbatim — it can quote
      // internal ids. Log the detail, show the caller something plain.
      console.error(`[paddle] ${method} ${path} -> ${parsed.error.code}: ${parsed.error.detail || ""}`);
      throw new Error("Paddle rejected the request.");
    }
    return parsed.data;
  }

  // The checkout is created server-side so the tenant id rides along in
  // custom_data. That is what lets the webhook know whose plan to upgrade —
  // a hosted payment link cannot carry it, and trusting a redirect parameter
  // would let anyone claim someone else's purchase.
  async createCheckout({ tenantId, cycle }) {
    const priceId = this.prices[cycle];
    if (!priceId) throw new Error("Unknown billing cycle.");
    const data = await this.#call("POST", "/transactions", {
      items: [{ price_id: priceId, quantity: 1 }],
      custom_data: { tenant: tenantId, service: "wacli.me" },
      // Without this Paddle uses the seller account's default payment link,
      // which this account points at RevenueCat from another product's setup.
      // Overriding per transaction keeps our customers on our own domain and
      // leaves that global setting alone.
      checkout: { url: this.checkoutUrl },
    });
    const url = data.checkout && data.checkout.url;
    if (!url) throw new Error("Paddle did not return a checkout URL.");
    return { url, transactionId: data.id };
  }

  // Paddle signs every notification: `Paddle-Signature: ts=<unix>;h1=<hmac>`
  // over "<ts>:<raw body>". Verify against the raw bytes — re-serialising the
  // JSON changes them and every signature fails.
  verify(rawBody, signatureHeader) {
    const secret = this.#secret(this.webhookSecretFile);
    if (!secret) return { ok: false, reason: "webhook secret not configured" };
    const parts = Object.fromEntries(
      String(signatureHeader || "")
        .split(";")
        .map((piece) => piece.split("=", 2))
        .filter((pair) => pair.length === 2),
    );
    if (!parts.ts || !parts.h1) return { ok: false, reason: "malformed signature header" };

    // A replayed notification is a real attack; five minutes is Paddle's own
    // guidance and comfortably more than any retry needs.
    const ageSeconds = Math.abs(Date.now() / 1000 - Number(parts.ts));
    if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return { ok: false, reason: "timestamp out of range" };

    const expected = crypto.createHmac("sha256", secret).update(`${parts.ts}:${rawBody}`).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(parts.h1);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "signature mismatch" };
    return { ok: true };
  }
}

// What a notification means for the account, or null when it says nothing we
// act on. Kept separate from the HTTP layer so it can be tested on its own.
export function planChangeFrom(event) {
  const type = event && event.event_type;
  const data = (event && event.data) || {};
  const tenant = data.custom_data && data.custom_data.tenant;
  if (!tenant) return null;

  // subscription.activated fires when a trial converts to a paid run, and
  // Paddle's destination subscribes to it by default — missing it would leave
  // a paying customer on the free plan.
  if (
    type === "subscription.created" ||
    type === "subscription.updated" ||
    type === "subscription.resumed" ||
    type === "subscription.activated" ||
    type === "subscription.past_due" ||
    type === "subscription.trialing"
  ) {
    const active = data.status === "active" || data.status === "trialing";
    return {
      tenant,
      plan: active ? "pro" : "free",
      // Paddle tells us how far the customer has paid. Storing that, rather
      // than a boolean, means a lost cancellation webhook expires by itself.
      planUntil: (data.current_billing_period && data.current_billing_period.ends_at) || null,
      subscriptionId: data.id || null,
      reason: `${type} (${data.status})`,
    };
  }

  if (type === "subscription.canceled" || type === "subscription.paused") {
    return {
      tenant,
      // A cancellation takes effect at the end of the paid period, not now.
      // Cutting access on the day someone cancels would be taking money for
      // days they already paid for.
      plan: "pro",
      planUntil: (data.current_billing_period && data.current_billing_period.ends_at) || data.canceled_at || null,
      subscriptionId: data.id || null,
      reason: `${type} — access runs to the end of the paid period`,
    };
  }

  return null;
}
