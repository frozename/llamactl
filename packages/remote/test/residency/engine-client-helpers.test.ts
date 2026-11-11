/**
 * #335 test-only pin: the exported URL and auth helpers of the oMLX
 * native residency client. buildBaseUrl must normalize the wildcard
 * bind host and bracket IPv6 literals; applyAuth must pass through
 * untouched when unauthenticated and must replace (never merge) the
 * Authorization scheme; classifyFetchError must read an aborted signal
 * or a TimeoutError/AbortError as a timeout and everything else as an
 * unreachable network failure.
 *
 * Mutation that kills it: in applyAuth, replace
 * `headers.set("Authorization", ...)` with `headers.append(...)`; the
 * "replaces an existing Authorization header" test fails.
 */
import { describe, expect, test } from "bun:test";

import { applyAuth, buildBaseUrl, classifyFetchError } from "../../src/residency/engine-client.js";

describe("buildBaseUrl", () => {
  test("normalizes the 0.0.0.0 wildcard bind to loopback", () => {
    expect(buildBaseUrl("0.0.0.0", 8080)).toBe("http://127.0.0.1:8080");
  });

  test("wraps bare IPv6 literals in brackets", () => {
    expect(buildBaseUrl("::1", 5000)).toBe("http://[::1]:5000");
    expect(buildBaseUrl("fe80::1", 1234)).toBe("http://[fe80::1]:1234");
  });

  test("leaves an already-bracketed IPv6 host untouched", () => {
    expect(buildBaseUrl("[::1]", 5000)).toBe("http://[::1]:5000");
  });

  test("passes hostnames through with the port appended", () => {
    expect(buildBaseUrl("localhost", 8081)).toBe("http://localhost:8081");
    expect(buildBaseUrl("10.0.0.7", 1)).toBe("http://10.0.0.7:1");
  });
});

describe("applyAuth", () => {
  test("returns the exact init object when no api key is configured", () => {
    const init: RequestInit = { method: "GET" };
    expect(applyAuth(undefined, init)).toBe(init);
  });

  test("sets a bearer Authorization header and keeps the other fields", () => {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
    };
    const signed = applyAuth("secret-key", init);
    expect(signed).not.toBe(init);
    expect(signed.method).toBe("POST");
    const headers = new Headers(signed.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-key");
    expect(headers.get("content-type")).toBe("application/json");
  });

  test("replaces an existing Authorization header instead of appending", () => {
    const init: RequestInit = { headers: { Authorization: "Basic stale" } };
    const headers = new Headers(applyAuth("fresh", init).headers);
    expect(headers.get("authorization")).toBe("Bearer fresh");
  });

  test("does not mutate the caller's headers object", () => {
    const headers = new Headers();
    applyAuth("key", { headers });
    expect(headers.get("authorization")).toBeNull();
  });
});

describe("classifyFetchError", () => {
  test("an aborted signal classifies as Timeout even for a plain error", () => {
    const controller = new AbortController();
    controller.abort();
    expect(classifyFetchError(controller.signal, new Error("boom"))).toBe("Timeout");
  });

  test("a TimeoutError on a live signal classifies as Timeout", () => {
    const signal = new AbortController().signal;
    const err = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    expect(classifyFetchError(signal, err)).toBe("Timeout");
  });

  test("an AbortError on a live signal classifies as Timeout", () => {
    const signal = new AbortController().signal;
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyFetchError(signal, err)).toBe("Timeout");
  });

  test("a generic error on a live signal classifies as Unreachable", () => {
    const signal = new AbortController().signal;
    expect(classifyFetchError(signal, new Error("ECONNREFUSED"))).toBe("Unreachable");
  });

  test("non-object throwables and non-string names classify as Unreachable", () => {
    const signal = new AbortController().signal;
    expect(classifyFetchError(signal, "socket hang up")).toBe("Unreachable");
    expect(classifyFetchError(signal, { name: 42 })).toBe("Unreachable");
  });
});
