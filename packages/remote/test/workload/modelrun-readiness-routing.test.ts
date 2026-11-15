import type { ResolvedEnv } from "@llamactl/core";

import { openaiProxy, server, workloadRuntime } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as routerMod from "../../src/router.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

// #220 RED pin: a ModelRun's declared spec.readiness must flow manifest ->
// serverStart input -> llama-server.state sidecar -> readServerState ->
// modelRunRoutesForDir -> LocalRoute.readiness, where it gates both the
// /v1/models listing and pinned chat routing exactly like a ModelHost
// declaration. At the base revision ModelRunSpecSchema strips the key,
// ServerState/readServerState/tryAdoptExistingServer drop it,
// modelRunRoutesForDir never copies it onto LocalRoute, and the router's
// serverStart input schema has no readiness field — every case below
// fails by assertion on that base.

const originalFetch = globalThis.fetch;

const GUARDED_ENV_KEYS = [
  "LLAMA_CPP_SERVER_ALIAS",
  "LLAMA_CPP_DEFAULT_MODEL",
  "LLAMACTL_UNIFIED_PROXY",
  "LLAMACTL_NODE_NAME",
] as const;

let savedEnv: Partial<Record<(typeof GUARDED_ENV_KEYS)[number], string>> = {};
let dir = "";
let env!: ResolvedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const key of GUARDED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) savedEnv[key] = value;
    Reflect.deleteProperty(process.env, key);
  }
  dir = mkdtempSync(join(tmpdir(), "llamactl-modelrun-readiness-"));
  env = resolveEnv({
    DEV_STORAGE: dir,
    LOCAL_AI_RUNTIME_DIR: dir,
    LLAMA_CPP_MODELS: join(dir, "models"),
    LLAMA_CPP_PORT: "18990",
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  openaiProxy.__setOpenAIProxyServingReadinessForTests(null);
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
  for (const key of GUARDED_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
  dir = "";
});

// Mirrors writeLlamaServerWorkload in
// packages/core/test/openaiProxy.servingRoutes.test.ts, plus the optional
// readiness key the fix persists into the sidecar.
function writeRunWorkload(
  root: string,
  name: string,
  spec: { rel: string; port: number; readiness?: unknown },
): void {
  const workloadDir = join(root, "workloads", name);
  mkdirSync(workloadDir, { recursive: true });
  writeFileSync(join(workloadDir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(workloadDir, "llama-server.state"),
    JSON.stringify({
      rel: spec.rel,
      extraArgs: [],
      host: "127.0.0.1",
      port: String(spec.port),
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-11-14T00:00:00.000Z",
      tunedProfile: null,
      ...(spec.readiness !== undefined ? { readiness: spec.readiness } : {}),
    }),
  );
}

type StubHandler = () => Response | Promise<Response>;

interface FetchStub {
  calls: string[];
  fetch: typeof globalThis.fetch;
  callsTo: (port: number, pathname?: string) => string[];
}

// One recording stub serves both the /ready probes and any forwarded
// /v1/chat/completions: chat answers a 200 chat.completion on every port
// so a misroute still shows up as a recorded call; undeclared /ready
// paths answer 404.
function installFetchStub(handlers: Record<string, StubHandler>): FetchStub {
  const calls: string[] = [];
  const fetchImpl = (async (input: Request | URL | string) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const parsed = new URL(url);
    const handler = handlers[`${parsed.port}${parsed.pathname}`];
    if (handler !== undefined) return await handler();
    if (parsed.pathname === "/v1/chat/completions") {
      return Response.json({
        id: "chatcmpl-modelrun-readiness",
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
  return {
    calls,
    fetch: fetchImpl,
    callsTo: (port, pathname) =>
      calls.filter((url) => {
        const parsed = new URL(url);
        return (
          parsed.port === String(port) && (pathname === undefined || parsed.pathname === pathname)
        );
      }),
  };
}

const chatRequest = (model: string): Request =>
  new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });

type ProxyErrorBody = {
  error: {
    message: string;
    type: string;
    code: string;
    param: string;
    state?: string;
    reason?: string;
  };
};

test("a ModelRun whose declared readiness fails is hidden from /v1/models; an undeclared ModelRun stays listed and unprobed", async () => {
  // Kills: modelRunRoutesForDir not copying state.readiness — at base the
  // route carries no readiness, the warm rel stays listed, and /ready is
  // never probed.
  const warmPort = 18810;
  const plainPort = 18811;
  const warmRel = "readiness-warm/run.gguf";
  const plainRel = "readiness-plain/run.gguf";
  writeRunWorkload(dir, "warm-run", {
    rel: warmRel,
    port: warmPort,
    readiness: { path: "/ready", expectStatus: 200 },
  });
  writeRunWorkload(dir, "plain-run", { rel: plainRel, port: plainPort });
  const { fetch: stub, callsTo } = installFetchStub({
    [`${String(warmPort)}/ready`]: () => Response.json({ status: "loading" }, { status: 503 }),
  });

  const routes = workloadRuntime.listLocalRoutes(env);
  expect(routes.find((r) => r.workload === "warm-run")?.readiness).toEqual({
    path: "/ready",
    expectStatus: 200,
  });
  const plainRoute = routes.find((r) => r.workload === "plain-run");
  expect(plainRoute).toBeDefined();
  if (plainRoute !== undefined) expect("readiness" in plainRoute).toBe(false);

  const models = await openaiProxy.listServingOpenAIModels(env, { fetch: stub });
  const ids = models.data.map((m) => m.id);
  expect(ids).toContain(plainRel);
  expect(ids).not.toContain(warmRel);
  expect(callsTo(warmPort, "/ready")).toHaveLength(1);
  expect(callsTo(plainPort)).toHaveLength(0);
});

test("a ModelRun is listed once its declared readiness passes", async () => {
  // Kills: the same mutation plus a gate that ignores ModelRun readiness —
  // at base there are 0 probe calls.
  const warmPort = 18812;
  const plainPort = 18813;
  const warmRel = "readiness-warm/run.gguf";
  const plainRel = "readiness-plain/run.gguf";
  writeRunWorkload(dir, "warm-run", {
    rel: warmRel,
    port: warmPort,
    readiness: { path: "/ready", expectStatus: 200, expectJson: { status: "ready" } },
  });
  writeRunWorkload(dir, "plain-run", { rel: plainRel, port: plainPort });
  const { fetch: stub, callsTo } = installFetchStub({
    [`${String(warmPort)}/ready`]: () => Response.json({ status: "ready", model: "x" }),
  });

  const models = await openaiProxy.listServingOpenAIModels(env, { fetch: stub });
  const ids = models.data.map((m) => m.id);
  expect(ids).toContain(warmRel);
  expect(ids).toContain(plainRel);
  expect(callsTo(warmPort, "/ready")).toHaveLength(1);
  expect(callsTo(plainPort)).toHaveLength(0);
});

test("a pinned ModelRun with failing readiness gets the typed 503 and is never forwarded; an undeclared ModelRun still routes", async () => {
  // Kills: ModelRun route-map candidates built without readiness/probeKey —
  // at base the warm pin forwards and answers 200.
  const warmPort = 18814;
  const plainPort = 18815;
  const warmRel = "readiness-warm/run.gguf";
  const plainRel = "readiness-plain/run.gguf";
  writeRunWorkload(dir, "warm-run", {
    rel: warmRel,
    port: warmPort,
    readiness: { path: "/ready", expectStatus: 200 },
  });
  writeRunWorkload(dir, "plain-run", { rel: plainRel, port: plainPort });
  const { fetch: stub, callsTo } = installFetchStub({
    [`${String(warmPort)}/ready`]: () => Response.json({ status: "loading" }, { status: 503 }),
  });
  globalThis.fetch = stub;
  openaiProxy.__setOpenAIProxyServingReadinessForTests({ fetch: stub });

  const warmRes = await openaiProxy.proxyOpenAI(chatRequest(warmRel), env);
  expect(warmRes.status).toBe(503);
  const body = (await warmRes.json()) as ProxyErrorBody;
  expect(body.error.code).toBe("model_not_loaded");
  expect(body.error.state).toBe("loading");
  expect(body.error.reason).toBe("serving-readiness-pending");
  expect(body.error.message).toContain(
    `model '${warmRel}' is declared but not loaded (state: loading)`,
  );
  expect(callsTo(warmPort, "/v1/chat/completions")).toHaveLength(0);
  expect(callsTo(18990, "/v1/chat/completions")).toHaveLength(0);

  const plainRes = await openaiProxy.proxyOpenAI(chatRequest(plainRel), env);
  expect(plainRes.status).toBe(200);
  expect(callsTo(plainPort, "/v1/chat/completions")).toHaveLength(1);
});

test("readServerState drops a malformed ModelRun readiness but keeps the sidecar", async () => {
  // Kills: readServerState returning parsed.readiness unvalidated — at
  // base the raw malformed object comes back on the state.
  const badSlashRel = "readiness-bad-slash/run.gguf";
  const badJsonRel = "readiness-bad-json/run.gguf";
  writeRunWorkload(dir, "bad-slash", {
    rel: badSlashRel,
    port: 18816,
    readiness: { path: "ready" },
  });
  writeRunWorkload(dir, "bad-json", {
    rel: badJsonRel,
    port: 18817,
    readiness: { path: "/ready", expectJson: { status: { nested: true } } },
  });
  for (const [name, rel] of [
    ["bad-slash", badSlashRel],
    ["bad-json", badJsonRel],
  ] as const) {
    const state = server.readServerState({ name }, env);
    expect(state).not.toBeNull();
    expect(state?.rel).toBe(rel);
    expect(state !== null && "readiness" in state).toBe(false);
  }
  const { fetch: stub, callsTo } = installFetchStub({});
  const models = await openaiProxy.listServingOpenAIModels(env, { fetch: stub });
  const ids = models.data.map((m) => m.id);
  expect(ids).toContain(badSlashRel);
  expect(ids).toContain(badJsonRel);
  expect(callsTo(18816, "/ready")).toHaveLength(0);
  expect(callsTo(18817, "/ready")).toHaveLength(0);
});

test("tryAdoptExistingServer persists the declared readiness into the ModelRun sidecar", async () => {
  // Kills: tryAdoptExistingServer/ServerState dropping readiness — at base
  // the adopted sidecar carries no readiness key.
  const pid = await server.tryAdoptExistingServer({
    resolved: env,
    key: { name: "adopt-run" },
    endpointUrl: "http://127.0.0.1:18821",
    host: "127.0.0.1",
    port: 18821,
    rel: "readiness-adopt/run.gguf",
    extraArgs: [],
    binary: "/x/llama-server",
    readiness: { path: "/ready", expectStatus: 200 },
    deps: {
      probeModelIds: () => Promise.resolve(["readiness-adopt/run.gguf"]),
      findListenerPid: () => Promise.resolve(process.pid),
      readProcessCommand: () => null,
    },
  });
  expect(pid).toBe(process.pid);
  const adopted = server.readServerState({ name: "adopt-run" }, env);
  expect(adopted?.readiness).toEqual({
    path: "/ready",
    expectStatus: 200,
  });

  const plainPid = await server.tryAdoptExistingServer({
    resolved: env,
    key: { name: "adopt-plain" },
    endpointUrl: "http://127.0.0.1:18822",
    host: "127.0.0.1",
    port: 18822,
    rel: "readiness-adopt-plain/run.gguf",
    extraArgs: [],
    binary: "/x/llama-server",
    deps: {
      probeModelIds: () => Promise.resolve(["readiness-adopt-plain/run.gguf"]),
      findListenerPid: () => Promise.resolve(process.pid),
      readProcessCommand: () => null,
    },
  });
  expect(plainPid).toBe(process.pid);
  const plainState = server.readServerState({ name: "adopt-plain" }, env);
  expect(plainState).not.toBeNull();
  expect(plainState !== null && "readiness" in plainState).toBe(false);
});

test("the serverStart RPC input keeps a declared readiness and rejects a malformed one", () => {
  // Kills: the serverStart input stripping readiness — at base the export
  // is undefined.
  const schema = (routerMod as Record<string, unknown>)["ServerStartInputSchema"] as
    | {
        parse: (v: unknown) => Record<string, unknown>;
        safeParse: (v: unknown) => { success: boolean };
      }
    | undefined;
  expect(schema).toBeDefined();
  if (schema === undefined) return;
  expect(
    schema.parse({ workload: "w", target: "t", readiness: { path: "/ready" } })["readiness"],
  ).toEqual({ path: "/ready", expectStatus: 200 });
  expect(
    schema.safeParse({ workload: "w", target: "t", readiness: { path: "/ready", extra: 1 } })
      .success,
  ).toBe(false);
  expect("readiness" in schema.parse({ workload: "w", target: "t" })).toBe(false);
});

test("the serverStart subscription forwards the normalized readiness into startServer", async () => {
  // Kills: the router's serverStart -> startServer call dropping
  // `readiness` — the schema test above passes with it gone, and the
  // spied startServer then sees no readiness key.
  const seen: server.StartServerOptions[] = [];
  const startSpy = spyOn(server, "startServer").mockImplementation((opts) => {
    seen.push(opts);
    return Promise.resolve({
      ok: true,
      pid: 4242,
      endpoint: "http://127.0.0.1:18830",
      advertisedEndpoint: "http://127.0.0.1:18830",
      tunedProfile: null,
      retried: false,
    });
  });
  try {
    const caller = routerMod.router.createCaller({});
    const drain = async (input: Record<string, unknown>): Promise<string[]> => {
      const types: string[] = [];
      const stream = await caller.serverStart(input as Parameters<typeof caller.serverStart>[0]);
      for await (const evt of stream) types.push(evt.type);
      return types;
    };

    expect(
      await drain({
        workload: "rpc-run",
        target: "readiness-rpc/run.gguf",
        readiness: { path: "/ready", expectJson: { status: "ready" } },
      }),
    ).toEqual(["done"]);
    expect(await drain({ workload: "rpc-plain", target: "readiness-rpc/plain.gguf" })).toEqual([
      "done",
    ]);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.key).toEqual({ name: "rpc-run" });
    expect(seen[0]?.readiness).toEqual({
      path: "/ready",
      expectStatus: 200,
      expectJson: { status: "ready" },
    });
    expect(seen[1]?.key).toEqual({ name: "rpc-plain" });
    expect(seen[1] !== undefined && "readiness" in seen[1]).toBe(false);
  } finally {
    startSpy.mockRestore();
  }
});
