// Provider details for the legal pages, editable at runtime.
//
// These live in config/provider.json on the host and are substituted when a
// page is served, not when the site is built: a deploy from the laptop must
// never overwrite what was maintained on the server.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const FIELDS = [
  { key: "name", label: "Anbieter / Firma", hint: "z. B. Northbound Systems UG (haftungsbeschränkt)" },
  { key: "street", label: "Straße und Hausnummer" },
  { key: "zip", label: "PLZ" },
  { key: "city", label: "Ort" },
  { key: "country", label: "Land", hint: "leer lassen für Deutschland" },
  { key: "represented", label: "Vertreten durch", hint: "Pflicht bei UG/GmbH: Name des Geschäftsführers" },
  { key: "email", label: "E-Mail", hint: "leer = hello@wacli.me" },
  { key: "phone", label: "Telefon" },
  { key: "vatId", label: "USt-IdNr." },
  { key: "register", label: "Registergericht", hint: "z. B. Amtsgericht Offenbach" },
  { key: "registerNo", label: "Registernummer", hint: "z. B. HRB 12345" },
  { key: "responsible", label: "Verantwortlich für den Inhalt", hint: "leer = wie Anbieter" },
  { key: "copyrightYear", label: "Copyright-Jahr", hint: "leer = 2026" },
  { key: "copyrightHolder", label: "Copyright-Inhaber", hint: "leer = wacli.me" },
];

const DEFAULTS = { email: "hello@wacli.me", copyrightYear: "2026", copyrightHolder: "wacli.me" };

export class Provider {
  constructor(file) {
    this.file = file;
    this.tokenFile = path.join(path.dirname(file), "admin-token.txt");
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  write(values) {
    var clean = {};
    for (const field of FIELDS) {
      const raw = values[field.key];
      if (typeof raw === "string" && raw.trim()) clean[field.key] = raw.trim().slice(0, 200);
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(clean, null, 2), { mode: 0o600 });
    return clean;
  }

  // Created on first start so there is never a default password to guess.
  token() {
    try {
      const existing = fs.readFileSync(this.tokenFile, "utf8").trim();
      if (existing) return existing;
    } catch {
      /* not created yet */
    }
    const fresh = crypto.randomBytes(24).toString("base64url");
    fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true });
    fs.writeFileSync(this.tokenFile, fresh + "\n", { mode: 0o600 });
    return fresh;
  }

  checkToken(candidate) {
    const want = Buffer.from(this.token());
    const got = Buffer.from(String(candidate || ""));
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }
}

export function esc(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function value(data, key) {
  const raw = data[key];
  return (typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULTS[key]) || "";
}

function addressLines(data) {
  const street = value(data, "street");
  const town = [value(data, "zip"), value(data, "city")].filter(Boolean).join(" ");
  const country = value(data, "country");
  return [street, town, country].filter(Boolean);
}

// True once there is a name and a postal address — that is the point at which
// the site may stop calling itself an alpha without provider details.
export function isComplete(data) {
  return Boolean(value(data, "name") && value(data, "street") && value(data, "city"));
}

// Which fields still stand between the current state and a § 5 DDG imprint.
export function missingForImprint(data) {
  return [
    value(data, "name") ? null : "Anbieter / Firma",
    value(data, "street") ? null : "Straße und Hausnummer",
    value(data, "city") ? null : "Ort",
  ].filter(Boolean);
}

export function providerBlock(data) {
  const email = value(data, "email");
  const parts = [];
  const name = value(data, "name");

  // Anything already entered is shown straight away — typing a company name and
  // seeing nothing change reads like a broken form. The honest alpha note stays
  // until the postal address is there too, because that is what § 5 DDG wants.
  if (name) {
    const lines = [esc(name)].concat(addressLines(data).map(esc));
    parts.push("<h3>Provider</h3><p>" + lines.join("<br>") + "</p>");
    const represented = value(data, "represented");
    if (represented) parts.push("<p>Represented by " + esc(represented) + "</p>");
  }

  if (!isComplete(data)) {
    parts.push(
      '<div class="note"><p><strong>Closed alpha, provider details pending.</strong> ' +
        "This site is currently a technical preview with no signups, no payments and no " +
        "advertising. Full provider information under § 5 DDG — legal name, postal address " +
        "and, where applicable, VAT ID and register entry — is published here before the " +
        "service opens to the public or takes a single euro.</p></div>",
    );
  }

  parts.push(
    "<h3>Contact</h3><p>General: " +
      '<a href="mailto:' + esc(email) + '">' + esc(email) + "</a><br>" +
      'Privacy: <a href="mailto:privacy@wacli.me">privacy@wacli.me</a><br>' +
      'Security: <a href="mailto:security@wacli.me">security@wacli.me</a></p>',
  );

  const phone = value(data, "phone");
  if (phone) parts.push("<p>Phone: " + esc(phone) + "</p>");

  const register = value(data, "register");
  const registerNo = value(data, "registerNo");
  const vatId = value(data, "vatId");
  if (register || registerNo || vatId) {
    const rows = [];
    if (register || registerNo) rows.push("Register: " + esc([register, registerNo].filter(Boolean).join(", ")));
    if (vatId) rows.push("VAT ID: " + esc(vatId));
    parts.push("<h3>Register and VAT</h3><p>" + rows.join("<br>") + "</p>");
  }

  const responsible = value(data, "responsible") || value(data, "name");
  parts.push(
    "<h3>Responsible for the content</h3><p>" +
      (responsible ? esc(responsible) : "The operator of this site, reachable at the address above.") +
      "</p>",
  );

  if (!isComplete(data)) {
    parts.push(
      "<p>Mail reaches a person and is answered within a few working days. For a legal notice, " +
        "write to the general address and ask for a postal address; it is provided on request.</p>",
    );
  }

  return parts.join("\n      ");
}

// One sentence for the privacy policy and the terms, which both have to say
// who the other side of the contract is.
export function providerShort(data) {
  const name = value(data, "name");
  if (!name) return 'the operator of this site (see <a href="/imprint">Imprint</a>)';
  const lines = addressLines(data);
  const text = esc(name) + (lines.length ? ", " + lines.map(esc).join(", ") : "");
  // The sentence around this already ends in a full stop; "Ltd.." looks sloppy.
  return text.replace(/\.$/, "");
}

export function footerLine(data) {
  return (
    "© " + esc(value(data, "copyrightYear")) + " " + esc(value(data, "copyrightHolder")) +
    " · MIT licensed · Not affiliated with WhatsApp or Meta."
  );
}

export function substitute(html, data) {
  if (!html.includes("{{provider")) return html;
  return html
    .replaceAll("{{provider_block}}", providerBlock(data))
    .replaceAll("{{provider_short}}", providerShort(data))
    .replaceAll("{{provider_footer}}", footerLine(data));
}
