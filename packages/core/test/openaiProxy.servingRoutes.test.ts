import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelHostReadiness } from "../src/engines/types.js";
import type { ResolvedEnv } from "../src/types.js";

import { writeModelHostState } from "../src/engines/state.js";
import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

// #280 DF-07 RED pin: chat routing must gate route candidates on declared
// serving readiness — a warming host is never forwarded to; candidates fall
// through to ready or no-readiness replicas, and an all-warming pin gets a
// typed 503. __setOpenAIProxyServingReadinessForTests,
// servingWarmingModelIds and SERVING_ROUTE_READINESS_TTL_MS land with the
// fix; the namespace lookups keep this file typechecking on the base
// revision (undefined at runtime, so the typeof guards fail by assertion
// first — never by import or type error).

const originalFetch = globalThis.fetch;

// The default llama-server target every tempEnv resolves to; kept distinct
// from the fixture host ports so stub keys never collide.
const DEFAULT_PORT = 18990;

let nextFixturePort = 18700;
const fixturePort = (): number => {
  nextFixturePort += 1;
  return nextFixturePort;
};

type ServingReadinessTestOverrides = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  const seam = (openaiProxy as unknown as Record<string, unknown>)[
    "__setOpenAIProxyServingReadinessForTests"
  ] as ((value: ServingReadinessTestOverrides | null) => void) | undefined;
  seam?.(null);
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

function tempEnv(extra?: Record<string, string>): {
  env: ResolvedEnv;
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-serving-routes-"));
  return {
    env: resolveEnv({
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: dir,
      LLAMA_CPP_MODELS: join(dir, "models"),
      LLAMA_CPP_PORT: String(DEFAULT_PORT),
      ...extra,
    }),
    dir,
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function writeModelHost(
  resolved: ResolvedEnv,
  name: string,
  spec: { port: number; aliases: string[]; readiness?: ModelHostReadiness; pid?: number },
): void {
  writeModelHostState(
    {
      kind: "ModelHost",
      engine: "llamacpp",
      pid: spec.pid ?? process.pid,
      host: "127.0.0.1",
      port: spec.port,
      modelAliases: spec.aliases,
      startedAt: "2026-11-14T00:00:00.000Z",
      ...(spec.readiness !== undefined ? { readiness: spec.readiness } : {}),
    },
    { name },
    resolved,
  );
}

function writeLlamaServerWorkload(
  runtimeRoot: string,
  workload: string,
  state: { rel: string; port: number; extraArgs?: string[] },
): void {
  const dir = join(runtimeRoot, "workloads", workload);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel: state.rel,
      extraArgs: state.extraArgs ?? [],
      host: "127.0.0.1",
      port: state.port,
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-05-24T00:00:00.000Z",
      tunedProfile: null,
    }),
  );
}

const EXPERIMENTAL_CATALOG_TSV =
  'exp-model\tExp test\texp\tcustom\tcustom\texp/model.gguf\torg/exp\tgguf\t{"qualification":{"stage":"experimental"}}\n';

const writeExperimentalCatalog = (dir: string): void => {
  writeFileSync(join(dir, "curated-models.tsv"), EXPERIMENTAL_CATALOG_TSV);
};

type StubHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

interface ProxyFetchStub {
  calls: string[];
  chatCalls: (port?: number) => string[];
  readyCalls: (port?: number) => string[];
}

const callsMatching = (calls: string[], pathname: string, port?: number): string[] =>
  calls.filter((url) => {
    const parsed = new URL(url);
    return parsed.pathname === pathname && (port === undefined || parsed.port === String(port));
  });

