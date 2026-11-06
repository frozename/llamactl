/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects/resolves matchers are typed as void. */
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  __resetInsecureTunnelWarning,
  buildRelayFetchInit,
  buildTunnelSend,
  callViaTunnelRelay,
  enforceRelayPinning,
  type FetchLike,
} from "../src/tunnel-relay.js";

// --- fixture helpers ---

interface CapturedCall {
  input: string | URL | Request;
  init: RequestInit | undefined;
}

function buildFakePem(): string {
  const der = Buffer.from("llamactl-test-der");
  const b64 = der.toString("base64");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

function computeExpectedFingerprint(pem: string): string {
  const der = Buffer.from(pem.replaceAll(/-----.*?-----/g, "").replaceAll(/\s+/g, ""), "base64");
  return "sha256:" + createHash("sha256").update(der).digest("hex");
}

function pinnedOpts(
  pem = buildFakePem(),
  fp = computeExpectedFingerprint(pem),
): { pinnedCa: string; expectedFingerprint: string } {
  return { pinnedCa: pem, expectedFingerprint: fp };
}

// --- 1-4: buildRelayFetchInit ---

describe("buildRelayFetchInit", () => {
  beforeEach(() => {
    __resetInsecureTunnelWarning();
  });

  test("returns correct url and init with pinned opts", () => {
    const pem = buildFakePem();
    const { url, init } = buildRelayFetchInit("https://c.example/", "gpu1", {
      ...pinnedOpts(pem),
      method: "catalog.list",
      type: "query",
      input: {},
      bearer: "tok",
    });
    expect(url).toBe("https://c.example/tunnel-relay/gpu1");
    expect(init!.method).toBe("POST");
    expect(init!.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer tok",
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      method: "catalog.list",
      type: "query",
      input: {},
    });
    const tls = (init as { tls?: Record<string, unknown> }).tls;
    expect(tls).toEqual({ ca: pem });
  });

  test("URI-encodes the node name", () => {
    const pem = buildFakePem();
    const { url } = buildRelayFetchInit("https://c.example/", "a b/c", {
      ...pinnedOpts(pem),
      method: "x",
      type: "query",
      input: {},
      bearer: "tok",
    });
    expect(url).toBe("https://c.example/tunnel-relay/a%20b%2Fc");
  });

  test("appends query string when present", () => {
    const pem = buildFakePem();
    let { url } = buildRelayFetchInit(
      "https://c.example/",
      "n",
      { ...pinnedOpts(pem), method: "x", type: "query", input: {}, bearer: "tok" },
      { stream: "1", x: "a b" },
    );
    expect(url).toBe("https://c.example/tunnel-relay/n?stream=1&x=a+b");

    ({ url } = buildRelayFetchInit(
      "https://c.example/",
      "n",
      { ...pinnedOpts(pem), method: "x", type: "query", input: {}, bearer: "tok" },
      {},
    ));
    expect(url).toBe("https://c.example/tunnel-relay/n");

    ({ url } = buildRelayFetchInit(
      "https://c.example/",
      "n",
      { ...pinnedOpts(pem), method: "x", type: "query", input: {}, bearer: "tok" },
      undefined,
    ));
    expect(url).toBe("https://c.example/tunnel-relay/n");
  });

  test("insecure + pinnedCa omits tls; signal is threaded through", () => {
    const pem = buildFakePem();
    const signal = AbortSignal.timeout(5000);
    let { init } = buildRelayFetchInit("https://c.example/", "n", {
      ...pinnedOpts(pem),
      method: "x",
      type: "query",
      input: {},
      bearer: "tok",
      insecure: true,
      signal,
    });
    expect("tls" in (init as object)).toBe(false);
    expect(init!.signal).toBe(signal);

    ({ init } = buildRelayFetchInit("https://c.example/", "n", {
      ...pinnedOpts(pem),
      method: "x",
      type: "query",
      input: {},
      bearer: "tok",
      insecure: true,
    }));
    expect("signal" in (init as object)).toBe(false);
  });
});

// --- 5-8: enforceRelayPinning ---

