import type { inferenceRpc } from "@llamactl/core";

import { describe, expect, test } from "bun:test";

import {
  authenticateServiceCredential,
  claimsForServiceCredential,
  extractBearer,
  generateToken,
  hashToken,
  type ServiceCredentialBinding,
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