// One stub serves both the /ready probes and the forwarded
// /v1/chat/completions (forward() uses globalThis.fetch). Chat calls are
// answered 200 on any port so a misroute still surfaces as a recorded
// call; /ready answers only through an explicit handler (404 = warming).
function installProxyFetchStub(handlers: Record<string, StubHandler>): ProxyFetchStub {
  const calls: string[] = [];
  const stub = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const parsed = new URL(url);
    const handler = handlers[`${parsed.port}${parsed.pathname}`];
    if (handler !== undefined) {
      return await handler(url, init);
    }
    if (parsed.pathname === "/v1/chat/completions") {
      return Response.json({
        id: "chatcmpl-serving-routes",
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
  }) as unknown as typeof fetch;
  globalThis.fetch = stub;
  return {
    calls,
    chatCalls: (port) => callsMatching(calls, "/v1/chat/completions", port),
    readyCalls: (port) => callsMatching(calls, "/ready", port),
  };
}

function setServingReadinessForTests(input: ServingReadinessTestOverrides | null): void {
  const fn = (openaiProxy as unknown as Record<string, unknown>)[
    "__setOpenAIProxyServingReadinessForTests"
  ] as (value: ServingReadinessTestOverrides | null) => void;
  expect(typeof fn).toBe("function");
  fn(input);
}

function servingRouteReadinessTtlMs(): number {
  const value = (openaiProxy as unknown as Record<string, unknown>)[
    "SERVING_ROUTE_READINESS_TTL_MS"
  ];
  expect(typeof value).toBe("number");
  const ttlMs = value as number;
  expect(ttlMs).toBeGreaterThan(0);
  expect(ttlMs).toBeLessThanOrEqual(10_000);
  return ttlMs;
}

function servingWarmingModelIds(): Set<string> {
  const fn = (openaiProxy as unknown as Record<string, unknown>)[
    "servingWarmingModelIds"
  ] as () => Iterable<string>;
  expect(typeof fn).toBe("function");
  return new Set(fn());
}

const chatCompletionsRequest = (model: string): Request =>
  new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });

const pinModel = (model: string, env: ResolvedEnv): Promise<Response> =>
  openaiProxy.proxyOpenAI(chatCompletionsRequest(model), env);

type ProxyErrorBody = {
  error: {
    message: string;
    type: string;
    code: string;
    param: string;
    state?: string;
    auto_load_eligible?: boolean;
    reason?: string;
  };
};

// The synthesized warming rejection: same shape as the declared
// not-loaded 503, with state 'loading' and reason
// 'serving-readiness-pending' when no declaration supplies the state.
async function expectWarmingRejection(res: Response, model: string): Promise<void> {
  expect(res.status).toBe(503);
  const body = (await res.json()) as ProxyErrorBody;
  expect(body.error.code).toBe("model_not_loaded");
  expect(body.error.type).toBe("model_not_loaded");
  expect(body.error.param).toBe("model");
  expect(body.error.state).toBe("loading");
  expect(body.error.auto_load_eligible).toBe(false);
  expect(body.error.reason).toBe("serving-readiness-pending");
  expect(body.error.message).toContain(
    `model '${model}' is declared but not loaded (state: loading)`,
  );
  expect(res.headers.get("retry-after")).toBeNull();
}

