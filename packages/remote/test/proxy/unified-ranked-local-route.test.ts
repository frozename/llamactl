/**
 * #518 (c) end-to-end: the unified ranker's local-http pick must reach
 * the upstream through the real composition — gatedExecute records the
 * winner's workload on ctx.preferredLocalWorkload, the default legacy
 * executor forwards it to proxyOpenAI as preferredWorkload, and
 * servingRouteForModel serves that replica. At base the hint does not
 * exist, so proxyOpenAI falls back to alias order and the chat call
 * lands on a-host.
 */
import type { ResolvedEnv } from "@llamactl/core/types";

import { openaiProxy, routingCatalog } from "@llamactl/core";
import { writeModelHostState } from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import { listLocalRoutes } from "@llamactl/core/workloadRuntime";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProxy } from "../../src/proxy/create-proxy.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

const ENV_KEYS = [
  "LLAMACTL_UNIFIED_PROXY",
  "LLAMA_CPP_SERVER_ALIAS",
  "LLAMA_CPP_DEFAULT_MODEL",
] as const;

const originalFetch = globalThis.fetch;
let envBackup: Record<string, string | undefined> = {};

beforeAll(() => {
  envBackup = {};
  for (const key of ENV_KEYS) {
    envBackup[key] = process.env[key];
    Reflect.deleteProperty(process.env, key);
  }
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const prev = envBackup[key];
    if (prev === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = prev;
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

let nextFixturePort = 18600;
const fixturePort = (): number => {
  nextFixturePort += 1;
  return nextFixturePort;
};

function tempEnv(): { env: ResolvedEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-unified-ranked-local-"));
  return {
    env: resolveEnv({
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: dir,
      LLAMA_CPP_MODELS: join(dir, "models"),
      LLAMA_CPP_PORT: "18980",
    }),
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function writeHost(resolved: ResolvedEnv, name: string, port: number, aliases: string[]): void {
  writeModelHostState(
    {
      kind: "ModelHost",
      engine: "llamacpp",
      pid: process.pid,
      host: "127.0.0.1",
      port,
      modelAliases: aliases,
      startedAt: "2026-11-16T00:00:00.000Z",
    },
    { name },
    resolved,
  );
}

// The catalog the unified gate sees: local routes with the named
// workloads mapped onto the validated stage; every other route stays
// unstaged.
function rankedLocalCatalog(
  env: ResolvedEnv,
  validated: ReadonlySet<string>,
): routingCatalog.RouteCatalog {
  const routes = listLocalRoutes(env).map((route) =>
    validated.has(route.workload) ? { ...route, qualificationStage: "validated" } : route,
  );
  return routingCatalog.buildRouteCatalog({ routes, nodeId: "mini", now: Date.now() });
}

function chatRequest(model: string): Request {
  return new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

// Answers /v1/chat/completions 200 on any port while recording every URL,
// so a misroute still surfaces as a recorded call on the wrong port.
function installChatFetchStub(): string[] {
  const calls: string[] = [];
  globalThis.fetch = ((input: Request | URL | string): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return Promise.resolve(
      Response.json({
        id: "chatcmpl-ranked-local",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      }),
    );
  }) as unknown as typeof fetch;
  return calls;
}

function chatCalls(calls: string[]): string[] {
  return calls.filter((url) => new URL(url).pathname === "/v1/chat/completions");
}

test("the unified ranker's local pick reaches the upstream", async () => {
  // Kills: the hint being dropped anywhere along gatedExecute, the legacy
  // executor and proxyOpenAI — at base the chat call lands on a-host.
  const t = tempEnv();
  try {
    const aPort = fixturePort();
    const bPort = fixturePort();
    writeHost(t.env, "a-host", aPort, ["rank/e2e"]);
    writeHost(t.env, "b-host", bPort, ["rank/e2e"]);
    expect(openaiProxy.defaultTargetModelIds(t.env).has("rank/e2e")).toBe(false);
    const cat = rankedLocalCatalog(t.env, new Set(["a-host"]));
    const calls = installChatFetchStub();
    const proxy = createProxy({
      env: { LLAMACTL_UNIFIED_PROXY: "1" },
      resolved: () => t.env,
      nodeId: "mini",
      peers: [],
      catalog: () => cat,
    });

    const res = await proxy.handleRequest(chatRequest("rank/e2e"));

    expect(res.status).toBe(200);
    const chats = chatCalls(calls);
    expect(chats).toHaveLength(1);
    expect(chats[0]).toBe(`http://127.0.0.1:${String(bPort)}/v1/chat/completions`);
  } finally {
    t.cleanup();
  }
});

test("guard (passes on base): equal stages keep catalog order to a-host", async () => {
  // Kills: the hint path perturbing the default choice — with no stage
  // separating the candidates the ranked pick is catalog order and the
  // upstream sees a-host.
  const t = tempEnv();
  try {
    const aPort = fixturePort();
    const bPort = fixturePort();
    writeHost(t.env, "a-host", aPort, ["rank/e2e"]);
    writeHost(t.env, "b-host", bPort, ["rank/e2e"]);
    expect(openaiProxy.defaultTargetModelIds(t.env).has("rank/e2e")).toBe(false);
    const cat = rankedLocalCatalog(t.env, new Set());
    const calls = installChatFetchStub();
    const proxy = createProxy({
      env: { LLAMACTL_UNIFIED_PROXY: "1" },
      resolved: () => t.env,
      nodeId: "mini",
      peers: [],
      catalog: () => cat,
    });

    const res = await proxy.handleRequest(chatRequest("rank/e2e"));

    expect(res.status).toBe(200);
    const chats = chatCalls(calls);
    expect(chats).toHaveLength(1);
    expect(chats[0]).toBe(`http://127.0.0.1:${String(aPort)}/v1/chat/completions`);
  } finally {
    t.cleanup();
  }
});
