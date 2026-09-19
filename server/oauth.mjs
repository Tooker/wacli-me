// OAuth 2.1 for MCP clients.
//
// The point of this module is that nobody ever copies a token: a client that
// hits /mcp unauthenticated is told where to authorize, opens a browser, the
// visitor scans a WhatsApp QR code there, and the client walks away with an
// access token it obtained itself.
//
// State is in memory. Registrations and codes are cheap to recreate, and an
// alpha that loses them on restart is more honest than a half-baked database.

import crypto from "node:crypto";

const CODE_TTL_MS = 5 * 60_000;
const PENDING_TTL_MS = 15 * 60_000;
const MAX_CLIENTS = 500; // registration is open to anyone; do not grow forever
const MAX_REDIRECT_URIS = 5;
// Schemes a browser would execute rather than navigate to. A registration is
// public, so an unvalidated redirect_uri is an XSS vector on the /authorize page.
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "blob:", "file:"]);

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export class OAuthProvider {
  constructor({ issuer }) {
    this.issuer = issuer.replace(/\/$/, "");
    this.clients = new Map(); // client_id -> registration
    this.pending = new Map(); // pending id -> authorization request
    this.codes = new Map(); // code -> { token, client_id, redirect_uri, challenge }
  }

  // --------------------------------------------------------- discovery ---

  protectedResourceMetadata() {
    return {
      resource: `${this.issuer}/mcp`,
      resource_name: "wacli.me — WhatsApp",
      authorization_servers: [this.issuer],
      bearer_methods_supported: ["header"],
      resource_documentation: `${this.issuer}/docs`,
    };
  }

  authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      // Shown by clients that render the authorization server's identity.
      logo_uri: `${this.issuer}/logo.svg`,
      op_policy_uri: `${this.issuer}/privacy`,
      op_tos_uri: `${this.issuer}/terms`,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      scopes_supported: ["whatsapp"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      service_documentation: `${this.issuer}/docs`,
    };
  }

  // ------------------------------------------------------ registration ---

  register(body) {
    const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
    if (redirectUris.length === 0) {
      const err = new Error("redirect_uris is required");
      err.code = "invalid_client_metadata";
      throw err;
    }
    if (redirectUris.length > MAX_REDIRECT_URIS) {
      const err = new Error(`at most ${MAX_REDIRECT_URIS} redirect_uris`);
      err.code = "invalid_client_metadata";
      throw err;
    }
    for (const uri of redirectUris) {
      let parsed;
      try {
        parsed = new URL(uri);
      } catch {
        const err = new Error(`redirect_uri is not a URL: ${uri}`);
        err.code = "invalid_redirect_uri";
        throw err;
      }
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
      // https, http on loopback, and private-use schemes for native clients.
      const ok =
        parsed.protocol === "https:" ||
        (parsed.protocol === "http:" && loopback) ||
        (parsed.protocol !== "http:" && !FORBIDDEN_SCHEMES.has(parsed.protocol));
      if (!ok) {
        const err = new Error(`redirect_uri scheme not allowed: ${parsed.protocol}`);
        err.code = "invalid_redirect_uri";
        throw err;
      }
    }

    const clientId = `c_${crypto.randomBytes(16).toString("hex")}`;
    const registration = {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 80) : "MCP client",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    // Map keeps insertion order: drop the oldest registration when full. A
    // client whose registration was evicted simply registers again.
    while (this.clients.size >= MAX_CLIENTS) {
      this.clients.delete(this.clients.keys().next().value);
    }
    this.clients.set(clientId, registration);
    return registration;
  }

  // -------------------------------------------------------- authorize ---

  /** Validate an /oauth/authorize request and park it until the QR is scanned. */
  beginAuthorization(params) {
    const clientId = params.get("client_id") || "";
    const redirectUri = params.get("redirect_uri") || "";
    const client = this.clients.get(clientId);

    // Errors before we trust redirect_uri must be shown, never redirected.
    if (!client) return { error: "Unknown client. Register the client first." };
    if (!client.redirect_uris.includes(redirectUri)) {
      return { error: "redirect_uri does not match this client's registration." };
    }
    if (params.get("response_type") !== "code") {
      return { redirectError: "unsupported_response_type", redirectUri, state: params.get("state") };
    }
    if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) {
      return { redirectError: "invalid_request", redirectUri, state: params.get("state") };
    }

    const id = crypto.randomBytes(12).toString("base64url");
    this.pending.set(id, {
      clientId,
      clientName: client.client_name,
      redirectUri,
      state: params.get("state") || "",
      challenge: params.get("code_challenge"),
      createdAt: Date.now(),
    });
    setTimeout(() => this.pending.delete(id), PENDING_TTL_MS).unref?.();
    return { pendingId: id, clientName: client.client_name };
  }

  getPending(id) {
    return this.pending.get(id);
  }

  /** Called once the visitor's WhatsApp is linked: mint the code to hand back. */
  completeAuthorization(pendingId, accessToken) {
    const request = this.pending.get(pendingId);
    if (!request) return null;
    this.pending.delete(pendingId);

    const code = base64url(crypto.randomBytes(32));
    this.codes.set(code, {
      token: accessToken,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      challenge: request.challenge,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    setTimeout(() => this.codes.delete(code), CODE_TTL_MS).unref?.();

    const url = new URL(request.redirectUri);
    url.searchParams.set("code", code);
    if (request.state) url.searchParams.set("state", request.state);
    return url.toString();
  }

  // ------------------------------------------------------------ token ---

  exchange(body) {
    if (body.grant_type !== "authorization_code") {
      return { error: "unsupported_grant_type" };
    }
    const entry = this.codes.get(body.code || "");
    if (!entry || entry.expiresAt < Date.now()) return { error: "invalid_grant" };
    this.codes.delete(body.code); // single use, always

    if (body.client_id && body.client_id !== entry.clientId) return { error: "invalid_grant" };
    if (body.redirect_uri && body.redirect_uri !== entry.redirectUri) return { error: "invalid_grant" };

    const verifier = body.code_verifier || "";
    const digest = base64url(crypto.createHash("sha256").update(verifier).digest());
    if (!verifier || digest !== entry.challenge) return { error: "invalid_grant" };

    return {
      token: {
        access_token: entry.token,
        token_type: "Bearer",
        scope: "whatsapp",
      },
    };
  }
}
