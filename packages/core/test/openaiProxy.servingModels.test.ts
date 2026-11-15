import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineName, ModelHostReadiness } from "../src/engines/types.js";
import type { OpenAIModelListResponse } from "../src/openaiProxy.js";
import type { ResolvedEnv } from "../src/types.js";

import { writeModelHostState } from "../src/engines/state.js";
import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

// #220 RED pin: /v1/models must gate ModelHost routes on their declared
// readiness probe. listServingOpenAIModels + SERVING_MODELS_PROBE_TIMEOUT_MS
// land with the fix; the namespace lookups keep this file typechecking on the
// base revision (undefined at runtime, so the typeof guards fail by assertion
// first — never by import or type error).

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

function tempEnv(extra?: Record<string, string>): {
  env: ResolvedEnv;
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-serving-"));
  return {
    env: resolveEnv({
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: dir,
      LLAMA_CPP_MODELS: join(dir, "models"),
      ...extra,
    }),
    dir,
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const PORTS = {
  warming: 18311,
  ready: 18312,
  plain: 18313,
} as const;

function writeModelHost(
  resolved: ResolvedEnv,
  name: string,
  spec: {
    port: number;
    aliases: string[];
    engine?: EngineName;
    readiness?: ModelHostReadiness;
  },
): void {
  writeModelHostState(
    {
      kind: "ModelHost",
      engine: spec.engine ?? "llamacpp",
      pid: process.pid,
      host: "127.0.0.1",
      port: spec.port,
      modelAliases: spec.aliases,
      startedAt: "2026-05-19T00:00:00Z",
      ...(spec.readiness !== undefined ? { readiness: spec.readiness } : {}),
    },
    { name },
    resolved,
  );
}

function writeGateFixtures(resolved: ResolvedEnv): void {
  writeModelHost(resolved, "warming-host", {
    port: PORTS.warming,
    aliases: ["warming-model"],
    readiness: { path: "/ready" },
  });
  writeModelHost(resolved, "ready-host", {
    port: PORTS.ready,
    aliases: ["ready-model"],
    readiness: { path: "/ready", expectJson: { status: "ready" } },
  });
  writeModelHost(resolved, "plain-host", {
    port: PORTS.plain,
    aliases: ["plain-model"],
    engine: "omlx",
  });
}

type ListServingOpenAIModelsFn = (
  resolved: ResolvedEnv,
  opts?: { fetch?: typeof fetch; timeoutMs?: number },
) => Promise<OpenAIModelListResponse>;

const requireListServingOpenAIModels = (): ListServingOpenAIModelsFn => {
  const fn = (openaiProxy as unknown as Record<string, unknown>)[
    "listServingOpenAIModels"
  ] as ListServingOpenAIModelsFn;
  expect(typeof fn).toBe("function");
  return fn;
};

type ServingProbeHandler = (
  url: string,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

const makeProbeStub = (
  handlers: Record<string, ServingProbeHandler>,
): { stub: typeof fetch; calls: string[] } => {
  const calls: string[] = [];
  const stub = ((input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const parsed = new URL(url);
    const handler = handlers[`${parsed.port}${parsed.pathname}`];
    if (handler === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve().then(() => handler(url, init));
  }) as unknown as typeof fetch;
  return { stub, calls };
};

const installFetchTripwire = (): { calls: string[]; restore: () => void } => {
  const calls: string[] = [];
  const previousFetch = globalThis.fetch;
  const tripwire = (input: Request | URL | string): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return Promise.reject(new Error("globalThis.fetch must not be used"));
  };
  globalThis.fetch = tripwire as unknown as typeof fetch;
  return {
    calls,
    restore: (): void => {
      globalThis.fetch = previousFetch;
    },
  };
};

const modelIds = (response: OpenAIModelListResponse): string[] =>
  response.data.map((model) => model.id);

test("listServingOpenAIModels omits hosts whose readiness probe fails", async () => {
  const t = tempEnv();
  const tripwire = installFetchTripwire();
  try {
    writeGateFixtures(t.env);
    const { stub, calls } = makeProbeStub({
      [`${String(PORTS.warming)}/ready`]: () =>
        Response.json({ status: "loading" }, { status: 503 }),
      [`${String(PORTS.ready)}/ready`]: () => Response.json({ status: "ready" }),
    });
    const listServing = requireListServingOpenAIModels();
    const result = await listServing(t.env, { fetch: stub, timeoutMs: 2000 });
    const ids = modelIds(result);
    expect(ids).not.toContain("warming-model");
    expect(ids).toContain("ready-model");
    expect(ids).toContain("plain-model");
    expect(calls.filter((url) => url.includes("/ready"))).toHaveLength(2);
    expect(tripwire.calls).toEqual([]);
  } finally {
    tripwire.restore();
    t.cleanup();
  }
});

test("listServingOpenAIModels lists hosts whose readiness probe passes", async () => {
  const t = tempEnv();
  const tripwire = installFetchTripwire();
  try {
    writeGateFixtures(t.env);
    const { stub } = makeProbeStub({
      [`${String(PORTS.warming)}/ready`]: () => Response.json({ status: "ready" }),
      [`${String(PORTS.ready)}/ready`]: () => Response.json({ status: "ready" }),
    });
    const listServing = requireListServingOpenAIModels();
    const result = await listServing(t.env, { fetch: stub, timeoutMs: 2000 });
    const ids = modelIds(result);
    expect(ids).toContain("warming-model");
    expect(ids).toContain("ready-model");
    expect(ids).toContain("plain-model");
    expect(tripwire.calls).toEqual([]);
  } finally {
    tripwire.restore();
    t.cleanup();
  }
});

test("listServingOpenAIModels probes nothing when no host declares readiness", async () => {
  const t = tempEnv();
  const tripwire = installFetchTripwire();
  try {
    writeModelHost(t.env, "plain-host", {
      port: PORTS.plain,
      aliases: ["plain-model"],
      engine: "omlx",
    });
    openaiProxy.setDeclaredModelSource(() => [
      {
        id: "cold/declared-model.gguf",
        workload: "wl-cold",
        kind: "ModelRun",
        ownerNodeId: "local",
        state: "cold",
        autoLoadEligible: true,
      },
    ]);
    const { stub, calls } = makeProbeStub({});
    const listServing = requireListServingOpenAIModels();
    const result = await listServing(t.env, { fetch: stub, timeoutMs: 2000 });
    const sync = openaiProxy.listOpenAIModels(t.env);
    expect(result.data).toEqual(sync.data);
    // The ungated early return must still carry the declared set.
    expect(result.declared.map((model) => model.id)).toEqual(["cold/declared-model.gguf"]);
    expect(result.declared).toEqual(sync.declared);
    expect(calls).toEqual([]);
    expect(tripwire.calls).toEqual([]);
  } finally {
    tripwire.restore();
    t.cleanup();
  }
});

test("listServingOpenAIModels fails closed when the readiness fetch rejects", async () => {
  const t = tempEnv();
  const tripwire = installFetchTripwire();
  try {
    writeModelHost(t.env, "warming-host", {
      port: PORTS.warming,
      aliases: ["warming-model"],
      readiness: { path: "/ready" },
    });
    writeModelHost(t.env, "plain-host", {
      port: PORTS.plain,
      aliases: ["plain-model"],
      engine: "omlx",
    });
    const { stub } = makeProbeStub({
      [`${String(PORTS.warming)}/ready`]: () => Promise.reject(new TypeError("connection refused")),
    });
    const listServing = requireListServingOpenAIModels();
    const result = await listServing(t.env, { fetch: stub, timeoutMs: 2000 });
    const ids = modelIds(result);
    expect(ids).not.toContain("warming-model");
    expect(ids).toContain("plain-model");
    expect(tripwire.calls).toEqual([]);
  } finally {
    tripwire.restore();
    t.cleanup();
  }
});

test("listServingOpenAIModels bounds each readiness probe by timeoutMs", async () => {
  const t = tempEnv();
  const tripwire = installFetchTripwire();
  try {
    writeModelHost(t.env, "warming-host", {
      port: PORTS.warming,
      aliases: ["warming-model"],
      readiness: { path: "/ready" },
    });
    writeModelHost(t.env, "plain-host", {
      port: PORTS.plain,
      aliases: ["plain-model"],
      engine: "omlx",
    });
    let sawAbort = false;
    const { stub } = makeProbeStub({
      [`${String(PORTS.warming)}/ready`]: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal ?? null;
          if (signal === null) return;
          const fail = (): void => {
            sawAbort = true;
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("The operation was aborted.", "AbortError"),
            );
          };
          if (signal.aborted) {
            fail();
            return;
          }
          signal.addEventListener("abort", fail, { once: true });
        }),
    });
    const listServing = requireListServingOpenAIModels();
    const start = Date.now();
    const result = await listServing(t.env, { fetch: stub, timeoutMs: 50 });
    expect(Date.now() - start).toBeLessThan(1000);
    const ids = modelIds(result);
    expect(ids).not.toContain("warming-model");
    expect(ids).toContain("plain-model");
    expect(sawAbort).toBe(true);
    expect(tripwire.calls).toEqual([]);
  } finally {
    tripwire.restore();
    t.cleanup();
  }
});