describe("enforceRelayPinning", () => {
  beforeEach(() => {
    __resetInsecureTunnelWarning();
  });

  test("throws /not a valid cert PEM/ when no markers", () => {
    expect(() => {
      enforceRelayPinning({
        ...pinnedOpts("no-markers-here"),
      });
    }).toThrow("not a valid cert PEM");
  });

  test("throws /fingerprint mismatch/ with both values, no RangeError", () => {
    const pem = buildFakePem();
    expect(() => {
      enforceRelayPinning({ ...pinnedOpts(pem), expectedFingerprint: "sha256:abc" });
    }).toThrow("fingerprint mismatch");
  });

  test("missing pin opts without insecure throws with --insecure-tunnel-relay", () => {
    expect(() => {
      enforceRelayPinning({});
    }).toThrow("--insecure-tunnel-relay");
  });

  test("insecure: true returns without throwing, warns once to stderr", () => {
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);

    enforceRelayPinning({ insecure: true });
    enforceRelayPinning({ insecure: true });

    expect(spy).toHaveBeenCalledTimes(1);
    const callArg = (spy as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0];
    expect(callArg).toBe(
      "WARN: tunnel-relay fingerprint check bypassed (--insecure-tunnel-relay)\n",
    );

    spy.mockRestore();
  });
});

// --- 9-12: callViaTunnelRelay ---

describe("callViaTunnelRelay", () => {
  beforeEach(() => {
    __resetInsecureTunnelWarning();
  });

  test("non-ok response rejects with status + body", async () => {
    const captured: CapturedCall[] = [];
    const fake: FetchLike = (input, init) => {
      captured.push({ input, init });
      return Promise.resolve(new Response("upstream boom", { status: 502 }));
    };
    const pem = buildFakePem();
    await expect(
      callViaTunnelRelay({
        centralUrl: "https://c.example/",
        nodeName: "gpu1",
        method: "x",
        input: {},
        bearer: "tok",
        fetchImpl: fake,
        ...pinnedOpts(pem),
      }),
    ).rejects.toThrow("tunnel-relay 502: upstream boom");
  });

  test("non-ok with empty body uses statusText", async () => {
    const captured: CapturedCall[] = [];
    const fake: FetchLike = (input, init) => {
      captured.push({ input, init });
      return Promise.resolve(new Response("", { status: 503, statusText: "Service Unavailable" }));
    };
    const pem = buildFakePem();
    await expect(
      callViaTunnelRelay({
        centralUrl: "https://c.example/",
        nodeName: "gpu1",
        method: "x",
        input: {},
        bearer: "tok",
        fetchImpl: fake,
        ...pinnedOpts(pem),
      }),
    ).rejects.toThrow("tunnel-relay 503: Service Unavailable");
  });

  test("envelope error rejects with code", async () => {
    const captured: CapturedCall[] = [];
    const fake: FetchLike = (input, init) => {
      captured.push({ input, init });
      return Promise.resolve(
        new Response(
          JSON.stringify({ type: "res", id: "x", error: { code: "E_X", message: "nope" } }),
          { status: 200 },
        ),
      );
    };
    const pem = buildFakePem();
    await expect(
      callViaTunnelRelay({
        centralUrl: "https://c.example/",
        nodeName: "gpu1",
        method: "x",
        input: {},
        bearer: "tok",
        fetchImpl: fake,
        ...pinnedOpts(pem),
      }),
    ).rejects.toThrow("nope");
  });

  test("envelope result resolves", async () => {
    const captured: CapturedCall[] = [];
    const fake: FetchLike = (input, init) => {
      captured.push({ input, init });
      return Promise.resolve(
        new Response(JSON.stringify({ type: "res", id: "x", result: { a: 1 } }), { status: 200 }),
      );
    };
    const pem = buildFakePem();
    const result = await callViaTunnelRelay({
      centralUrl: "https://c.example/",
      nodeName: "gpu1",
      method: "x",
      input: {},
      bearer: "tok",
      fetchImpl: fake,
      ...pinnedOpts(pem),
    });
    expect(result).toEqual({ a: 1 });
  });

  test("type defaults to 'query' when omitted", async () => {
    let capturedBody: unknown;
    const fake: FetchLike = (input, init) => {
      const body = init!.body as string;
      capturedBody = JSON.parse(body);
      return Promise.resolve(
        new Response(JSON.stringify({ type: "res", id: "x", result: null }), { status: 200 }),
      );
    };
    const pem = buildFakePem();
    await callViaTunnelRelay({
      centralUrl: "https://c.example/",
      nodeName: "gpu1",
      method: "x",
      input: {},
      bearer: "tok",
      fetchImpl: fake,
      ...pinnedOpts(pem),
    });
    expect((capturedBody as { type: string }).type).toBe("query");
  });

  test("fetch error is rethrown as-is", async () => {
    const captured: CapturedCall[] = [];
    const fake: FetchLike = (input, init) => {
      captured.push({ input, init });
      return Promise.reject(new Error("socket hang up"));
    };
    const pem = buildFakePem();
    await expect(
      callViaTunnelRelay({
        centralUrl: "https://c.example/",
        nodeName: "gpu1",
        method: "x",
        input: {},
        bearer: "tok",
        fetchImpl: fake,
        ...pinnedOpts(pem),
      }),
    ).rejects.toThrow("socket hang up");
  });
});

