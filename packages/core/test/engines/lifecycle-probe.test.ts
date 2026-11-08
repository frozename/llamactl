import { describe, expect, test } from "bun:test";

import type { ModelHostReadiness } from "../../src/engines/types.js";

import * as lifecycleModule from "../../src/engines/lifecycle.js";
import { formatHostForUrl, pollUntilModelIds } from "../../src/engines/lifecycle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchStub = (input: Request | URL | string, init?: RequestInit) => Promise<Response>;

type RouteHandler = (url: string) => Response;

function makeStub(): {
  stub: FetchStub;
  calls: string[];
  setRoutes: (routes: Record<string, RouteHandler>) => void;
} {
  const calls: string[] = [];
  let routes: Record<string, RouteHandler> = {};

  const stub: FetchStub = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const urlObj = new URL(url);
    const lookupKey = urlObj.pathname + urlObj.search;
    const handler = routes[lookupKey];
    if (handler) return Promise.resolve(handler(url));
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  return {
    stub,
    calls,
    setRoutes(r: Record<string, RouteHandler>): void {
      routes = r;
    },
  };
}

// ---------------------------------------------------------------------------
// formatHostForUrl
// ---------------------------------------------------------------------------

describe("formatHostForUrl", () => {
  test("an already-bracketed IPv6 literal is returned unchanged", () => {
    expect(formatHostForUrl("[::1]")).toBe("[::1]");
  });
});

// ---------------------------------------------------------------------------
// pollUntilModelIds — /v1/models parsing
// ---------------------------------------------------------------------------

