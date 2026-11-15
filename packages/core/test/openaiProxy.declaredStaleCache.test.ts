import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";

import { writeModelHostState } from "../src/engines/state.js";
import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

// #280 DF-07: the routed-path stale-binding check must not evaluate the
// declared source on every request. In production that source runs
// listLocalRoutes (a synchronous `ps`) and parses every manifest, so the
// projection is cached on the route-map runtime signature plus the source's
// own signature. These pins count source evaluations directly.

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

function tempEnv(): { env: ResolvedEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-declared-stale-cache-"));
  return {
    env: resolveEnv({
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: dir,
      LLAMA_CPP_MODELS: join(dir, "models"),
      LLAMA_CPP_PORT: "18989",
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
      startedAt: "2026-11-15T00:00:00.000Z",
    },
    { name },
    resolved,
  );
}

function installChatStub(): string[] {
  const calls: string[] = [];
  globalThis.fetch = ((input: Request | URL | string): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return Promise.resolve(
      Response.json({
        id: "chatcmpl-declared-stale-cache",
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
      }),
    );
  }) as unknown as typeof fetch;
  return calls;
}

const pin = (model: string, env: ResolvedEnv): Promise<Response> =>
  openaiProxy.proxyOpenAI(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    }),
    env,
  );

type DeclaredRow = {
  id: string;
  workload: string;
  kind: "ModelHost";
  ownerNodeId: string;
  state: "ready" | "cold";
  autoLoadEligible: boolean;
  reason?: string;
};

const readyRow = (id: string): DeclaredRow => ({
  id,
  workload: "cache-host",
  kind: "ModelHost",
  ownerNodeId: "local",
  state: "ready",
  autoLoadEligible: false,
});

const staleRow = (id: string): DeclaredRow => ({
  id,
  workload: "cache-host",
  kind: "ModelHost",
  ownerNodeId: "local",
  state: "cold",
  autoLoadEligible: false,
  reason: "stale-artifact-revision",
});

test("N routed requests evaluate the declared source at most once while nothing changes", async () => {
  // Kills: evaluating declaredModelEntries() uncached on every routed request.
  const t = tempEnv();
  try {
    writeHost(t.env, "cache-host", 18801, ["cache-model"]);
    const chatCalls = installChatStub();
    let evaluations = 0;
    let manifestRevision = "r1";
    openaiProxy.setDeclaredModelSource(
      () => {
        evaluations += 1;
        return [readyRow("cache-model")];
      },
      { signature: () => manifestRevision },
    );

    for (let i = 0; i < 5; i += 1) {
      const res = await pin("cache-model", t.env);
      expect(res.status).toBe(200);
    }
    expect(chatCalls).toHaveLength(5);
    expect(evaluations).toBeLessThanOrEqual(1);
    const settled = evaluations;

    // A manifest signature change forces exactly one fresh evaluation.
    manifestRevision = "r2";
    for (let i = 0; i < 3; i += 1) {
      expect((await pin("cache-model", t.env)).status).toBe(200);
    }
    expect(evaluations).toBe(settled + 1);

    // A runtime signature change (a new workload's state) does too.
    writeHost(t.env, "other-host", 18802, ["other-model"]);
    for (let i = 0; i < 3; i += 1) {
      expect((await pin("cache-model", t.env)).status).toBe(200);
    }
    expect(evaluations).toBe(settled + 2);
  } finally {
    t.cleanup();
  }
});

test("a cached stale projection keeps refusing, and a signature change re-reads it", async () => {
  // Kills: caching that drops the stale refusal, and a cache key that
  // ignores the source signature (the stale row would outlive the fix).
  const t = tempEnv();
  try {
    writeHost(t.env, "cache-host", 18803, ["stale-model"]);
    const chatCalls = installChatStub();
    let evaluations = 0;
    let rows: DeclaredRow[] = [staleRow("stale-model")];
    let manifestRevision = "r1";
    openaiProxy.setDeclaredModelSource(
      () => {
        evaluations += 1;
        return rows;
      },
      { signature: () => manifestRevision },
    );

    for (let i = 0; i < 4; i += 1) {
      const res = await pin("stale-model", t.env);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string; reason?: string } };
      expect(body.error.code).toBe("model_not_loaded");
      expect(body.error.reason).toBe("stale-artifact-revision");
    }
    expect(evaluations).toBe(1);
    expect(chatCalls).toHaveLength(0);

    rows = [readyRow("stale-model")];
    manifestRevision = "r2";
    expect((await pin("stale-model", t.env)).status).toBe(200);
    expect(evaluations).toBe(2);
    expect(chatCalls).toHaveLength(1);
  } finally {
    t.cleanup();
  }
});

test("a withdrawal change re-reads the stale projection", async () => {
  // Kills: a cache key that ignores the withdrawn set (a withdrawing claim
  // projects 'draining', which drops its stale reason).
  const t = tempEnv();
  try {
    writeHost(t.env, "cache-host", 18804, ["withdraw-model"]);
    installChatStub();
    let evaluations = 0;
    openaiProxy.setDeclaredModelSource(
      () => {
        evaluations += 1;
        return [readyRow("withdraw-model")];
      },
      { signature: () => "fixed" },
    );

    expect((await pin("withdraw-model", t.env)).status).toBe(200);
    expect(evaluations).toBe(1);
    const release = openaiProxy.withdrawServingRoute("unrelated-host");
    try {
      expect((await pin("withdraw-model", t.env)).status).toBe(200);
      expect(evaluations).toBe(2);
    } finally {
      release();
    }
  } finally {
    t.cleanup();
  }
});
