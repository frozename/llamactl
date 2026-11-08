import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type {
  HttpGetFn,
  HttpOptions,
  HttpResponse,
  ManagedHost,
} from "../src/commands/update/deps.js";

import {
  type AgentEndpoint,
  agentHealthy,
  hostBaseUrl,
  hostIdle,
  hostReady,
  negotiateOutcome,
  parseCiState,
  resolveAgentEndpoint,
  urlHost,
} from "../src/commands/update/probes.js";

function r(status: number, body: string): HttpResponse {
  return { status, body };
}

function recorder(answer: (url: string) => HttpResponse | null): {
  get: HttpGetFn;
  calls: { url: string; opts: HttpOptions }[];
} {
  const calls: { url: string; opts: HttpOptions }[] = [];
  const get: HttpGetFn = (url, opts) => {
    calls.push({ url, opts });
    return Promise.resolve(answer(url));
  };
  return { get, calls };
}

const host: ManagedHost = {
  name: "seat",
  kind: "ModelHost",
  pid: 1,
  host: "127.0.0.1",
  port: 8080,
};
const ep: AgentEndpoint = { url: "https://127.0.0.1:7843", source: "test" };

describe("urlHost and hostBaseUrl", () => {
  test("wildcard hosts resolve to 127.0.0.1", () => {
    expect(urlHost("0.0.0.0")).toBe("127.0.0.1");
    expect(urlHost("")).toBe("127.0.0.1");
    expect(urlHost("::")).toBe("127.0.0.1");
    expect(urlHost("[::]")).toBe("127.0.0.1");
  });

  test("IPv6 without brackets gets bracketed", () => {
    expect(urlHost("::1")).toBe("[::1]");
  });

  test("already-bracketed IPv6 stays as-is", () => {
    expect(urlHost("[fe80::1]")).toBe("[fe80::1]");
  });

  test("regular IPv4 passes through", () => {
    expect(urlHost("10.0.0.2")).toBe("10.0.0.2");
  });

  test("hostBaseUrl brackets wildcard and IPv6 hosts", () => {
    expect(hostBaseUrl({ ...host, host: "::1", port: 9000 })).toBe("http://[::1]:9000");
    expect(hostBaseUrl({ ...host, host: "0.0.0.0", port: 8080 })).toBe("http://127.0.0.1:8080");
  });
});

describe("agentHealthy", () => {
  test("200 with 'ok' body returns true and records the call", async () => {
    const rec = recorder(() => r(200, "ok\n"));
    const result = await agentHealthy(rec.get, ep);
    expect(result).toBe(true);
    expect(rec.calls).toStrictEqual([
      {
        url: "https://127.0.0.1:7843/healthz",
        opts: { timeoutMs: 3000, insecureTls: true },
      },
    ]);
  });

  test("503 with 'ok' body returns false", async () => {
    const rec = recorder(() => r(503, "ok"));
    const result = await agentHealthy(rec.get, ep);
    expect(result).toBe(false);
  });

  test("200 with 'okay' body returns false", async () => {
    const rec = recorder(() => r(200, "okay"));
    const result = await agentHealthy(rec.get, ep);
    expect(result).toBe(false);
  });

  test("null answer returns false", async () => {
    const rec = recorder(() => null);
    const result = await agentHealthy(rec.get, ep);
    expect(result).toBe(false);
  });
});

describe("negotiateOutcome", () => {
  test("200 with outcome returns the parsed value", async () => {
    const rec = recorder(() => r(200, '{"result":{"data":{"outcome":"not-advertised"}}}'));
    const result = await negotiateOutcome(rec.get, ep);
    expect(result).toBe("not-advertised");

    const [call] = rec.calls;
    expect(rec.calls).toHaveLength(1);
    const u = new URL(call!.url);
    expect(u.pathname).toBe("/trpc/inferenceRpc.negotiate");
    expect(JSON.parse(u.searchParams.get("input") ?? "")).toStrictEqual({
      versions: [{ major: 1, minor: 0 }],
    });
    expect(call!.opts).toStrictEqual({ timeoutMs: 3000, insecureTls: true });
  });

  test("200 without outcome returns null", async () => {
    const rec = recorder(() => r(200, '{"result":{"data":{}}}'));
    const result = await negotiateOutcome(rec.get, ep);
    expect(result).toBe(null);
  });

  test("null answer returns null", async () => {
    const rec = recorder(() => null);
    const result = await negotiateOutcome(rec.get, ep);
    expect(result).toBe(null);
  });
});

describe("hostReady", () => {
  test("200 with non-empty data array returns true", async () => {
    const rec = recorder(() => r(200, '{"data":[{"id":"m"}]}'));
    const result = await hostReady(rec.get, host);
    expect(result).toBe(true);
    expect(rec.calls).toStrictEqual([
      {
        url: "http://127.0.0.1:8080/v1/models",
        opts: { timeoutMs: 3000 },
      },
    ]);
  });

  test("200 with empty data array returns false", async () => {
    const rec = recorder(() => r(200, '{"data":[]}'));
    const result = await hostReady(rec.get, host);
    expect(result).toBe(false);
  });

  test("200 with non-array data returns false", async () => {
    const rec = recorder(() => r(200, '{"data":"m"}'));
    const result = await hostReady(rec.get, host);
    expect(result).toBe(false);
  });

  test("200 with invalid JSON returns false", async () => {
    const rec = recorder(() => r(200, "not json"));
    const result = await hostReady(rec.get, host);
    expect(result).toBe(false);
  });

  test("503 returns false", async () => {
    const rec = recorder(() => r(503, '{"data":[{"id":"m"}]}'));
    const result = await hostReady(rec.get, host);
    expect(result).toBe(false);
  });

  test("null answer returns false", async () => {
    const rec = recorder(() => null);
    const result = await hostReady(rec.get, host);
    expect(result).toBe(false);
  });
});