describe("pollUntilModelIds /v1/models parsing", () => {
  test("the /v1/models request URL brackets an IPv6 host", async () => {
    const { stub, calls, setRoutes } = makeStub();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;

    try {
      setRoutes({
        "/v1/models": () => Response.json({ object: "list", data: [{ id: "m" }] }),
      });
      const result = await pollUntilModelIds({ host: "::1", port: 18080 }, 2000);
      expect(calls[0]).toBe("http://[::1]:18080/v1/models");
      expect(result.ready).toBe(true);
      expect(result.modelIds).toEqual(["m"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("entries whose id is missing or empty are dropped", async () => {
    const { stub, calls, setRoutes } = makeStub();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;

    try {
      setRoutes({
        "/v1/models": () =>
          Response.json({
            object: "list",
            data: [{}, { id: "" }, { id: "m" }],
          }),
      });
      const result = await pollUntilModelIds({ host: "127.0.0.1", port: 18080 }, 2000);
      expect(result.ready).toBe(true);
      expect(result.modelIds).toEqual(["m"]);
      expect(calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a listing with only id-less entries is not ready", async () => {
    const { stub, calls, setRoutes } = makeStub();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;

    try {
      setRoutes({
        "/v1/models": () => Response.json({ object: "list", data: [{ object: "model" }] }),
      });
      const result = await pollUntilModelIds({ host: "127.0.0.1", port: 18080 }, 150);
      expect(result.ready).toBe(false);
      expect(result.modelIds).toEqual([]);
      expect(calls.some((c) => c.includes("/v1/models"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a non-2xx /v1/models response is not ready even when its body lists models", async () => {
    const { stub, calls, setRoutes } = makeStub();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;

    try {
      setRoutes({
        "/v1/models": () => Response.json({ object: "list", data: [{ id: "m" }] }, { status: 503 }),
      });
      const result = await pollUntilModelIds({ host: "127.0.0.1", port: 18080 }, 150);
      expect(result.ready).toBe(false);
      expect(result.modelIds).toEqual([]);
      expect(calls.some((c) => c.includes("/v1/models"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a rejected /v1/models fetch is retried, not fatal", async () => {
    let attempt = 0;
    const { calls } = makeStub();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = ((input: Request | URL | string) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      attempt++;
      if (attempt === 1) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      return Promise.resolve(Response.json({ object: "list", data: [{ id: "m" }] }));
    }) as unknown as typeof fetch;

    try {
      const result = await pollUntilModelIds({ host: "127.0.0.1", port: 18080 }, 2000);
      expect(result.ready).toBe(true);
      expect(result.modelIds).toEqual(["m"]);
      const modelCalls = calls.filter((c) => c.includes("/v1/models"));
      expect(modelCalls.length).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// pollUntilModelIds — readiness gate
// ---------------------------------------------------------------------------

describe("pollUntilModelIds readiness gate", () => {
  test("readiness is not fetched while /v1/models lists no ids", async () => {
    const { stub, calls, setRoutes } = makeStub();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;

    try {
      setRoutes({
        "/v1/models": () => Response.json({ object: "list", data: [] }),
        "/ready": () => Response.json({ status: "ready" }),
      });
      const result = await pollUntilModelIds({ host: "127.0.0.1", port: 18080 }, 150, {
        path: "/ready",
      });
      expect(result.ready).toBe(false);
      expect(result.modelIds).toEqual([]);
      expect(calls.every((c) => !c.endsWith("/ready"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the readiness URL is formatted host + port + readiness.path verbatim", async () => {
    const { stub, calls, setRoutes } = makeStub();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;

    try {
      setRoutes({
        "/v1/models": () => Response.json({ object: "list", data: [{ id: "m" }] }),
        "/health?full=1": () => Response.json({ status: "ready" }),
      });
      const readiness: ModelHostReadiness = { path: "/health?full=1" };
      const result = await pollUntilModelIds({ host: "127.0.0.1", port: 18080 }, 2000, readiness);
      expect(result.ready).toBe(true);
      expect(calls).toContain("http://127.0.0.1:18080/health?full=1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("with expectStatus omitted, a 200 readiness response passes and the body is not parsed", async () => {
    const { stub, calls, setRoutes } = makeStub();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;

    try {
      setRoutes({
        "/v1/models": () => Response.json({ object: "list", data: [{ id: "m" }] }),
        "/health": () => new Response("OK", { status: 200 }),
      });
      const readiness: ModelHostReadiness = { path: "/health" };
      const result = await pollUntilModelIds({ host: "127.0.0.1", port: 18080 }, 2000, readiness);
      expect(result.ready).toBe(true);
      expect(calls.some((c) => c.endsWith("/health"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("with expectStatus omitted, the default is exactly 200, not any 2xx", async () => {
    const { stub, calls, setRoutes } = makeStub();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;

    try {
      setRoutes({
        "/v1/models": () => Response.json({ object: "list", data: [{ id: "m" }] }),
        "/health": () => new Response(null, { status: 204 }),
      });
      const readiness: ModelHostReadiness = { path: "/health" };
      const result = await pollUntilModelIds({ host: "127.0.0.1", port: 18080 }, 150, readiness);
      expect(result.ready).toBe(false);
      expect(calls.some((c) => c.endsWith("/health"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("an explicit expectStatus is matched exactly", async () => {
    const { stub, calls, setRoutes } = makeStub();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;

    try {
      setRoutes({
        "/v1/models": () => Response.json({ object: "list", data: [{ id: "m" }] }),
        "/health": () => new Response("ok", { status: 200 }),
      });
      const readiness: ModelHostReadiness = { path: "/health", expectStatus: 204 };
      const result = await pollUntilModelIds({ host: "127.0.0.1", port: 18080 }, 150, readiness);
      expect(result.ready).toBe(false);
      expect(calls.some((c) => c.endsWith("/health"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("expectJson rejects a JSON array body even when an index key matches", async () => {
    const { stub, calls, setRoutes } = makeStub();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;

    try {
      setRoutes({
        "/v1/models": () => Response.json({ object: "list", data: [{ id: "m" }] }),
        "/ready": () => Response.json(["ready"]),
      });
      const readiness: ModelHostReadiness = {
        path: "/ready",
        expectJson: { "0": "ready" },
      };
      const result = await pollUntilModelIds({ host: "127.0.0.1", port: 18080 }, 150, readiness);
      expect(result.ready).toBe(false);
      expect(calls.some((c) => c.endsWith("/ready"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("expectJson compares with strict equality", async () => {
    const { stub, calls, setRoutes } = makeStub();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;

    try {
      setRoutes({
        "/v1/models": () => Response.json({ object: "list", data: [{ id: "m" }] }),
        "/ready": () => Response.json({ replicas: "1" }),
      });
      const readiness: ModelHostReadiness = {
        path: "/ready",
        expectJson: { replicas: 1 },
      };
      const result = await pollUntilModelIds({ host: "127.0.0.1", port: 18080 }, 150, readiness);
      expect(result.ready).toBe(false);
      expect(calls.some((c) => c.endsWith("/ready"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("expectJson requires every key", async () => {
    const { stub, calls, setRoutes } = makeStub();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;

    try {
      setRoutes({
        "/v1/models": () => Response.json({ object: "list", data: [{ id: "m" }] }),
        "/ready": () => Response.json({ status: "ready" }),
      });
      const readiness: ModelHostReadiness = {
        path: "/ready",
        expectJson: { status: "ready", model: "m" },
      };
      const result = await pollUntilModelIds({ host: "127.0.0.1", port: 18080 }, 150, readiness);
      expect(result.ready).toBe(false);
      expect(calls.some((c) => c.endsWith("/ready"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a non-JSON readiness body with expectJson set is not ready, resolves rather than rejects", async () => {
    const { stub, calls, setRoutes } = makeStub();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;

    try {
      setRoutes({
        "/v1/models": () => Response.json({ object: "list", data: [{ id: "m" }] }),
        "/ready": () => new Response("warming", { status: 200 }),
      });
      const readiness: ModelHostReadiness = {
        path: "/ready",
        expectJson: { status: "ready" },
      };
      const result = await pollUntilModelIds({ host: "127.0.0.1", port: 18080 }, 150, readiness);
      expect(result).toEqual({ ready: false, modelIds: [] });
      expect(calls.some((c) => c.endsWith("/ready"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// checkServingReadiness — single-shot readiness probe with injectable fetch
// (#220). The export lands with the fix; the namespace lookup keeps these
// cases typechecking before it exists (undefined at runtime on the base
// revision, so the typeof guard fails by assertion first).
// ---------------------------------------------------------------------------

type CheckServingReadinessFn = (
  endpoint: { host: string; port: number },
  readiness: ModelHostReadiness,
  opts?: { fetch?: typeof fetch; timeoutMs?: number },
) => Promise<boolean>;

const requireCheckServingReadiness = (): CheckServingReadinessFn => {
  const fn = (lifecycleModule as unknown as Record<string, unknown>)[
    "checkServingReadiness"
  ] as CheckServingReadinessFn;
  expect(typeof fn).toBe("function");
  return fn;
};

const installFetchTripwire = (): { calls: string[]; restore: () => void } => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const tripwire: FetchStub = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return Promise.reject(new Error("globalThis.fetch must not be used"));
  };
  globalThis.fetch = tripwire as unknown as typeof fetch;
  return {
    calls,
    restore: (): void => {
      globalThis.fetch = originalFetch;
    },
  };
};

describe("checkServingReadiness (single-shot, injectable fetch)", () => {
  test("a 503 readiness response is not ready", async () => {
    const check = requireCheckServingReadiness();
    const { stub, setRoutes } = makeStub();
    const tripwire = installFetchTripwire();
    try {
      setRoutes({
        "/ready": () => Response.json({ status: "loading" }, { status: 503 }),
      });
      const result = await check(
        { host: "127.0.0.1", port: 18080 },
        { path: "/ready", expectJson: { status: "ready" } },
        { fetch: stub as unknown as typeof fetch },
      );
      expect(result).toBe(false);
      expect(tripwire.calls).toEqual([]);
    } finally {
      tripwire.restore();
    }
  });

  test("a 200 readiness body matching expectJson is ready", async () => {
    const check = requireCheckServingReadiness();
    const { stub, setRoutes } = makeStub();
    const tripwire = installFetchTripwire();
    try {
      setRoutes({
        "/ready": () => Response.json({ status: "ready", model: "m" }),
      });
      const result = await check(
        { host: "127.0.0.1", port: 18080 },
        { path: "/ready", expectJson: { status: "ready" } },
        { fetch: stub as unknown as typeof fetch },
      );
      expect(result).toBe(true);
      expect(tripwire.calls).toEqual([]);
    } finally {
      tripwire.restore();
    }
  });

  test("a 200 readiness body that misses expectJson is not ready", async () => {
    const check = requireCheckServingReadiness();
    const { stub, setRoutes } = makeStub();
    const tripwire = installFetchTripwire();
    try {
      setRoutes({
        "/ready": () => Response.json({ status: "loading" }),
      });
      const result = await check(
        { host: "127.0.0.1", port: 18080 },
        { path: "/ready", expectJson: { status: "ready" } },
        { fetch: stub as unknown as typeof fetch },
      );
      expect(result).toBe(false);
      expect(tripwire.calls).toEqual([]);
    } finally {
      tripwire.restore();
    }
  });

  test("a non-JSON readiness body with expectJson set resolves false", async () => {
    const check = requireCheckServingReadiness();
    const { stub, setRoutes } = makeStub();
    const tripwire = installFetchTripwire();
    try {
      setRoutes({
        "/ready": () => new Response("warming", { status: 200 }),
      });
      const result = await check(
        { host: "127.0.0.1", port: 18080 },
        { path: "/ready", expectJson: { status: "ready" } },
        { fetch: stub as unknown as typeof fetch },
      );
      expect(result).toBe(false);
      expect(tripwire.calls).toEqual([]);
    } finally {
      tripwire.restore();
    }
  });

  test("a rejected injected fetch resolves false", async () => {
    const check = requireCheckServingReadiness();
    const tripwire = installFetchTripwire();
    const rejectingFetch: FetchStub = () => Promise.reject(new TypeError("fetch failed"));
    try {
      const result = await check(
        { host: "127.0.0.1", port: 18080 },
        { path: "/ready", expectJson: { status: "ready" } },
        { fetch: rejectingFetch as unknown as typeof fetch },
      );
      expect(result).toBe(false);
      expect(tripwire.calls).toEqual([]);
    } finally {
      tripwire.restore();
    }
  });

  test("a fetch that only settles on abort is bounded by timeoutMs", async () => {
    const check = requireCheckServingReadiness();
    const tripwire = installFetchTripwire();
    const hangingFetch = ((_input: Request | URL | string, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal ?? null;
        if (signal === null) return;
        if (signal.aborted) {
          reject(new Error("The operation was aborted."));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            reject(new Error("The operation timed out."));
          },
          { once: true },
        );
      })) as unknown as typeof fetch;
    try {
      const start = Date.now();
      const result = await check(
        { host: "127.0.0.1", port: 18080 },
        { path: "/ready", expectJson: { status: "ready" } },
        { fetch: hangingFetch, timeoutMs: 50 },
      );
      expect(result).toBe(false);
      expect(Date.now() - start).toBeLessThan(1000);
      expect(tripwire.calls).toEqual([]);
    } finally {
      tripwire.restore();
    }
  });

  test("the probe URL brackets an IPv6 host and keeps the readiness path verbatim", async () => {
    const check = requireCheckServingReadiness();
    const { stub, calls, setRoutes } = makeStub();
    const tripwire = installFetchTripwire();
    try {
      setRoutes({
        "/ready?x=1": () => Response.json({ status: "ready" }),
      });
      const result = await check(
        { host: "::1", port: 18080 },
        { path: "/ready?x=1", expectJson: { status: "ready" } },
        { fetch: stub as unknown as typeof fetch },
      );
      expect(result).toBe(true);
      expect(calls).toEqual(["http://[::1]:18080/ready?x=1"]);
      expect(tripwire.calls).toEqual([]);
    } finally {
      tripwire.restore();
    }
  });

  test("expectStatus is matched exactly", async () => {
    const check = requireCheckServingReadiness();
    const { stub, setRoutes } = makeStub();
    const tripwire = installFetchTripwire();
    try {
      let status = 204;
      setRoutes({
        "/health": (): Response =>
          status === 204
            ? new Response(null, { status: 204 })
            : new Response("ok", { status: 200 }),
      });
      const readiness: ModelHostReadiness = { path: "/health", expectStatus: 204 };
      const endpoint = { host: "127.0.0.1", port: 18080 };
      const fetchOpt = { fetch: stub as unknown as typeof fetch };
      expect(await check(endpoint, readiness, fetchOpt)).toBe(true);
      status = 200;
      expect(await check(endpoint, readiness, fetchOpt)).toBe(false);
      expect(tripwire.calls).toEqual([]);
    } finally {
      tripwire.restore();
    }
  });
});
