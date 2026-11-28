import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";

import { writeModelHostState } from "../src/engines/state.js";
import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

// #367 RED pins: expired serving-readiness verdicts must be swept on a miss
// without evicting live verdicts. The cache-size accessor lands with the fix;
// the namespace lookup keeps this file typechecking at base, where the pin
// fails by assertion instead of an import or type error.

const originalFetch = globalThis.fetch;

const DEFAULT_PORT = 18990;

let nextFixturePort = 18800;
const fixturePort = (): number => {
  nextFixturePort += 1;
  return nextFixturePort;
};

type ServingReadinessTestOverrides = {
  now?: () => number;
};

let clock = 1_000_000;

afterEach(() => {
  globalThis.fetch = originalFetch;
  const seam = (openaiProxy as unknown as Record<string, unknown>)[
    "__setOpenAIProxyServingReadinessForTests"
  ] as ((value: ServingReadinessTestOverrides | null) => void) | undefined;
  seam?.(null);
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

function tempEnv(): {
  env: ResolvedEnv;
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-verdict-retention-"));
  return {
    env: resolveEnv({
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: dir,
      LLAMA_CPP_MODELS: join(dir, "models"),
      LLAMA_CPP_PORT: String(DEFAULT_PORT),
    }),
    dir,
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function writeModelHost(resolved: ResolvedEnv, name: string, alias: string, port: number): void {
  writeModelHostState(
    {
      kind: "ModelHost",
      engine: "llamacpp",
      pid: process.pid,
      host: "127.0.0.1",
      port,
      modelAliases: [alias],
      startedAt: "2026-11-14T00:00:00.000Z",
      readiness: { path: "/ready" },
    },
    { name },
    resolved,
  );
}

interface ProxyFetchStub {
  calls: string[];
  readyCalls: (port?: number) => string[];
}

const callsMatching = (calls: string[], pathname: string, port?: number): string[] =>
  calls.filter((url) => {
    const parsed = new URL(url);
    return parsed.pathname === pathname && (port === undefined || parsed.port === String(port));
  });

// Every fixture host is already serving: readiness must stay independent of
// the port so a rewritten endpoint never falls into the warming path.
function installProxyFetchStub(): ProxyFetchStub {
  const calls: string[] = [];
  const respond = (input: Request | URL | string): Response => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === "/ready") {
      return Response.json({ status: "ready" }, { status: 200 });
    }
    if (parsed.pathname === "/v1/chat/completions") {
      return Response.json({
        id: "chatcmpl-serving-verdict-retention",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  };
  const stub = ((input: Request | URL | string) =>
    Promise.resolve(respond(input))) as unknown as typeof fetch;
  globalThis.fetch = stub;
  return {
    calls,
    readyCalls: (port) => callsMatching(calls, "/ready", port),
  };
}

function installClock(): void {
  clock = 1_000_000;
  const fn = (openaiProxy as unknown as Record<string, unknown>)[
    "__setOpenAIProxyServingReadinessForTests"
  ] as ((value: ServingReadinessTestOverrides | null) => void) | undefined;
  expect(typeof fn).toBe("function");
  fn!({ now: () => clock });
}

function servingRouteReadinessTtlMs(): number {
  const value = (openaiProxy as unknown as Record<string, unknown>)[
    "SERVING_ROUTE_READINESS_TTL_MS"
  ];
  expect(typeof value).toBe("number");
  const ttlMs = value as number;
  expect(ttlMs).toBeGreaterThan(0);
  return ttlMs;
}

function servingVerdictCacheSize(): number {
  const fn = (openaiProxy as unknown as Record<string, unknown>)[
    "__getOpenAIProxyServingVerdictCacheSizeForTests"
  ] as (() => number) | undefined;
  expect(typeof fn).toBe("function");
  return fn!();
}

const chatCompletionsRequest = (model: string): Request =>
  new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });

const pinModel = (model: string, env: ResolvedEnv): Promise<Response> =>
  openaiProxy.proxyOpenAI(chatCompletionsRequest(model), env);

test("expired verdicts for replaced engine endpoints are evicted (#367)", async () => {
  const t = tempEnv();
  try {
    installClock();
    const ttlMs = servingRouteReadinessTtlMs();
    const stub = installProxyFetchStub();

    for (let iteration = 0; iteration < 6; iteration += 1) {
      const port = fixturePort();
      writeModelHost(t.env, "cycle-host", "cycle-model", port);
      clock += ttlMs + 1;
      const res = await pinModel("cycle-model", t.env);
      expect(res.status).toBe(200);
    }

    // Only the current endpoint may remain; without the miss-time sweep this
    // is 6, one retained verdict per rewrite.
    expect(servingVerdictCacheSize()).toBe(1);

    // Sanity check, not mutation coverage: every restart probes once whether
    // or not expired entries are swept.
    expect(stub.readyCalls()).toHaveLength(6);
  } finally {
    t.cleanup();
  }
});

test("an unexpired verdict survives the sweep and still serves cache hits", async () => {
  const t = tempEnv();
  try {
    installClock();
    const ttlMs = servingRouteReadinessTtlMs();
    const t0 = clock;
    const portA = fixturePort();
    const portB = fixturePort();
    writeModelHost(t.env, "a-host", "a-model", portA);
    writeModelHost(t.env, "b-host", "b-model", portB);
    const stub = installProxyFetchStub();

    const firstA = await pinModel("a-model", t.env);
    expect(firstA.status).toBe(200);
    const firstB = await pinModel("b-model", t.env);
    expect(firstB.status).toBe(200);
    expect(servingVerdictCacheSize()).toBe(2);

    clock = t0 + ttlMs + 1;
    const portA2 = fixturePort();
    writeModelHost(t.env, "a-host", "a-model", portA2);
    const rewrittenA = await pinModel("a-model", t.env);
    expect(rewrittenA.status).toBe(200);
    // The A2 miss sweeps expired A and B before inserting A2.
    expect(servingVerdictCacheSize()).toBe(1);

    const secondB = await pinModel("b-model", t.env);
    expect(secondB.status).toBe(200);
    // B is re-probed and inserted, while the still-live A2 verdict survives.
    expect(servingVerdictCacheSize()).toBe(2);
    expect(stub.readyCalls(portA)).toHaveLength(1);
    expect(stub.readyCalls(portA2)).toHaveLength(1);
    expect(stub.readyCalls(portB)).toHaveLength(2);

    const secondA = await pinModel("a-model", t.env);
    expect(secondA.status).toBe(200);
    expect(stub.readyCalls(portA2)).toHaveLength(1);
  } finally {
    t.cleanup();
  }
});