describe("hostIdle", () => {
  test("metrics returns idle, result is 'idle'", async () => {
    const rec = recorder((url: string) => {
      if (url.endsWith("/metrics")) return r(200, '{"live":{"state":"idle","queued":0}}');
      return r(200, '[{"is_processing":true}]');
    });
    const result = await hostIdle(rec.get, host);
    expect(result).toBe("idle");
    expect(rec.calls.map((c) => c.url)).toStrictEqual(["http://127.0.0.1:8080/metrics"]);
  });

  test("metrics returns decoding, result is 'busy'", async () => {
    const rec = recorder((url: string) => {
      if (url.endsWith("/metrics")) return r(200, '{"live":{"state":"decoding","queued":0}}');
      return r(200, '[{"is_processing":false}]');
    });
    const result = await hostIdle(rec.get, host);
    expect(result).toBe("busy");
    expect(rec.calls.map((c) => c.url)).toStrictEqual(["http://127.0.0.1:8080/metrics"]);
  });

  test("metrics returns 404, falls through to /slots", async () => {
    const rec = recorder((url: string) => {
      if (url.endsWith("/metrics")) return r(404, "");
      return r(200, '[{"is_processing":true}]');
    });
    const result = await hostIdle(rec.get, host);
    expect(result).toBe("busy");
    expect(rec.calls.map((c) => c.url)).toStrictEqual([
      "http://127.0.0.1:8080/metrics",
      "http://127.0.0.1:8080/slots",
    ]);
  });

  test("metrics returns prometheus format, /slots returns 501, result is 'busy'", async () => {
    const rec = recorder((url: string) => {
      if (url.endsWith("/metrics"))
        return r(200, "llamacpp:requests_processing 0\nllamacpp:requests_deferred 2\n");
      return r(501, "");
    });
    const result = await hostIdle(rec.get, host);
    expect(result).toBe("busy");
    expect(rec.calls.map((c) => c.url)).toStrictEqual([
      "http://127.0.0.1:8080/metrics",
      "http://127.0.0.1:8080/slots",
    ]);
  });

  test("metrics returns idle with null queued, result is 'idle'", async () => {
    const rec = recorder(() => r(200, '{"live":{"state":"idle","queued":null}}'));
    const result = await hostIdle(rec.get, host);
    expect(result).toBe("idle");
  });

  test("two-call cases have timeoutMs in opts", async () => {
    const rec = recorder((url: string) => {
      if (url.endsWith("/metrics")) return r(404, "");
      return r(200, '[{"is_processing":true}]');
    });
    await hostIdle(rec.get, host);
    const multiCallRecs = rec.calls.filter((c) => c.url.includes("/slots"));
    expect(multiCallRecs.length).toBeGreaterThanOrEqual(1);
    expect(rec.calls.map((c) => c.opts)).toStrictEqual([{ timeoutMs: 3000 }, { timeoutMs: 3000 }]);
  });
});

describe("parseCiState", () => {
  test("queued status returns 'pending'", () => {
    expect(parseCiState('[{"status":"queued"}]')).toBe("pending");
  });

  test("first completed run with 'cancelled' conclusion returns 'cancelled'", () => {
    expect(
      parseCiState(
        '[{"status":"completed","conclusion":"cancelled"},{"status":"completed","conclusion":"success"}]',
      ),
    ).toBe("cancelled");
  });
});

describe("resolveAgentEndpoint", () => {
  test("override null with argv dir and host uses agent.yaml port", () => {
    const files = new Map([["/a/agent.yaml", "bindHost: 10.0.0.9\nport: 9443\n"]]);
    const readFile = (p: string): string | null => files.get(p) ?? null;
    const result = resolveAgentEndpoint({
      override: null,
      argv: ["--dir=/a", "--host=10.0.0.5"],
      env: {},
      readFile,
    });
    expect(result).toStrictEqual({
      url: "https://10.0.0.5:9443",
      source: join("/a", "agent.yaml"),
    });
  });

  test("argv --port= and the --bind= alias override agent.yaml bindHost and port", () => {
    const files = new Map([["/a/agent.yaml", "bindHost: 10.0.0.9\nport: 9443\n"]]);
    const readFile = (p: string): string | null => files.get(p) ?? null;
    const result = resolveAgentEndpoint({
      override: null,
      argv: ["--dir=/a", "--bind=10.0.0.7", "--port=9555"],
      env: {},
      readFile,
    });
    expect(result).toStrictEqual({
      url: "https://10.0.0.7:9555",
      source: join("/a", "agent.yaml"),
    });
  });

  test("space-separated argv flags are ignored, agent.yaml values win", () => {
    const files = new Map([["/a/agent.yaml", "bindHost: 10.0.0.9\nport: 9443\n"]]);
    const readFile = (p: string): string | null => files.get(p) ?? null;
    const result = resolveAgentEndpoint({
      override: null,
      argv: ["--dir=/a", "--port", "9555", "--bind", "::1"],
      env: {},
      readFile,
    });
    expect(result.url).toBe("https://10.0.0.9:9443");
  });

  test("override URL wins over everything", () => {
    const readFile = (_p: string): string | null => null;
    const result = resolveAgentEndpoint({
      override: "https://h:1//",
      argv: [],
      env: {},
      readFile,
    });
    expect(result).toStrictEqual({
      url: "https://h:1",
      source: "LLAMACTL_UPDATE_AGENT_URL",
    });
  });
});