// --- 13-16: buildTunnelSend ---

describe("buildTunnelSend", () => {
  beforeEach(() => {
    __resetInsecureTunnelWarning();
  });

  test("on success resolves { id, result }", async () => {
    const captured: CapturedCall[] = [];
    const fake: FetchLike = (input, init) => {
      captured.push({ input, init });
      return Promise.resolve(
        new Response(JSON.stringify({ type: "res", id: "req1", result: { ok: true } }), {
          status: 200,
        }),
      );
    };
    const pem = buildFakePem();
    const send = buildTunnelSend({
      centralUrl: "https://c.example/",
      nodeName: "gpu1",
      bearer: "tok",
      fetchImpl: fake,
      ...pinnedOpts(pem),
    });
    const result = await send({ id: "req1", method: "x", params: {} });
    expect(result).toEqual({ id: "req1", result: { ok: true } });
  });

  test("mutation params appear in the posted body", async () => {
    let capturedBody: unknown;
    const fake: FetchLike = (input, init) => {
      const body = init!.body as string;
      capturedBody = JSON.parse(body);
      return Promise.resolve(
        new Response(JSON.stringify({ type: "res", id: "req2", result: null }), { status: 200 }),
      );
    };
    const pem = buildFakePem();
    const send = buildTunnelSend({
      centralUrl: "https://c.example/",
      nodeName: "gpu1",
      bearer: "tok",
      fetchImpl: fake,
      ...pinnedOpts(pem),
    });
    const result = await send({
      id: "req2",
      method: "catalog.list",
      params: { type: "mutation", input: { k: 1 } },
    });
    expect((capturedBody as { type: string; input: { k: number } }).type).toBe("mutation");
    expect((capturedBody as { input: { k: number } }).input).toEqual({ k: 1 });
  });

  test("fetch throws Error with no code -> error result", async () => {
    const captured: CapturedCall[] = [];
    const fake: FetchLike = (input, init) => {
      captured.push({ input, init });
      return Promise.reject(new Error("socket hang up"));
    };
    const pem = buildFakePem();
    const send = buildTunnelSend({
      centralUrl: "https://c.example/",
      nodeName: "gpu1",
      bearer: "tok",
      fetchImpl: fake,
      ...pinnedOpts(pem),
    });
    const result = await send({ id: "q1", method: "x", params: {} });
    expect(result).toEqual({
      id: "q1",
      error: { code: "tunnel-relay-failed", message: "socket hang up" },
    });
  });

  test("envelope error code is preserved in result", async () => {
    const captured: CapturedCall[] = [];
    const fake: FetchLike = (input, init) => {
      captured.push({ input, init });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: "res",
            id: "q2",
            error: { code: "E_X", message: "nope" },
          }),
          { status: 200 },
        ),
      );
    };
    const pem = buildFakePem();
    const send = buildTunnelSend({
      centralUrl: "https://c.example/",
      nodeName: "gpu1",
      bearer: "tok",
      fetchImpl: fake,
      ...pinnedOpts(pem),
    });
    const result = await send({ id: "q2", method: "x", params: {} });
    expect(result.error).toEqual({ code: "E_X", message: "nope" });
  });

  test("missing pin opts without insecure resolves to error with --insecure-tunnel-relay", async () => {
    const captured: CapturedCall[] = [];
    const fake: FetchLike = (input, init) => {
      captured.push({ input, init });
      return Promise.reject(new Error("boom"));
    };
    const send = buildTunnelSend({
      centralUrl: "https://c.example/",
      nodeName: "gpu1",
      bearer: "tok",
      fetchImpl: fake,
    });
    const result = await send({ id: "q3", method: "x", params: {} });
    expect((result.error as { message: string }).message).toContain("--insecure-tunnel-relay");
  });
});