test("listServingOpenAIModels exposes a bounded default probe timeout", () => {
  const value = (openaiProxy as unknown as Record<string, unknown>)[
    "SERVING_MODELS_PROBE_TIMEOUT_MS"
  ];
  expect(typeof value).toBe("number");
  const timeoutMs = value as number;
  expect(timeoutMs).toBeGreaterThan(0);
  expect(timeoutMs).toBeLessThanOrEqual(2000);
});

test("listOpenAIModels still lists readiness-declaring hosts", () => {
  const t = tempEnv();
  const tripwire = installFetchTripwire();
  try {
    writeGateFixtures(t.env);
    const ids = openaiProxy.listOpenAIModels(t.env).data.map((model) => model.id);
    expect(ids).toContain("warming-model");
    expect(ids).toContain("ready-model");
    expect(ids).toContain("plain-model");
    expect(tripwire.calls).toEqual([]);
  } finally {
    tripwire.restore();
    t.cleanup();
  }
});

test("listServingOpenAIModels probes a multi-alias host once and gates every alias", async () => {
  const t = tempEnv();
  const tripwire = installFetchTripwire();
  try {
    writeModelHost(t.env, "warming-host", {
      port: PORTS.warming,
      aliases: ["warming-model", "warming-model-b"],
      readiness: { path: "/ready" },
    });
    const { stub, calls } = makeProbeStub({
      [`${String(PORTS.warming)}/ready`]: () =>
        Response.json({ status: "loading" }, { status: 503 }),
    });
    const listServing = requireListServingOpenAIModels();
    const result = await listServing(t.env, { fetch: stub, timeoutMs: 2000 });
    expect(calls.filter((url) => url.includes(`:${String(PORTS.warming)}/ready`))).toHaveLength(1);
    const ids = modelIds(result);
    expect(ids).not.toContain("warming-model");
    expect(ids).not.toContain("warming-model-b");
    expect(tripwire.calls).toEqual([]);
  } finally {
    tripwire.restore();
    t.cleanup();
  }
});
