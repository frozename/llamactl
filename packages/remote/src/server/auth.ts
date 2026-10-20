import type { inferenceRpc } from "@llamactl/core";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Bearer token auth for the node agent. The agent stores only the
 * SHA-256 hash of the token on disk; the plaintext is shown once at
 * `agent init` time and must be transmitted out-of-band (via the
 * bootstrap blob). Every request carries `Authorization: Bearer <tok>`,
 * which the agent hashes and constant-time-compares to the stored
 * digest.
 */

export function generateToken(): { token: string; hash: string } {
  const token = `ll_agt_${randomBytes(24).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function extractBearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  if (!h.startsWith("Bearer ")) return null;
  const rest = h.slice("Bearer ".length).trim();
  return rest.length > 0 ? rest : null;
}

/**
 * Constant-time check that a plaintext bearer token hashes to the
 * expected sha-256 hex digest. Mirrors {@link verifyBearer} so every
 * bearer comparison in the codebase routes through the same
 * `timingSafeEqual` path — a `===` on the hex digest leaks a timing
 * side channel (byte-by-byte short-circuit) that distinguishes a
 * near-correct token from a wholly wrong one. The length guard keeps
 * `timingSafeEqual` from throwing on unequal-length buffers; an
 * unexpected length is itself a mismatch.
 */
export function bearerHashMatches(token: string, expectedHashHex: string): boolean {
  const actualHex = hashToken(token);
  if (actualHex.length !== expectedHashHex.length) return false;
  return timingSafeEqual(Buffer.from(actualHex, "hex"), Buffer.from(expectedHashHex, "hex"));
}

export function verifyBearer(req: Request, expectedHashHex: string): boolean {
  const token = extractBearer(req);
  if (!token) return false;
  return bearerHashMatches(token, expectedHashHex);
}

/** A worker-RPC service credential's binding: its hash and the claims it carries (P4.1). */
export type ServiceCredentialBinding = inferenceRpc.InferenceServiceClaimsV1 & {
  tokenHash: string;
};

/**
 * The claims a worker-RPC service credential is bound to, derived from
 * the worker's own bindings and never from anything else the caller
 * sent. Every binding is compared, in constant time, so the timing shows
 * neither a near miss nor which binding matched. Null when there is no
 * credential or no binding for it.
 */
export function claimsForServiceCredential(
  token: string | null | undefined,
  bindings: readonly ServiceCredentialBinding[],
): inferenceRpc.InferenceServiceClaimsV1 | null {
  if (token === null || token === undefined || token.length === 0) return null;
  let match: ServiceCredentialBinding | null = null;
  for (const binding of bindings) {
    if (bearerHashMatches(token, binding.tokenHash) && match === null) match = binding;
  }
  if (match === null) return null;
  const { tokenHash: _hash, ...claims } = match;
  return claims;
}

/** The claims for the request's bearer when it is a worker-RPC service credential. */
export function authenticateServiceCredential(
  req: Request,
  bindings: readonly ServiceCredentialBinding[],
): inferenceRpc.InferenceServiceClaimsV1 | null {
  return claimsForServiceCredential(extractBearer(req), bindings);
}

/**
 * Single-use worker-RPC service tokens for the reverse tunnel (P4.1 X5).
 * Central relays a request to whichever node holds the target name, and
 * a name is only as strong as the shared tunnel bearer, so a tunnel
 * caller never sends its reusable service credential. It sends, per
 * call, an HMAC keyed by SHA-256(credential), the hash the worker already
 * keeps as the binding, over the target node name, the procedure, the
 * attempt the call names (a fresh request id for negotiate and catalog),
 * a digest of its input, central's relay principal for the hop, a nonce
 * and an expiry. The worker recomputes every bound value from its own
 * name and the request it is serving, and accepts each nonce once.
 *
 * Format: `v1.<expiresAtMs>.<nonce>.<base64url subject>.<base64url mac>`.
 */
export const SERVICE_TOKEN_HEADER = "x-llamactl-service-token";
export const SERVICE_TOKEN_TTL_MS = 60_000;
export const SERVICE_TOKEN_MAX_LENGTH = 1024;
/** Expiries further ahead are refused: the TTL plus the clock skew tolerated. */
const SERVICE_TOKEN_MAX_AHEAD_MS = 2 * SERVICE_TOKEN_TTL_MS;
const SERVICE_TOKEN_VERSION = "v1";
const SERVICE_TOKEN_DOMAIN = "llamactl-worker-rpc-service-token";
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const EXPIRY_PATTERN = /^[0-9]{1,15}$/;
const NONCE_SWEEP_INTERVAL_MS = 1_000;

/** What a service token is bound to, besides its subject, nonce and expiry. */
export interface ServiceTokenCall {
  /** The tunnel node name the call targets. */
  node: string;
  /** The procedure path, `inferenceRpc.<procedure>`. */
  method: string;
  /** The call's input, as sent. */
  input: unknown;
  /** Central's relay principal for the bearer the relay hop presents. */
  relayPrincipal: string;
}

/**
 * A relay bearer's principal: central stamps it on every frame it relays
 * for that bearer, so a token is good only through the relay identity its
 * caller used. It identifies the bearer without revealing it.
 */
export function relayPrincipalOf(bearer: string): string {
  return createHash("sha256").update(`llamactl-relay-principal\0${bearer}`).digest("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The attempt (or cancel id) an inferenceRpc call names; none for negotiate and catalog. */
export function serviceTokenSubjectOf(method: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  let named: unknown;
  if (method === "inferenceRpc.submit") {
    named = isRecord(input["envelope"]) ? input["envelope"]["attemptId"] : undefined;
  } else if (method === "inferenceRpc.cancel") {
    named = input["attemptId"] ?? input["cancelId"];
  } else if (method === "inferenceRpc.stream" || method === "inferenceRpc.status") {
    named = input["attemptId"];
  }
  return typeof named === "string" ? named : undefined;
}

function serviceTokenMac(
  key: Buffer,
  call: ServiceTokenCall,
  subject: string,
  expiresAt: number,
  nonce: string,
): Buffer {
  // The relay drops an undefined input, so its absence digests the same on both ends.
  const json = JSON.stringify(call.input) as string | undefined;
  const digest = createHash("sha256")
    .update(json ?? "")
    .digest("base64url");
  const bound = [
    SERVICE_TOKEN_DOMAIN,
    SERVICE_TOKEN_VERSION,
    call.node,
    call.method,
    subject,
    digest,
    call.relayPrincipal,
    expiresAt,
    nonce,
  ];
  return createHmac("sha256", key).update(JSON.stringify(bound)).digest();
}

/** Mints the single-use token a tunnel caller sends for one call instead of its credential. */
export function mintServiceToken(
  credential: string,
  call: ServiceTokenCall,
  opts: { now?: number; ttlMs?: number } = {},
): string {
  const subject =
    serviceTokenSubjectOf(call.method, call.input) ??
    `req-${randomBytes(12).toString("base64url")}`;
  const expiresAt = (opts.now ?? Date.now()) + (opts.ttlMs ?? SERVICE_TOKEN_TTL_MS);
  const nonce = randomBytes(18).toString("base64url");
  const key = createHash("sha256").update(credential).digest();
  const mac = serviceTokenMac(key, call, subject, expiresAt, nonce);
  return [
    SERVICE_TOKEN_VERSION,
    String(expiresAt),
    nonce,
    Buffer.from(subject, "utf8").toString("base64url"),
    mac.toString("base64url"),
  ].join(".");
}

interface ParsedServiceToken {
  expiresAt: number;
  nonce: string;
  subject: string;
  mac: Buffer;
}

function parseServiceToken(token: string): ParsedServiceToken | null {
  if (token.length > SERVICE_TOKEN_MAX_LENGTH) return null;
  const [version, expiry, nonce, subject64, mac64, ...rest] = token.split(".");
  if (version !== SERVICE_TOKEN_VERSION || rest.length > 0) return null;
  if (expiry === undefined || !EXPIRY_PATTERN.test(expiry)) return null;
  if (nonce === undefined || !NONCE_PATTERN.test(nonce)) return null;
  if (subject64 === undefined || mac64 === undefined) return null;
  const subject = Buffer.from(subject64, "base64url").toString("utf8");
  const mac = Buffer.from(mac64, "base64url");
  if (subject.length === 0 || mac.length !== 32) return null;
  return { expiresAt: Number(expiry), nonce, subject, mac };
}

export interface ServiceTokenVerifier {
  /**
   * The claims of the binding a token was minted from, when it was minted
   * for this node and this call, has not expired and was never presented
   * before; null otherwise. A token verifies once.
   */
  claimsFor(
    token: string | null | undefined,
    call: Omit<ServiceTokenCall, "node">,
    bindings: readonly ServiceCredentialBinding[],
  ): inferenceRpc.InferenceServiceClaimsV1 | null;
  /** Nonces held against replay. Each is dropped once its token expires. */
  heldNonces(): number;
}

/** Whether a parsed token is live now and names the attempt the call does. */
function usableFor(
  parsed: ParsedServiceToken,
  call: Omit<ServiceTokenCall, "node">,
  at: number,
): boolean {
  if (at > parsed.expiresAt || parsed.expiresAt - at > SERVICE_TOKEN_MAX_AHEAD_MS) return false;
  const named = serviceTokenSubjectOf(call.method, call.input);
  return named === undefined || named === parsed.subject;
}

/** The binding whose key minted the token; every binding is compared in constant time. */
function mintedBy(
  parsed: ParsedServiceToken,
  call: ServiceTokenCall,
  bindings: readonly ServiceCredentialBinding[],
): ServiceCredentialBinding | null {
  let match: ServiceCredentialBinding | null = null;
  for (const binding of bindings) {
    const key = Buffer.from(binding.tokenHash, "hex");
    if (key.length !== 32) continue;
    const expected = serviceTokenMac(key, call, parsed.subject, parsed.expiresAt, parsed.nonce);
    if (timingSafeEqual(expected, parsed.mac) && match === null) match = binding;
  }
  return match;
}

/**
 * The worker side of service tokens. A verified nonce is held until its
 * token expires, which bounds the set by the verified tokens of one TTL
 * window.
 */
export function createServiceTokenVerifier(opts: {
  node: string;
  now?: () => number;
}): ServiceTokenVerifier {
  const now = opts.now ?? Date.now;
  const seen = new Map<string, number>();
  let swept = 0;
  const sweep = (at: number): void => {
    if (at - swept < NONCE_SWEEP_INTERVAL_MS) return;
    swept = at;
    for (const [nonce, expiresAt] of seen) if (expiresAt < at) seen.delete(nonce);
  };
  return {
    claimsFor(token, call, bindings): inferenceRpc.InferenceServiceClaimsV1 | null {
      const parsed = token === null || token === undefined ? null : parseServiceToken(token);
      const at = now();
      if (parsed === null || !usableFor(parsed, call, at)) return null;
      sweep(at);
      if (seen.has(parsed.nonce)) return null;
      const match = mintedBy(parsed, { ...call, node: opts.node }, bindings);
      if (match === null) return null;
      seen.set(parsed.nonce, parsed.expiresAt);
      const { tokenHash: _hash, ...claims } = match;
      return claims;
    },
    heldNonces: () => seen.size,
  };
}

/**
 * Standard 401 response for any authed endpoint that fails bearer
 * verification. JSON body + content-type lets tRPC/HTTP clients parse
 * a clean error envelope instead of throwing "Failed to parse JSON" on
 * a bare-string body. Shape is stable so client-side recognizers can
 * key off `error.code === 'UNAUTHORIZED'`.
 */
export function unauthorizedResponse(message = "invalid bearer token"): Response {
  return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message } }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="llamactl-agent"',
    },
  });
}