test("a warming-only model pin is refused with a typed 503 instead of routed", async () => {
  // Kills: the routing gate removed — the route-map winner forwarded
  // unconditionally (at base this forwards and answers 200).
  const t = tempEnv();
  try {
    const warmPort = fixturePort();
    writeModelHost(t.env, "warm-host", {
      port: warmPort,
      aliases: ["warm-model"],
      readiness: { path: "/ready" },
    });
    const stub = installProxyFetchStub({
      [`${String(warmPort)}/ready`]: () => Response.json({ status: "loading" }, { status: 503 }),
    });

    const res = await pinModel("warm-model", t.env);

    await expectWarmingRejection(res, "warm-model");
    expect(stub.chatCalls(warmPort)).toHaveLength(0);
    expect(stub.chatCalls(DEFAULT_PORT)).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("a warming candidate falls through to a ready replica", async () => {
  // Kills: routing candidates[0] regardless of verdict, and dropping
  // collision losers from the candidate list (at base 'a-warm-host' wins
  // the alias and the request forwards to its port).
  const t = tempEnv();
  try {
    const aPort = fixturePort();
    const bPort = fixturePort();
    writeModelHost(t.env, "a-warm-host", {
      port: aPort,
      aliases: ["shared-model"],
      readiness: { path: "/ready" },
    });
    writeModelHost(t.env, "b-ready-host", {
      port: bPort,
      aliases: ["shared-model"],
      readiness: { path: "/ready", expectJson: { status: "ready" } },
    });
    const stub = installProxyFetchStub({
      [`${String(aPort)}/ready`]: () => Response.json({ status: "loading" }, { status: 503 }),
      [`${String(bPort)}/ready`]: () => Response.json({ status: "ready" }),
    });

    const res = await pinModel("shared-model", t.env);

    expect(res.status).toBe(200);
    const chats = stub.chatCalls();
    expect(chats).toHaveLength(1);
    expect(chats[0]).toBe(`http://127.0.0.1:${String(bPort)}/v1/chat/completions`);
    expect(stub.chatCalls(aPort)).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("a no-readiness replica routes after a warming candidate", async () => {
  // Kills: treating a no-readiness candidate positioned after a warming
  // one as unroutable.
  const t = tempEnv();
  try {
    const aPort = fixturePort();
    const bPort = fixturePort();
    writeModelHost(t.env, "a-warm-host", {
      port: aPort,
      aliases: ["shared-model"],
      readiness: { path: "/ready" },
    });
    writeModelHost(t.env, "b-plain-host", {
      port: bPort,
      aliases: ["shared-model"],
    });
    const stub = installProxyFetchStub({
      [`${String(aPort)}/ready`]: () => Response.json({ status: "loading" }, { status: 503 }),
    });

    const res = await pinModel("shared-model", t.env);

    expect(res.status).toBe(200);
    const chats = stub.chatCalls();
    expect(chats).toHaveLength(1);
    expect(chats[0]).toBe(`http://127.0.0.1:${String(bPort)}/v1/chat/completions`);
    expect(stub.chatCalls(aPort)).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("guard: a lone no-readiness host routes without any readiness probe", async () => {
  // Guard: passes at base — pins that the no-readiness path is unchanged.
  const t = tempEnv();
  try {
    const plainPort = fixturePort();
    writeModelHost(t.env, "plain-host", {
      port: plainPort,
      aliases: ["plain-model"],
    });
    const stub = installProxyFetchStub({});

    const res = await pinModel("plain-model", t.env);

    expect(res.status).toBe(200);
    expect(stub.chatCalls()).toHaveLength(1);
    expect(stub.chatCalls(plainPort)).toHaveLength(1);
    expect(stub.readyCalls()).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("guard: a no-readiness first candidate wins without probing later candidates", async () => {
  // Guard: passes at base — kills a fix that probes every candidate even
  // when the first winner declares no readiness.
  const t = tempEnv();
  try {
    const aPort = fixturePort();
    const bPort = fixturePort();
    writeModelHost(t.env, "a-plain-host", {
      port: aPort,
      aliases: ["shared-model"],
    });
    writeModelHost(t.env, "b-warm-host", {
      port: bPort,
      aliases: ["shared-model"],
      readiness: { path: "/ready" },
    });
    const stub = installProxyFetchStub({
      [`${String(bPort)}/ready`]: () => Response.json({ status: "loading" }, { status: 503 }),
    });

    const res = await pinModel("shared-model", t.env);

    expect(res.status).toBe(200);
    expect(stub.chatCalls()).toHaveLength(1);
    expect(stub.chatCalls(aPort)).toHaveLength(1);
    expect(stub.readyCalls()).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("a rejected readiness probe fails closed", async () => {
  // Kills: treating a probe error as ready (at base the fetch rejection
  // never happens — the request forwards and answers 200).
  const t = tempEnv();
  try {
    const warmPort = fixturePort();
    writeModelHost(t.env, "warm-host", {
      port: warmPort,
      aliases: ["warm-model-refused"],
      readiness: { path: "/ready" },
    });
    const stub = installProxyFetchStub({
      [`${String(warmPort)}/ready`]: () => Promise.reject(new TypeError("connection refused")),
    });

    const res = await pinModel("warm-model-refused", t.env);

    await expectWarmingRejection(res, "warm-model-refused");
    expect(stub.chatCalls()).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("a hung readiness probe is bounded by the configured timeout", async () => {
  // Kills: an unbounded probe — no timeoutMs passed to
  // checkServingReadiness (at base the seam is missing, so the typeof
  // assertion fails).
  const t = tempEnv();
  try {
    const warmPort = fixturePort();
    writeModelHost(t.env, "warm-host", {
      port: warmPort,
      aliases: ["warm-model-timeout"],
      readiness: { path: "/ready" },
    });
    let sawAbort = false;
    const stub = installProxyFetchStub({
      [`${String(warmPort)}/ready`]: (_url, init) =>
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
    setServingReadinessForTests({ timeoutMs: 50 });

    const start = Date.now();
    const res = await pinModel("warm-model-timeout", t.env);
    expect(Date.now() - start).toBeLessThan(1000);

    await expectWarmingRejection(res, "warm-model-timeout");
    expect(sawAbort).toBe(true);
    expect(stub.chatCalls()).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("serving readiness verdicts cache within the TTL and dedupe in-flight probes", async () => {
  // Kills: no verdict cache (a probe per request), a cache that never
  // expires, and no in-flight dedupe.
  const t = tempEnv();
  try {
    const warmPort = fixturePort();
    writeModelHost(t.env, "warm-host", {
      port: warmPort,
      aliases: ["warm-model-cache"],
      readiness: { path: "/ready" },
    });
    let ready = false;
    const stub = installProxyFetchStub({
      [`${String(warmPort)}/ready`]: () =>
        ready
          ? Response.json({ status: "ready" })
          : Response.json({ status: "loading" }, { status: 503 }),
    });
    const ttlMs = servingRouteReadinessTtlMs();
    let clock = 1_000;
    setServingReadinessForTests({ now: () => clock });

    // Two concurrent pins on an empty cache share one in-flight probe.
    const [first, second] = await Promise.all([
      pinModel("warm-model-cache", t.env),
      pinModel("warm-model-cache", t.env),
    ]);
    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(stub.readyCalls(warmPort)).toHaveLength(1);

    // Same clock: the cached verdict answers without a new probe.
    const third = await pinModel("warm-model-cache", t.env);
    expect(third.status).toBe(503);
    expect(stub.readyCalls(warmPort)).toHaveLength(1);

    // Past the TTL with a passing probe the verdict flips and the pin routes.
    clock += ttlMs + 1;
    ready = true;
    const fourth = await pinModel("warm-model-cache", t.env);
    expect(fourth.status).toBe(200);
    expect(stub.readyCalls(warmPort)).toHaveLength(2);
    expect(stub.chatCalls(warmPort)).toHaveLength(1);
  } finally {
    t.cleanup();
  }
});

test("servingWarmingModelIds records warming pins and clears them on ready", async () => {
  // Kills: the warming set never recorded or never cleared.
  const t = tempEnv();
  try {
    const warmPort = fixturePort();
    writeModelHost(t.env, "warm-host", {
      port: warmPort,
      aliases: ["warm-model-set"],
      readiness: { path: "/ready" },
    });
    let ready = false;
    installProxyFetchStub({
      [`${String(warmPort)}/ready`]: () =>
        ready
          ? Response.json({ status: "ready" })
          : Response.json({ status: "loading" }, { status: 503 }),
    });
    const ttlMs = servingRouteReadinessTtlMs();
    let clock = 2_000;
    setServingReadinessForTests({ now: () => clock });

    const first = await pinModel("warm-model-set", t.env);
    expect(first.status).toBe(503);
    expect(servingWarmingModelIds().has("warm-model-set")).toBe(true);

    clock += ttlMs + 1;
    ready = true;
    const second = await pinModel("warm-model-set", t.env);
    expect(second.status).toBe(200);
    expect(servingWarmingModelIds().has("warm-model-set")).toBe(false);
  } finally {
    t.cleanup();
  }
});

test("a ModelHost restart with a new pid re-probes within the verdict TTL", async () => {
  // Kills: dropping the pid from the verdict probeKey — the restarted
  // process would reuse the old process's cached ready verdict and the
  // pin would forward to a warming host.
  const t = tempEnv();
  try {
    const hostPort = fixturePort();
    writeModelHost(t.env, "restart-host", {
      port: hostPort,
      aliases: ["restart-model"],
      readiness: { path: "/ready" },
    });
    let ready = true;
    const stub = installProxyFetchStub({
      [`${String(hostPort)}/ready`]: () =>
        ready
          ? Response.json({ status: "ready" })
          : Response.json({ status: "loading" }, { status: 503 }),
    });
    const ttlMs = servingRouteReadinessTtlMs();
    let clock = 5_000;
    setServingReadinessForTests({ now: () => clock });

    const first = await pinModel("restart-model", t.env);
    expect(first.status).toBe(200);
    expect(stub.readyCalls(hostPort)).toHaveLength(1);
    expect(stub.chatCalls(hostPort)).toHaveLength(1);

    // Same workload/host/port, new live pid, still inside the TTL: the
    // new process is warming and must get a fresh probe.
    expect(process.ppid).not.toBe(process.pid);
    writeModelHost(t.env, "restart-host", {
      port: hostPort,
      aliases: ["restart-model"],
      readiness: { path: "/ready" },
      pid: process.ppid,
    });
    ready = false;
    clock += Math.floor(ttlMs / 2);

    const second = await pinModel("restart-model", t.env);

    await expectWarmingRejection(second, "restart-model");
    expect(stub.readyCalls(hostPort)).toHaveLength(2);
    expect(stub.chatCalls(hostPort)).toHaveLength(1);
    expect(stub.chatCalls()).toHaveLength(1);
  } finally {
    t.cleanup();
  }
});

test("a warming record expires after its TTL with no later requests", async () => {
  // Kills: servingWarmingModelIds returning every recorded id without the
  // expiresAt > now check.
  const t = tempEnv();
  try {
    const warmPort = fixturePort();
    writeModelHost(t.env, "warm-host", {
      port: warmPort,
      aliases: ["warm-model-expiry"],
      readiness: { path: "/ready" },
    });
    installProxyFetchStub({
      [`${String(warmPort)}/ready`]: () => Response.json({ status: "loading" }, { status: 503 }),
    });
    const ttlMs = servingRouteReadinessTtlMs();
    let clock = 0;
    setServingReadinessForTests({ now: () => clock });

    const res = await pinModel("warm-model-expiry", t.env);
    expect(res.status).toBe(503);
    expect(servingWarmingModelIds().has("warm-model-expiry")).toBe(true);

    clock = ttlMs + 1;
    expect(servingWarmingModelIds().has("warm-model-expiry")).toBe(false);
  } finally {
    t.cleanup();
  }
});

test("a declared draining entry's state wins over the synthesized warming rejection", async () => {
  // Kills: ignoring the declaration — synthesizing 'loading' /
  // 'serving-readiness-pending' for a pin whose declared entry carries a
  // stronger state.
  const t = tempEnv();
  try {
    const warmPort = fixturePort();
    writeModelHost(t.env, "warm-host", {
      port: warmPort,
      aliases: ["warm-model-draining"],
      readiness: { path: "/ready" },
    });
    const stub = installProxyFetchStub({
      [`${String(warmPort)}/ready`]: () => Response.json({ status: "loading" }, { status: 503 }),
    });
    openaiProxy.setDeclaredModelSource(() => [
      {
        id: "warm-model-draining",
        workload: "warm-host",
        kind: "ModelHost",
        ownerNodeId: "local",
        state: "draining",
        autoLoadEligible: false,
      },
    ]);

    const res = await pinModel("warm-model-draining", t.env);

    expect(res.status).toBe(503);
    const body = (await res.json()) as ProxyErrorBody;
    expect(body.error.code).toBe("model_not_loaded");
    expect(body.error.state).toBe("draining");
    expect(body.error.auto_load_eligible).toBe(false);
    expect(body.error.reason).toBeUndefined();
    expect(stub.chatCalls()).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("a stale ready declaration does not unlock a warming route", async () => {
  // Kills: trusting a 'ready' declared entry — forwarding the request or
  // returning null instead of the synthesized warming rejection.
  const t = tempEnv();
  try {
    const warmPort = fixturePort();
    writeModelHost(t.env, "warm-host", {
      port: warmPort,
      aliases: ["warm-model-ready-decl"],
      readiness: { path: "/ready" },
    });
    const stub = installProxyFetchStub({
      [`${String(warmPort)}/ready`]: () => Response.json({ status: "loading" }, { status: 503 }),
    });
    openaiProxy.setDeclaredModelSource(() => [
      {
        id: "warm-model-ready-decl",
        workload: "warm-host",
        kind: "ModelHost",
        ownerNodeId: "local",
        state: "ready",
        autoLoadEligible: false,
      },
    ]);

    const res = await pinModel("warm-model-ready-decl", t.env);

    expect(res.status).toBe(503);
    const body = (await res.json()) as ProxyErrorBody;
    expect(body.error.code).toBe("model_not_loaded");
    expect(body.error.state).toBe("loading");
    expect(body.error.auto_load_eligible).toBe(false);
    expect(body.error.reason).toBe("serving-readiness-pending");
    expect(stub.chatCalls()).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("a warming stable candidate does not fall back to an experimental route", async () => {
  // Kills: falling back to any candidate regardless of experimental tier
  // (which would route the pin to the experimental workload's port; at
  // base the non-experimental winner forwards and answers 200).
  const t = tempEnv();
  try {
    writeExperimentalCatalog(t.dir);
    const stablePort = fixturePort();
    const expPort = fixturePort();
    writeModelHost(t.env, "stable-host", {
      port: stablePort,
      aliases: ["shared-alias"],
      readiness: { path: "/ready" },
    });
    writeLlamaServerWorkload(t.dir, "a-exp", {
      rel: "exp/model.gguf",
      port: expPort,
      extraArgs: ["--alias", "shared-alias"],
    });
    const stub = installProxyFetchStub({
      [`${String(stablePort)}/ready`]: () => Response.json({ status: "loading" }, { status: 503 }),
    });

    const res = await pinModel("shared-alias", t.env);

    expect(res.status).toBe(503);
    const body = (await res.json()) as ProxyErrorBody;
    expect(body.error.state).toBe("loading");
    expect(body.error.reason).toBe("serving-readiness-pending");
    expect(stub.chatCalls(expPort)).toHaveLength(0);
    expect(stub.chatCalls(stablePort)).toHaveLength(0);
    expect(stub.chatCalls(DEFAULT_PORT)).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("guard: an experimental-only alias still routes", async () => {
  // Guard: passes at base — experimental candidates route when they are
  // the only candidates for the id.
  const t = tempEnv();
  try {
    writeExperimentalCatalog(t.dir);
    const expPort = fixturePort();
    writeLlamaServerWorkload(t.dir, "a-exp", {
      rel: "exp/model.gguf",
      port: expPort,
      extraArgs: ["--alias", "exp-only-alias"],
    });
    const stub = installProxyFetchStub({});

    const res = await pinModel("exp-only-alias", t.env);

    expect(res.status).toBe(200);
    expect(stub.chatCalls()).toHaveLength(1);
    expect(stub.chatCalls(expPort)).toHaveLength(1);
    expect(stub.readyCalls()).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("guard: an exact experimental rel pin routes past a warming stable alias", async () => {
  // Guard: passes at base — the rel pin's only candidate is the
  // experimental workload, so the warming stable host's alias verdict
  // cannot shadow it.
  const t = tempEnv();
  try {
    writeExperimentalCatalog(t.dir);
    const stablePort = fixturePort();
    const expPort = fixturePort();
    writeModelHost(t.env, "stable-host", {
      port: stablePort,
      aliases: ["shared-alias"],
      readiness: { path: "/ready" },
    });
    writeLlamaServerWorkload(t.dir, "a-exp", {
      rel: "exp/model.gguf",
      port: expPort,
      extraArgs: ["--alias", "shared-alias"],
    });
    const stub = installProxyFetchStub({
      [`${String(stablePort)}/ready`]: () => Response.json({ status: "loading" }, { status: 503 }),
    });

    const res = await pinModel("exp/model.gguf", t.env);

    expect(res.status).toBe(200);
    expect(stub.chatCalls()).toHaveLength(1);
    expect(stub.chatCalls(expPort)).toHaveLength(1);
  } finally {
    t.cleanup();
  }
});

test("a default-target id falls through to the default endpoint while its route warms", async () => {
  // Kills: no default-target exemption on the warming outcome (would
  // 503), and recording default-target ids as warming. At base the route
  // wins and the chat call lands on the host port, not the default one.
  const t = tempEnv({ LLAMA_CPP_SERVER_ALIAS: "default-alias" });
  try {
    const dtPort = fixturePort();
    writeModelHost(t.env, "dt-host", {
      port: dtPort,
      aliases: ["default-alias"],
      readiness: { path: "/ready" },
    });
    const stub = installProxyFetchStub({
      [`${String(dtPort)}/ready`]: () => Response.json({ status: "loading" }, { status: 503 }),
    });

    const res = await pinModel("default-alias", t.env);

    expect(res.status).toBe(200);
    const chats = stub.chatCalls();
    expect(chats).toHaveLength(1);
    expect(chats[0]).toBe(`http://127.0.0.1:${String(DEFAULT_PORT)}/v1/chat/completions`);
    expect(stub.chatCalls(dtPort)).toHaveLength(0);
    expect(servingWarmingModelIds().has("default-alias")).toBe(false);
  } finally {
    t.cleanup();
  }
});
