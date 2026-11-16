/**
 * #280 DF-07 — unified ingress must refuse a stale declared pin before any
 * executor work and share the legacy path's cached stale projection. The
 * legacy proxyOpenAI route already answers the typed declared-not-loaded
 * 503 (staleDeclaredEntryRejectionFor in core openaiProxy.ts); the unified
 * gate in create-proxy.ts has no declared-staleness check today, so each
 * RED case below forwards to the executor and returns 200
 * {marker:"executor"} where the fix must return the 503.
 */
import type { ResolvedEnv } from "@llamactl/core/types";

import { openaiProxy, routingCapabilities, routingCatalog } from "@llamactl/core";
import { writeModelHostState } from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type BackendExecutor,
  type BackendExecutorDescription,
  createProxy,
} from "../../src/proxy/create-proxy.js";
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

function tempEnv(): { env: ResolvedEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-unified-declared-stale-"));
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

type DeclaredRow = routingCatalog.DeclaredModelEntryV1;

const staleRow = (id: string, reason: string): DeclaredRow => ({
  id,
  workload: "stale-host",
  kind: "ModelHost",
  ownerNodeId: "local",
  state: "cold",
  autoLoadEligible: false,
  reason,
});

const readyRow = (id: string): DeclaredRow => ({
  id,
  workload: "stale-host",
  kind: "ModelHost",
  ownerNodeId: "local",
  state: "ready",
  autoLoadEligible: false,
});

// Copied from proxy-unified-dispatch.test.ts: a cloud-api advertisement
// whose capability set satisfies a plain chat request.
function narrowCapsAd(publicModelId: string): routingCatalog.RouteAdvertisementV1 {
  return {
    schemaVersion: 1,
    routeId: `route/${publicModelId}`,
    deploymentId: `deploy/${publicModelId}`,
    backendId: `backend/${publicModelId}`,
    ownerNodeId: "ext-1",
    publicModelIds: [publicModelId],
    upstreamModelId: publicModelId,
    backendKind: "cloud-api",
    transport: "cloud-direct",
    endpoint: "https://api.invalid/v1",
    capabilities: routingCapabilities.RouteCapabilitiesSchema.parse({
      operations: ["generate", "embed", "count-tokens"],
      protocols: ["openai-chat", "openai-responses", "anthropic-messages"],
      streaming: "sse",
      modalities: ["text"],
      tools: false,
      structuredOutput: false,
      tokenCounting: true,
      cancellation: true,
      sessions: false,
    }),
    modelRevision: routingCatalog.knownRevision("rev-1"),
    deploymentEpoch: routingCatalog.knownRevision("epoch-1"),
    adapterRevision: routingCatalog.UNKNOWN_REVISION,
    policyRevision: routingCatalog.UNKNOWN_REVISION,
    weight: 1,
    draining: false,
  };
}

function emptyCatalog(): routingCatalog.RouteCatalog {
  return routingCatalog.buildRouteCatalog({ routes: [], nodeId: "local", now: Date.now() });
}

function countingExecutor(counts: { execute: number }): BackendExecutor {
  return {
    describe: (): BackendExecutorDescription => ({
      id: "counting-executor",
      backendKinds: [],
      transports: [],
    }),
    execute: (): Promise<Response> => {
      counts.execute += 1;
      return Promise.resolve(Response.json({ marker: "executor" }, { status: 200 }));
    },
    cancel: (): boolean => false,
    drain: (): Promise<void> => Promise.resolve(),
    close: (): Promise<void> => Promise.resolve(),
  };
}

function chatRequest(model: string): Request {
  return new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

interface DeclaredErrorBody {
  error: {
    code?: string;
    type?: string;
    reason?: string;
    state?: string;
    param?: string;
    message?: string;
  };
}

function installFetchStub(): string[] {
  const calls: string[] = [];
  globalThis.fetch = ((input: Request | URL | string): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return Promise.resolve(Response.json({ marker: "unexpected-fetch" }));
  }) as unknown as typeof fetch;
  return calls;
}

test("unified ingress refuses a stale declared pin before any executor (no-candidate fall-through)", async () => {
  // Kills: deleting the unified stale guard in create-proxy.ts — with an
  // empty catalog the request falls through to executor.execute (200).
  const t = tempEnv();
  try {
    const counts = { execute: 0, acquire: 0, credentials: 0 };
    const executor = countingExecutor(counts);
    const cat = emptyCatalog();
    const proxy = createProxy({
      env: { LLAMACTL_UNIFIED_PROXY: "1" },
      resolved: () => t.env,
      executor,
      peers: [],
      catalog: () => cat,
      resolveCredentials: () => {
        counts.credentials += 1;
        return Promise.resolve(null);
      },
      acquireExecutor: () => {
        counts.acquire += 1;
        return executor;
      },
    });
    openaiProxy.setDeclaredModelSource(() => [staleRow("stale-model", "stale-artifact-revision")], {
      signature: () => "r1",
    });

    const res = await proxy.handleRequest(chatRequest("stale-model"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as DeclaredErrorBody;
    expect(body.error.code).toBe("model_not_loaded");
    expect(body.error.type).toBe("model_not_loaded");
    expect(body.error.reason).toBe("stale-artifact-revision");
    expect(body.error.state).toBe("cold");
    expect(body.error.param).toBe("model");
    expect(body.error.message).toContain("model 'stale-model' is declared but not loaded");
    expect(counts.execute).toBe(0);
    expect(counts.acquire).toBe(0);
    expect(counts.credentials).toBe(0);
  } finally {
    t.cleanup();
  }
});

test("a stale pin with a selectable candidate is refused before credential/executor acquisition; a current id on the same proxy routes", async () => {
  // Kills: a guard placed only on the no-candidate fall-through branch, or
  // after acquireExecutor/resolveCredentials — the advertised stale-model
  // candidate would be credentialed, acquired and executed (200).
  const t = tempEnv();
  try {
    const counts = { execute: 0, acquire: 0, credentials: 0 };
    const executor = countingExecutor(counts);
    const cat = routingCatalog.buildRouteCatalog({
      routes: [],
      nodeId: "local",
      now: Date.now(),
      advertisements: [narrowCapsAd("stale-model"), narrowCapsAd("current-model")],
    });
    const proxy = createProxy({
      env: { LLAMACTL_UNIFIED_PROXY: "1" },
      resolved: () => t.env,
      executor,
      peers: [],
      catalog: () => cat,
      resolveCredentials: () => {
        counts.credentials += 1;
        return Promise.resolve(null);
      },
      acquireExecutor: () => {
        counts.acquire += 1;
        return executor;
      },
    });
    openaiProxy.setDeclaredModelSource(
      () => [staleRow("stale-model", "stale-owner-epoch"), readyRow("current-model")],
      { signature: () => "r1" },
    );

    const stale = await proxy.handleRequest(chatRequest("stale-model"));
    expect(stale.status).toBe(503);
    const staleBody = (await stale.json()) as DeclaredErrorBody;
    expect(staleBody.error.code).toBe("model_not_loaded");
    expect(staleBody.error.reason).toBe("stale-owner-epoch");
    expect(counts.execute).toBe(0);
    expect(counts.acquire).toBe(0);
    expect(counts.credentials).toBe(0);

    const current = await proxy.handleRequest(chatRequest("current-model"));
    expect(current.status).toBe(200);
    const currentBody = (await current.json()) as { marker?: string };
    expect(currentBody.marker).toBe("executor");
    expect(counts.execute).toBe(1);
  } finally {
    t.cleanup();
  }
});

test("unified and legacy ingress share one cached stale projection", async () => {
  // Kills: a unified stale check that calls declaredModelEntries() directly
  // (or keeps a private cache in create-proxy) instead of the shared
  // staleDeclaredEntries() projection — evaluations would exceed 1 across
  // the six requests below.
  const t = tempEnv();
  try {
    writeHost(t.env, "stale-host", 18811, ["stale-model"]);
    let evaluations = 0;
    openaiProxy.setDeclaredModelSource(
      () => {
        evaluations += 1;
        return [staleRow("stale-model", "stale-artifact-revision")];
      },
      { signature: () => "r1" },
    );
    const counts = { execute: 0 };
    const executor = countingExecutor(counts);
    const cat = emptyCatalog();
    const proxy = createProxy({
      env: { LLAMACTL_UNIFIED_PROXY: "1" },
      resolved: () => t.env,
      executor,
      peers: [],
      catalog: () => cat,
    });
    const fetchCalls = installFetchStub();

    for (const _ of Array.from({ length: 4 }, () => null)) {
      const res = await proxy.handleRequest(chatRequest("stale-model"));
      expect(res.status).toBe(503);
      const body = (await res.json()) as DeclaredErrorBody;
      expect(body.error.code).toBe("model_not_loaded");
      expect(body.error.reason).toBe("stale-artifact-revision");
    }
    for (const _ of Array.from({ length: 2 }, () => null)) {
      const res = await openaiProxy.proxyOpenAI(chatRequest("stale-model"), t.env);
      expect(res.status).toBe(503);
      const body = (await res.json()) as DeclaredErrorBody;
      expect(body.error.reason).toBe("stale-artifact-revision");
    }
    expect(evaluations).toBe(1);
    expect(counts.execute).toBe(0);
    expect(fetchCalls).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("flag off is unchanged", async () => {
  // Guard, not RED: with LLAMACTL_UNIFIED_PROXY unset the composed proxy
  // must hand the request to the passthrough untouched — the declared
  // source is never evaluated and no catalog or executor work runs.
  const t = tempEnv();
  try {
    let evaluations = 0;
    openaiProxy.setDeclaredModelSource(
      () => {
        evaluations += 1;
        return [staleRow("stale-model", "stale-artifact-revision")];
      },
      { signature: () => "r1" },
    );
    const counts = { execute: 0, catalog: 0 };
    const executor = countingExecutor(counts);
    const cat = emptyCatalog();
    const passthroughCalls: { model: string | null }[] = [];
    const passthroughResponses: Response[] = [];
    const proxy = createProxy({
      env: {},
      resolved: () => t.env,
      executor,
      peers: [],
      catalog: () => {
        counts.catalog += 1;
        return cat;
      },
      passthrough: async (req: Request): Promise<Response> => {
        const parsed = (await req.json()) as { model?: unknown };
        passthroughCalls.push({
          model: typeof parsed.model === "string" ? parsed.model : null,
        });
        const res = Response.json({ marker: "passthrough" }, { status: 200 });
        passthroughResponses.push(res);
        return res;
      },
    });

    const res = await proxy.handleRequest(chatRequest("stale-model"));
    expect(res).toBe(passthroughResponses[0]!);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { marker?: string };
    expect(body.marker).toBe("passthrough");
    expect(passthroughCalls).toHaveLength(1);
    expect(passthroughCalls[0]?.model).toBe("stale-model");
    expect(evaluations).toBe(0);
    expect(counts.catalog).toBe(0);
    expect(counts.execute).toBe(0);
  } finally {
    t.cleanup();
  }
});
