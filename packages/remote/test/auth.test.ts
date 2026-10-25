import type { inferenceRpc } from "@llamactl/core";

import { describe, expect, test } from "bun:test";
import { createHash, createHmac, randomBytes } from "node:crypto";

import * as authModule from "../src/server/auth.js";
import {
  authenticateServiceCredential,
  claimsForServiceCredential,
  createServiceTokenVerifier,
  extractBearer,
  generateToken,
  hashToken,
  mintServiceToken,
  namedBearerFor,
  type NamedBearerToken,
  relayPrincipalOf,
  SERVICE_TOKEN_TTL_MS,
  type ServiceCredentialBinding,
  type ServiceTokenCall,
  unauthorizedResponse,
  verifyBearer,
} from "../src/server/auth.js";

describe("auth", () => {
  test("generateToken emits a token with the expected prefix and a matching hash", () => {
    const { token, hash } = generateToken();
    expect(token.startsWith("ll_agt_")).toBe(true);
    expect(token.length).toBeGreaterThan(20);
    expect(hash).toBe(hashToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("extractBearer handles Authorization header shapes", () => {
    const good = new Request("http://x/", { headers: { authorization: "Bearer abc" } });
    expect(extractBearer(good)).toBe("abc");
    const empty = new Request("http://x/", { headers: { authorization: "Bearer " } });
    expect(extractBearer(empty)).toBeNull();
    const wrong = new Request("http://x/", { headers: { authorization: "Basic abc" } });
    expect(extractBearer(wrong)).toBeNull();
    const none = new Request("http://x/");
    expect(extractBearer(none)).toBeNull();
  });

  test("verifyBearer accepts the matching token", () => {
    const { token, hash } = generateToken();
    const req = new Request("http://x/", { headers: { authorization: `Bearer ${token}` } });
    expect(verifyBearer(req, hash)).toBe(true);
  });

  test("verifyBearer rejects tampered token", () => {
    const { token, hash } = generateToken();
    const tampered = token.replace(/.$/, token.endsWith("a") ? "b" : "a");
    const req = new Request("http://x/", { headers: { authorization: `Bearer ${tampered}` } });
    expect(verifyBearer(req, hash)).toBe(false);
  });

  test("verifyBearer rejects missing bearer", () => {
    const req = new Request("http://x/");
    const { hash } = generateToken();
    expect(verifyBearer(req, hash)).toBe(false);
  });
});

/**
 * #218 — the agent accepts several named operator bearers beside the
 * primary one. Each entry is checked in constant time, like every other
 * bearer comparison in this module.
 */
describe("namedBearerFor", () => {
  test("a match among several entries returns its name", () => {
    const ci = generateToken();
    const grafana = generateToken();
    const tokens: NamedBearerToken[] = [
      { name: "ci", tokenHash: ci.hash },
      { name: "grafana", tokenHash: grafana.hash },
    ];
    expect(namedBearerFor(ci.token, tokens)).toBe("ci");
    expect(namedBearerFor(grafana.token, tokens)).toBe("grafana");
  });

  test("a wrong, tampered, null or empty token returns null", () => {
    const ci = generateToken();
    const tokens: NamedBearerToken[] = [{ name: "ci", tokenHash: ci.hash }];
    expect(namedBearerFor(generateToken().token, tokens)).toBeNull();
    const tampered = ci.token.replace(/.$/, ci.token.endsWith("a") ? "b" : "a");
    expect(namedBearerFor(tampered, tokens)).toBeNull();
    expect(namedBearerFor(null, tokens)).toBeNull();
    expect(namedBearerFor("", tokens)).toBeNull();
  });

  test("an empty list returns null", () => {
    expect(namedBearerFor(generateToken().token, [])).toBeNull();
  });
});

describe("unauthorizedResponse", () => {
  test("status 401 with JSON body and content-type", async () => {
    const res = unauthorizedResponse();
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="llamactl-agent"');
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body).toEqual({
      error: { code: "UNAUTHORIZED", message: "invalid bearer token" },
    });
  });

  test("accepts a custom message override", async () => {
    const res = unauthorizedResponse("token expired");
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toBe("token expired");
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

/**
 * P4.1 (#139) X5 — worker-RPC service credentials. The worker stores each
 * credential only as a hash bound to its claims; the claims a request
 * gets are derived from that binding, never from anything the caller
 * sends besides the credential itself.
 */
describe("service-credential claims (P4.1)", () => {
  function claims(serviceId: string): inferenceRpc.InferenceServiceClaimsV1 {
    return {
      serviceId,
      operations: ["negotiate", "catalog", "submit", "stream", "status", "cancel"],
      deployments: ["deploy/w/a"],
      models: [],
      tenants: ["tenant-a"],
      credentialScopeId: "scope-a",
    };
  }

  function bind(serviceId: string): { token: string; binding: ServiceCredentialBinding } {
    const { token, hash } = generateToken();
    return { token, binding: { ...claims(serviceId), tokenHash: hash } };
  }

  function bearer(token: string): Request {
    return new Request("http://x/trpc/inferenceRpc.submit", {
      headers: { authorization: `Bearer ${token}`, "x-llamactl-claims": "tenants=evil" },
    });
  }

  test("a bound credential yields exactly its binding's claims, never the stored hash", () => {
    const a = bind("svc-a");
    const b = bind("svc-b");
    const got = claimsForServiceCredential(b.token, [a.binding, b.binding]);
    expect(got).toEqual(claims("svc-b"));
    expect(Object.keys(got ?? {})).not.toContain("tokenHash");
    // Headers other than the credential are never read for claims.
    expect(authenticateServiceCredential(bearer(a.token), [a.binding, b.binding])).toEqual(
      claims("svc-a"),
    );
  });

  test("no credential, an unknown credential or a tampered one yields no claims", () => {
    const a = bind("svc-a");
    expect(claimsForServiceCredential(undefined, [a.binding])).toBeNull();
    expect(claimsForServiceCredential("", [a.binding])).toBeNull();
    expect(claimsForServiceCredential(generateToken().token, [a.binding])).toBeNull();
    const tampered = a.token.replace(/.$/, a.token.endsWith("a") ? "b" : "a");
    expect(claimsForServiceCredential(tampered, [a.binding])).toBeNull();
    expect(authenticateServiceCredential(new Request("http://x/"), [a.binding])).toBeNull();
    expect(claimsForServiceCredential(a.token, [])).toBeNull();
  });

  test("the operator bearer is not a service credential", () => {
    const operator = generateToken();
    const a = bind("svc-a");
    expect(verifyBearer(bearer(operator.token), operator.hash)).toBe(true);
    expect(authenticateServiceCredential(bearer(operator.token), [a.binding])).toBeNull();
  });

  test("rotation: during the overlap both credentials verify; once the old binding is removed only the new one does", () => {
    const old = bind("svc-a");
    const next = bind("svc-a");
    const overlap = [old.binding, next.binding];
    expect(claimsForServiceCredential(old.token, overlap)?.serviceId).toBe("svc-a");
    expect(claimsForServiceCredential(next.token, overlap)?.serviceId).toBe("svc-a");
    const rotated = [next.binding];
    expect(claimsForServiceCredential(old.token, rotated)).toBeNull();
    expect(claimsForServiceCredential(next.token, rotated)?.serviceId).toBe("svc-a");
  });

  test("revocation: a removed binding stops verifying; the others are untouched", () => {
    const a = bind("svc-a");
    const b = bind("svc-b");
    const revoked = [b.binding];
    expect(claimsForServiceCredential(a.token, revoked)).toBeNull();
    expect(claimsForServiceCredential(b.token, revoked)).toEqual(claims("svc-b"));
  });

  test("a binding with a malformed hash never matches", () => {
    const a = bind("svc-a");
    const broken = { ...a.binding, tokenHash: "not-hex" };
    expect(claimsForServiceCredential(a.token, [broken])).toBeNull();
  });
});

/** HMAC-SHA256(credential, "llamactl-worker-rpc-token\0" + node), as AGENTS.md documents it. */
function tunnelKeyOf(credential: string, node: string): string {
  return createHmac("sha256", credential)
    .update(`llamactl-worker-rpc-token\0${node}`)
    .digest("hex");
}

/**
 * P4.1 (#139) X5 — single-use service tokens for the reverse tunnel. A
 * tunnel caller sends, per call, a token keyed by the binding's per-worker
 * tunnelKey, HMAC-SHA256(credential, "llamactl-worker-rpc-token\0" + node),
 * and bound to the target node, the call, its input, central's relay
 * principal, a nonce and an expiry. The worker verifies it against that
 * tunnelKey, once; the stored tokenHash never mints one.
 */
describe("service tokens (P4.1)", () => {
  const NODE = "worker-a-tunnel";
  const RELAY = relayPrincipalOf("central-relay-bearer");
  const NOW = 1_800_000_000_000;

  function claims(serviceId: string): inferenceRpc.InferenceServiceClaimsV1 {
    return {
      serviceId,
      operations: ["negotiate", "catalog", "submit", "stream", "status", "cancel"],
      deployments: ["deploy/w/a"],
      models: [],
      tenants: ["tenant-a"],
      credentialScopeId: "scope-a",
    };
  }

  function bind(serviceId: string): { token: string; binding: ServiceCredentialBinding } {
    const { token, hash } = generateToken();
    const tunnelKey = tunnelKeyOf(token, NODE);
    return { token, binding: { ...claims(serviceId), tokenHash: hash, tunnelKey } };
  }

  function statusCall(attemptId = "att-1"): ServiceTokenCall {
    return {
      node: NODE,
      method: "inferenceRpc.status",
      input: { attemptId },
      relayPrincipal: RELAY,
    };
  }

  function verifier(
    clock: { now: number } = { now: NOW },
  ): ReturnType<typeof createServiceTokenVerifier> {
    return createServiceTokenVerifier({ node: NODE, now: () => clock.now });
  }

  function served(call: ServiceTokenCall): Omit<ServiceTokenCall, "node"> {
    const { node: _node, ...rest } = call;
    return rest;
  }

  test("a token verifies once, for its call on its node, and is not the credential", () => {
    const a = bind("svc-a");
    const token = mintServiceToken(a.token, statusCall(), { now: NOW });
    expect(token).not.toContain(a.token);
    expect(token).not.toContain(a.binding.tokenHash);
    // It is no credential: neither as a bearer nor as a binding's preimage.
    expect(claimsForServiceCredential(token, [a.binding])).toBeNull();
    const v = verifier();
    expect(v.claimsFor(token, served(statusCall()), [a.binding])).toEqual(claims("svc-a"));
    // Replayed: refused.
    expect(v.claimsFor(token, served(statusCall()), [a.binding])).toBeNull();
  });

  test("a token for another node, call, attempt, input or relay principal is refused", () => {
    const a = bind("svc-a");
    const v = verifier();
    const refusedFor = (call: ServiceTokenCall, served: Omit<ServiceTokenCall, "node">): void => {
      expect(v.claimsFor(mintServiceToken(a.token, call, { now: NOW }), served, [a.binding])).toBe(
        null,
      );
    };
    const call = statusCall();
    refusedFor({ ...call, node: "worker-b-tunnel" }, served(call));
    refusedFor({ ...call, method: "inferenceRpc.cancel" }, served(call));
    refusedFor(statusCall("att-2"), served(call));
    refusedFor(call, { ...served(call), relayPrincipal: relayPrincipalOf("another-bearer") });
    const negotiate = {
      node: NODE,
      method: "inferenceRpc.negotiate",
      input: { versions: [{ major: 1, minor: 0 }] },
      relayPrincipal: RELAY,
    };
    refusedFor(negotiate, { ...served(negotiate), input: { versions: [{ major: 2, minor: 0 }] } });
    // The same calls, bound right, verify.
    expect(
      v.claimsFor(mintServiceToken(a.token, negotiate, { now: NOW }), served(negotiate), [
        a.binding,
      ]),
    ).toEqual(claims("svc-a"));
  });

  test("an expired token, or one that expires too far ahead, is refused", () => {
    const a = bind("svc-a");
    const clock = { now: NOW };
    const v = verifier(clock);
    const token = mintServiceToken(a.token, statusCall(), { now: NOW });
    clock.now = NOW + SERVICE_TOKEN_TTL_MS + 1;
    expect(v.claimsFor(token, served(statusCall()), [a.binding])).toBeNull();
    clock.now = NOW;
    const farAhead = mintServiceToken(a.token, statusCall(), {
      now: NOW,
      ttlMs: 10 * SERVICE_TOKEN_TTL_MS,
    });
    expect(v.claimsFor(farAhead, served(statusCall()), [a.binding])).toBeNull();
  });

  test("a tampered or malformed token is refused", () => {
    const a = bind("svc-a");
    const v = verifier();
    const token = mintServiceToken(a.token, statusCall(), { now: NOW });
    const parts = token.split(".");
    const mac = parts[5] ?? "";
    const flipped = `${mac.slice(0, -2)}${mac.endsWith("AA") ? "BB" : "AA"}`;
    const tampered = [...parts.slice(0, 5), flipped].join(".");
    const later = [parts[0], parts[1], String(NOW + 1000), ...parts.slice(3)].join(".");
    for (const bad of [tampered, later, "", "v2", `${token}.x`, `v1${token.slice(2)}`, a.token]) {
      expect(v.claimsFor(bad, served(statusCall()), [a.binding])).toBeNull();
    }
    expect(v.claimsFor(token, served(statusCall()), [{ ...a.binding, tunnelKey: "x" }])).toBe(null);
  });

  test("rotation: during the overlap both credentials mint good tokens; then only the new one", () => {
    const old = bind("svc-a");
    const next = bind("svc-a");
    const v = verifier();
    const overlap = [old.binding, next.binding];
    for (const credential of [old.token, next.token]) {
      const token = mintServiceToken(credential, statusCall(), { now: NOW });
      expect(v.claimsFor(token, served(statusCall()), overlap)?.serviceId).toBe("svc-a");
    }
    const rotated = [next.binding];
    const stale = mintServiceToken(old.token, statusCall(), { now: NOW });
    expect(v.claimsFor(stale, served(statusCall()), rotated)).toBeNull();
    const current = mintServiceToken(next.token, statusCall(), { now: NOW });
    expect(v.claimsFor(current, served(statusCall()), rotated)?.serviceId).toBe("svc-a");
  });

  test("held nonces are bounded: each is dropped once its retention passes", () => {
    const a = bind("svc-a");
    const clock = { now: NOW, mono: 0 };
    const v = createServiceTokenVerifier({
      node: NODE,
      now: () => clock.now,
      monotonicNow: () => clock.mono,
    });
    for (let i = 0; i < 50; i++) {
      const call = statusCall(`att-${String(i)}`);
      expect(
        v.claimsFor(mintServiceToken(a.token, call, { now: NOW }), served(call), [a.binding]),
      ).not.toBeNull();
    }
    expect(v.heldNonces()).toBe(50);
    clock.now += authModule.SERVICE_TOKEN_NONCE_RETENTION_MS + 1_000;
    clock.mono += authModule.SERVICE_TOKEN_NONCE_RETENTION_MS + 1_000;
    const call = statusCall("att-late");
    const late = mintServiceToken(a.token, call, { now: clock.now });
    expect(v.claimsFor(late, served(call), [a.binding])).not.toBeNull();
    expect(v.heldNonces()).toBe(1);
  });
});

/**
 * P4.1 (#139) X5, second review — a tunnel token is keyed by a per-worker
 * key, HMAC-SHA256(credential, "llamactl-worker-rpc-token\0" + node), that
 * the worker keeps as its binding's `tunnelKey`. The binding's `tokenHash`
 * keys nothing: whoever reads one worker's agent.yaml can mint tokens for
 * that worker at most.
 */
describe("per-worker tunnel keys", () => {
  const RELAY = relayPrincipalOf("relay-bearer-R");
  const NOW = 1_800_000_000_000;
  const claims: inferenceRpc.InferenceServiceClaimsV1 = {
    serviceId: "sirius",
    operations: ["negotiate", "catalog", "submit", "stream", "status", "cancel"],
    deployments: ["d"],
    models: [],
    tenants: ["t"],
    credentialScopeId: "c",
  };
  const credential = generateToken();
  const bindingFor = (node: string): ServiceCredentialBinding => ({
    ...claims,
    tokenHash: credential.hash,
    tunnelKey: tunnelKeyOf(credential.token, node),
  });
  const submitCall = (node: string): ServiceTokenCall => ({
    node,
    method: "inferenceRpc.submit",
    input: { envelope: { attemptId: "att-x" } },
    relayPrincipal: RELAY,
  });
  const served = ({ node: _node, ...rest }: ServiceTokenCall): Omit<ServiceTokenCall, "node"> =>
    rest;

  /** The first token format, keyed by whatever key it is given (the review's repro). */
  function firstFormatToken(key: Buffer, call: ServiceTokenCall): string {
    const expiresAt = Date.now() + 60_000;
    const nonce = randomBytes(18).toString("base64url");
    const subject = "att-x";
    const digest = createHash("sha256").update(JSON.stringify(call.input)).digest("base64url");
    const bound = [
      "llamactl-worker-rpc-service-token",
      "v1",
      call.node,
      call.method,
      subject,
      digest,
      call.relayPrincipal,
      expiresAt,
      nonce,
    ];
    const mac = createHmac("sha256", key).update(JSON.stringify(bound)).digest();
    return [
      "v1",
      String(expiresAt),
      nonce,
      Buffer.from(subject).toString("base64url"),
      mac.toString("base64url"),
    ].join(".");
  }

  test("the stored tokenHash alone mints nothing any worker accepts", () => {
    const hashKey = Buffer.from(credential.hash, "hex");
    for (const node of ["gpu-1", "gpu-2", "gpu-3"]) {
      const v = createServiceTokenVerifier({ node });
      const call = submitCall(node);
      const binding = bindingFor(node);
      expect(v.claimsFor(firstFormatToken(hashKey, call), served(call), [binding])).toBeNull();
      const current = authModule.mintServiceTokenWithKey(hashKey, call);
      expect(v.claimsFor(current, served(call), [binding])).toBeNull();
      // The credential itself still mints for every worker it is bound on.
      const genuine = mintServiceToken(credential.token, call);
      expect(v.claimsFor(genuine, served(call), [binding])?.serviceId).toBe("sirius");
    }
  });

  test("a leaked tunnelKey mints for its own worker only", () => {
    const leaked = Buffer.from(tunnelKeyOf(credential.token, "gpu-1"), "hex");
    const gpu2 = createServiceTokenVerifier({ node: "gpu-2" });
    const forGpu2 = authModule.mintServiceTokenWithKey(leaked, submitCall("gpu-2"));
    expect(gpu2.claimsFor(forGpu2, served(submitCall("gpu-2")), [bindingFor("gpu-2")])).toBeNull();
    const gpu1 = createServiceTokenVerifier({ node: "gpu-1" });
    const forGpu1 = authModule.mintServiceTokenWithKey(leaked, submitCall("gpu-1"));
    expect(
      gpu1.claimsFor(forGpu1, served(submitCall("gpu-1")), [bindingFor("gpu-1")])?.serviceId,
    ).toBe("sirius");
  });

  test("a binding without a tunnelKey refuses tunnel tokens; its credential still verifies directly", () => {
    const v = createServiceTokenVerifier({ node: "gpu-1" });
    const { tunnelKey: _key, ...hashOnly } = bindingFor("gpu-1");
    const token = mintServiceToken(credential.token, submitCall("gpu-1"));
    expect(v.claimsFor(token, served(submitCall("gpu-1")), [hashOnly])).toBeNull();
    expect(claimsForServiceCredential(credential.token, [hashOnly])?.serviceId).toBe("sirius");
  });

  test("claims never carry the binding's hash or key", () => {
    const v = createServiceTokenVerifier({ node: "gpu-1" });
    const token = mintServiceToken(credential.token, submitCall("gpu-1"));
    const fromToken = v.claimsFor(token, served(submitCall("gpu-1")), [bindingFor("gpu-1")]);
    const direct = claimsForServiceCredential(credential.token, [bindingFor("gpu-1")]);
    expect(fromToken).toEqual(claims);
    expect(direct).toEqual(claims);
  });

  test("the documented derivation is the one the worker checks", () => {
    expect(authModule.serviceTunnelKey(credential.token, "gpu-1")).toBe(
      tunnelKeyOf(credential.token, "gpu-1"),
    );
  });

  test("a wall-clock step back after the sweep does not re-admit a spent token", () => {
    const clock = { now: NOW, mono: 5_000 };
    const v = createServiceTokenVerifier({
      node: "gpu-1",
      now: () => clock.now,
      monotonicNow: () => clock.mono,
    });
    const binding = bindingFor("gpu-1");
    const cancel: ServiceTokenCall = {
      node: "gpu-1",
      method: "inferenceRpc.cancel",
      input: { attemptId: "att-c" },
      relayPrincipal: RELAY,
    };
    const spent = mintServiceToken(credential.token, cancel, { now: clock.now });
    expect(v.claimsFor(spent, served(cancel), [binding])).not.toBeNull();
    // Past its expiry, another token makes the verifier sweep.
    clock.now += 61_000;
    clock.mono += 61_000;
    const status: ServiceTokenCall = {
      ...cancel,
      method: "inferenceRpc.status",
      input: { attemptId: "a2" },
    };
    expect(
      v.claimsFor(mintServiceToken(credential.token, status, { now: clock.now }), served(status), [
        binding,
      ]),
    ).not.toBeNull();
    // NTP steps the wall clock back two minutes.
    clock.now -= 120_000;
    clock.mono += 10;
    expect(v.claimsFor(spent, served(cancel), [binding])).toBeNull();
  });

  test("every refusal is reported with its reason, never with the token", () => {
    const clock = { now: NOW, mono: 0 };
    const reasons: string[] = [];
    const v = createServiceTokenVerifier({
      node: "gpu-1",
      now: () => clock.now,
      monotonicNow: () => clock.mono,
      onRefused: (reason: string) => reasons.push(reason),
    });
    const binding = bindingFor("gpu-1");
    const call = submitCall("gpu-1");
    const mint = (c: ServiceTokenCall, opts: { now?: number; ttlMs?: number } = {}): string =>
      mintServiceToken(credential.token, c, { now: clock.now, ...opts });
    const good = mint(call);
    expect(v.claimsFor(good, served(call), [binding])).not.toBeNull();
    v.claimsFor(good, served(call), [binding]);
    v.claimsFor(mint(call, { now: clock.now - 120_000 }), served(call), [binding]);
    v.claimsFor(mint(call, { ttlMs: 600_000 }), served(call), [binding]);
    v.claimsFor(mint(submitCall("gpu-2")), served(call), [binding]);
    v.claimsFor(mint(call), served({ ...call, input: { envelope: { attemptId: "att-y" } } }), [
      binding,
    ]);
    v.claimsFor(mint(call), served({ ...call, relayPrincipal: relayPrincipalOf("other") }), [
      binding,
    ]);
    v.claimsFor("v1.not-a-token", served(call), [binding]);
    expect(reasons).toEqual(["replay", "expired", "skew", "node", "subject", "mac", "malformed"]);
  });
});
