import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PeerNode } from "../src/config/peers.js";
import type { AcquireResult, ResidencyLeases } from "../src/residency/leases.js";
import type { ResolvedEnv } from "../src/types.js";
import type { PeerSnapshot } from "../src/workloadRuntime.js";

import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { KvRegistry, openKvStorage, readWorkloadEpoch } from "../src/kvstore/index.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

// #278 (DF-05): proxyOpenAI holds body-lifetime residency leases through a
// nullable registry seam. A variable specifier keeps tsc from resolving the
// not-yet-existing seam, so each case fails by assertion at the pinned base
// rather than by a resolution error.
const LEASES_MODULE = "../src/residency/leases.js";

const originalFetch = globalThis.fetch;

afterEach(async () => {
  const mod = (await import(LEASES_MODULE)) as unknown as {
    setResidencyLeaseRegistry?: (registry: ResidencyLeases | null) => void;
  };
  if (typeof mod.setResidencyLeaseRegistry === "function") {
    mod.setResidencyLeaseRegistry(null);
  }
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

const KV_MODEL = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";
const OTHER_MODEL = "Other-GGUF/other-Q4_K_M.gguf";
const WL_A_PORT = 19611;
const WL_B_PORT = 19612;
const UPSTREAM_TEXT = '{"embeddings":{"x":[0.1,0.2]}}';

type LeaseModule = {
  createResidencyLeases: () => ResidencyLeases;
  setResidencyLeaseRegistry: (registry: ResidencyLeases | null) => void;
  getResidencyLeaseRegistry: () => ResidencyLeases | null;
};

async function loadLeaseModule(): Promise<LeaseModule> {
  const mod = (await import(LEASES_MODULE)) as unknown as LeaseModule;
  expect(typeof mod.setResidencyLeaseRegistry).toBe("function");
  expect(typeof mod.getResidencyLeaseRegistry).toBe("function");
  return mod;
}

function tempKvEnv(): { root: string; env: ResolvedEnv; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-leases-"));
  return {
    root,
    env: resolveEnv({
      DEV_STORAGE: root,
      LOCAL_AI_RUNTIME_DIR: root,
      LLAMA_CPP_MODELS: join(root, "models"),
      LLAMA_CPP_MACHINE_PROFILE: "balanced",
      LLAMA_CPP_QWEN_CTX_SIZE: "32768",
    }),
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeLocalModelRunWorkload(
  runtimeRoot: string,
  workload: string,
  port: number,
  rel: string = KV_MODEL,
): void {
  const dir = join(runtimeRoot, "workloads", workload);
  const slotDir = join(runtimeRoot, "kvstore", "slots", workload);
  mkdirSync(dir, { recursive: true });
  mkdirSync(slotDir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel,
      extraArgs: [],
      slotSavePath: slotDir,
      host: "127.0.0.1",
      port,
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-05-24T00:00:00.000Z",
      tunedProfile: null,
    }),
  );
}

function shaForBody(body: string): string {
  return createHash("sha1").update(body).digest("hex");
}

function installSpyRegistry(mod: LeaseModule): {
  real: ResidencyLeases;
  spy: ResidencyLeases;
  acquireWorkloads: string[];
  releaseResults: boolean[];
} {
  const real = mod.createResidencyLeases();
  const acquireWorkloads: string[] = [];
  const releaseResults: boolean[] = [];
  const spy: ResidencyLeases = {
    acquire(workload: string): AcquireResult {
      acquireWorkloads.push(workload);
      const result = real.acquire(workload);
      if (!result.ok) return result;
      const lease = result.lease;
      const innerRelease = lease.release;
      return {
        ok: true,
        lease: {
          ...lease,
          release: (): boolean => {
            const released = innerRelease();
            releaseResults.push(released);
            return released;
          },
        },
      };
    },
    active: real.active,
    beginDrain: real.beginDrain,
    whenIdle: real.whenIdle,
    commitUnload: real.commitUnload,
    cancelDrain: real.cancelDrain,
    reopen: real.reopen,
    snapshot: real.snapshot,
    waiterCount: real.waiterCount,
    audit: real.audit,
  };
  mod.setResidencyLeaseRegistry(spy);
  return { real, spy, acquireWorkloads, releaseResults };
}

interface FetchCounts {
  slots: number;
  chatCompletions: number;
  byPort: Map<number, number>;
}

function installFetchStub(
  respond: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
): FetchCounts {
  const counts: FetchCounts = { slots: 0, chatCompletions: 0, byPort: new Map() };
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    if (url.pathname.startsWith("/slots/")) {
      counts.slots += 1;
      return Promise.resolve(Response.json({ n_restored: 123, restore_epoch: null }));
    }
    if (url.pathname === "/v1/chat/completions") counts.chatCompletions += 1;
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    counts.byPort.set(port, (counts.byPort.get(port) ?? 0) + 1);
    return Promise.resolve(respond(url, init));
  }) as unknown as typeof fetch;
  return counts;
}

function gatedUpstream(): {
  respond: () => Response;
  close: () => void;
  error: (err: unknown) => void;
  wasCancelled: () => boolean;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c): void {
      controller = c;
      c.enqueue(new TextEncoder().encode(UPSTREAM_TEXT));
    },
    cancel(): void {
      cancelled = true;
    },
  });
  return {
    respond: (): Response =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    close: (): void => {
      controller.close();
    },
    error: (err: unknown): void => {
      controller.error(err);
    },
    wasCancelled: (): boolean => cancelled,
  };
}

function embeddingsRequest(model: string): Request {
  return new Request("http://localhost/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: "x" }),
  });
}

async function readProxyError(
  res: Response,
): Promise<{ type?: string | undefined; code?: string | undefined }> {
  const body = (await res.json()) as {
    error?: { type?: string; code?: string };
  };
  return body.error ?? {};
}

test("#278: a null lease registry leaves proxied requests untouched", async () => {
  const t = tempKvEnv();
  try {
    const mod = await loadLeaseModule();
    expect(mod.getResidencyLeaseRegistry()).toBeNull();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    const upstream = gatedUpstream();
    installFetchStub(() => upstream.respond());
    const { acquireWorkloads } = installSpyRegistry(mod);
    mod.setResidencyLeaseRegistry(null);

    const res = await openaiProxy.proxyOpenAI(embeddingsRequest(KV_MODEL), t.env);
    expect(res.status).toBe(200);
    upstream.close();
    expect(await res.text()).toBe(UPSTREAM_TEXT);
    expect(acquireWorkloads).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#278: a null registry passes a multi-chunk JSON body through unchanged", async () => {
  const t = tempKvEnv();
  try {
    const mod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    mod.setResidencyLeaseRegistry(null);

    const chunk1 = new TextEncoder().encode('{"chunk":"1","data":"');
    const chunk2 = new TextEncoder().encode("ab'");
    const chunk3 = new TextEncoder().encode('","more":""),');
    const chunk4 = new TextEncoder().encode("cd'");
    const chunk5 = new TextEncoder().encode("}");
    const chunks = [chunk1, chunk2, chunk3, chunk4, chunk5];
    const fullBody = chunks.map((c) => String.fromCharCode(...c)).join("");
    const stream = new ReadableStream<Uint8Array>({
      start(c): void {
        for (const chunk of chunks) {
          c.enqueue(chunk);
        }
        c.close();
      },
    });
    const counts = installFetchStub(
      () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const res = await openaiProxy.proxyOpenAI(embeddingsRequest(KV_MODEL), t.env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(fullBody);
    expect(counts.byPort.get(WL_A_PORT)).toBe(1);
  } finally {
    t.cleanup();
  }
});

test("#278: a null registry passes concatenated JSON values through unchanged", async () => {
  const t = tempKvEnv();
  try {
    const mod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    mod.setResidencyLeaseRegistry(null);

    const firstValue = JSON.stringify({ a: 1 });
    const secondValue = JSON.stringify({ b: 2 });
    const concatenated = firstValue + secondValue;
    const stream = new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(new TextEncoder().encode(concatenated));
        c.close();
      },
    });
    const counts = installFetchStub(
      () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const res = await openaiProxy.proxyOpenAI(embeddingsRequest(KV_MODEL), t.env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(concatenated);
    expect(counts.byPort.get(WL_A_PORT)).toBe(1);
  } finally {
    t.cleanup();
  }
});

test("#278: an open response body holds its lease until the stream ends", async () => {
  const t = tempKvEnv();
  try {
    const mod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    const upstream = gatedUpstream();
    installFetchStub(() => upstream.respond());
    const { real, releaseResults } = installSpyRegistry(mod);

    const res = await openaiProxy.proxyOpenAI(embeddingsRequest(KV_MODEL), t.env);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe(UPSTREAM_TEXT);

    expect(real.active("wl-a")).toHaveLength(1);
    const drain = real.beginDrain("wl-a");
    expect(drain.ok).toBe(true);
    if (!drain.ok) {
      throw new Error("beginDrain(wl-a) refused");
    }
    expect(drain.active).toHaveLength(1);
    const leaseId = drain.active[0];
    if (leaseId === undefined) {
      throw new Error("expected one active lease");
    }
    expect(real.commitUnload(drain.token)).toEqual({
      ok: false,
      reason: "LeasesActive",
      active: [leaseId],
    });

    upstream.close();
    let next = await reader.read();
    while (!next.done) {
      next = await reader.read();
    }
    expect(real.active("wl-a")).toEqual([]);
    expect(await real.whenIdle(drain.token)).toEqual({ idle: true });
    expect(releaseResults.filter((released) => released)).toHaveLength(1);
  } finally {
    t.cleanup();
  }
});

test("#278: cancelling the response body releases the lease exactly once", async () => {
  const t = tempKvEnv();
  try {
    const mod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    const upstream = gatedUpstream();
    installFetchStub(() => upstream.respond());
    const { real, releaseResults } = installSpyRegistry(mod);

    const res = await openaiProxy.proxyOpenAI(embeddingsRequest(KV_MODEL), t.env);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(real.active("wl-a")).toHaveLength(1);

    await reader.cancel();
    expect(upstream.wasCancelled()).toBe(true);
    expect(real.active("wl-a")).toEqual([]);
    expect(releaseResults.filter((released) => released)).toHaveLength(1);
  } finally {
    t.cleanup();
  }
});

test("#278: draining and unloaded workloads fence requests while other workloads stay live", async () => {
  const t = tempKvEnv();
  try {
    const mod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    writeLocalModelRunWorkload(t.root, "wl-b", WL_B_PORT, OTHER_MODEL);
    const counts = installFetchStub(
      () =>
        new Response(UPSTREAM_TEXT, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { real } = installSpyRegistry(mod);

    const drain = real.beginDrain("wl-a");
    expect(drain.ok).toBe(true);
    if (!drain.ok) {
      throw new Error("beginDrain(wl-a) refused");
    }

    const draining = await openaiProxy.proxyOpenAI(embeddingsRequest(KV_MODEL), t.env);
    expect(draining.status).toBe(503);
    const drainingError = await readProxyError(draining);
    expect(drainingError.type).toBe("model_draining");
    expect(drainingError.code).toBe("Draining");
    expect(counts.byPort.get(WL_A_PORT) ?? 0).toBe(0);

    expect(real.commitUnload(drain.token)).toEqual({ ok: true, revoked: [] });

    const unloaded = await openaiProxy.proxyOpenAI(embeddingsRequest(KV_MODEL), t.env);
    expect(unloaded.status).toBe(503);
    const unloadedError = await readProxyError(unloaded);
    expect(unloadedError.type).toBe("model_not_loaded");
    expect(unloadedError.code).toBe("Unloaded");

    const other = await openaiProxy.proxyOpenAI(embeddingsRequest(OTHER_MODEL), t.env);
    expect(other.status).toBe(200);
    expect(await other.text()).toBe(UPSTREAM_TEXT);
    expect(counts.byPort.get(WL_B_PORT) ?? 0).toBe(1);
    expect(counts.byPort.get(WL_A_PORT) ?? 0).toBe(0);
  } finally {
    t.cleanup();
  }
});

test("#278: an upstream fetch failure releases the lease", async () => {
  const t = tempKvEnv();
  try {
    const mod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    installFetchStub(() => Promise.reject(new TypeError("connection refused")));
    const { real } = installSpyRegistry(mod);

    const res = await openaiProxy.proxyOpenAI(embeddingsRequest(KV_MODEL), t.env);
    expect(res.status).toBe(502);
    await res.text();
    expect(real.active("wl-a")).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#278: a client abort before headers releases the lease exactly once", async () => {
  const t = tempKvEnv();
  try {
    const mod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    installFetchStub((_url, init) => {
      fetchStarted();
      const signal = init?.signal ?? null;
      return new Promise<Response>((resolve, reject) => {
        if (signal === null) {
          resolve(new Response("{}", { status: 200 }));
          return;
        }
        const onAbort = (): void => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
    });
    const { real, releaseResults } = installSpyRegistry(mod);

    const controller = new AbortController();
    const responsePromise = openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: KV_MODEL, input: "x" }),
        signal: controller.signal,
      }),
      t.env,
    );
    await started;
    controller.abort();
    const res = await responsePromise;
    expect(res.status).toBe(502);
    // Assert before the body settles: bindLeaseToBody alone would hold the
    // lease until the 502 body is consumed, so only the abort listener can
    // satisfy this ordering.
    expect(real.active("wl-a")).toEqual([]);
    expect(releaseResults.filter((released) => released)).toHaveLength(1);
    await res.text();
    expect(real.active("wl-a")).toEqual([]);
    expect(releaseResults.filter((released) => released)).toHaveLength(1);
  } finally {
    t.cleanup();
  }
});

test("#278: a forced unload revokes an open response body", async () => {
  const t = tempKvEnv();
  try {
    const mod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    const upstream = gatedUpstream();
    installFetchStub(() => upstream.respond());
    const { real } = installSpyRegistry(mod);

    const res = await openaiProxy.proxyOpenAI(embeddingsRequest(KV_MODEL), t.env);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    const activeBefore = real.active("wl-a");
    expect(activeBefore).toHaveLength(1);
    const leaseId = activeBefore[0];
    if (leaseId === undefined) {
      throw new Error("expected one active lease");
    }

    const drain = real.beginDrain("wl-a");
    expect(drain.ok).toBe(true);
    if (!drain.ok) {
      throw new Error("beginDrain(wl-a) refused");
    }
    expect(real.commitUnload(drain.token, { force: true, reason: "test" })).toEqual({
      ok: true,
      revoked: [leaseId],
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects matcher is typed as void.
    await expect(reader.read()).rejects.toThrow("lease revoked: forced unload");
    expect(real.active("wl-a")).toEqual([]);
    expect(real.audit()).toHaveLength(1);
    expect(real.audit()[0]).toMatchObject({ forced: true, reason: "test" });
  } finally {
    t.cleanup();
  }
});

test("#278: peer-routed requests bypass the lease registry", async () => {
  const t = tempKvEnv();
  try {
    const mod = await loadLeaseModule();
    const peers: PeerNode[] = [{ id: "peer-a", endpoint: "https://peer-a.local:7843" }];
    const peerSnapshots = new Map<string, PeerSnapshot>([
      [
        "peer-a",
        {
          workloads: [{ modelId: "peer-only/model.gguf", port: 9333 }],
          pressure: "NORMAL",
          fetchedAt: Date.now(),
        },
      ],
    ]);
    openaiProxy.__setOpenAIProxyClusterRoutingForTests({
      clusterPeers: peers,
      peerSnapshots,
    });
    installFetchStub(() => new Response("peer-ok", { status: 200 }));
    const { acquireWorkloads } = installSpyRegistry(mod);

    const res = await openaiProxy.proxyOpenAI(embeddingsRequest("peer-only/model.gguf"), t.env);
    expect(res.status).toBe(200);
    expect(acquireWorkloads).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#278: default-target requests bypass the lease registry", async () => {
  const t = tempKvEnv();
  try {
    const mod = await loadLeaseModule();
    installFetchStub(() => new Response("default-ok", { status: 200 }));
    const { acquireWorkloads } = installSpyRegistry(mod);

    const res = await openaiProxy.proxyOpenAI(embeddingsRequest("no-such-model"), t.env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("default-ok");
    expect(acquireWorkloads).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#278: a draining refusal never touches the warm-KV slot", async () => {
  const t = tempKvEnv();
  try {
    const mod = await loadLeaseModule();
    const slotBaseDir = join(t.root, "kvstore", "slots", "wl-a");
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    const body = JSON.stringify({
      model: KV_MODEL,
      messages: [{ role: "user", content: "drain-kv" }],
    });
    const sha = shaForBody(body);
    const slotFile = join(slotBaseDir, `${sha}.kvslot`);
    mkdirSync(slotBaseDir, { recursive: true });
    writeFileSync(slotFile, "slot");

    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, t.env);
    if (workloadEpoch === null) {
      throw new Error("expected a workload epoch for wl-a");
    }
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    const payloadBytes = Buffer.byteLength(body, "utf8");
    registry.insert({
      sha,
      workload: "wl-a",
      model: null,
      upstreamSlotFile: slotFile,
      quantBits: 8,
      tokens: payloadBytes,
      ctxSize: 32768,
      hits: 0,
      createdAt: Date.now() - 10_000,
      lastUsed: Date.now() - 10_000,
      payloadBytes,
      textBytes: payloadBytes,
      reason: "cold",
      prefixByteLength: payloadBytes,
      workloadEpoch,
      quarantined: 0,
      state: "idle",
      firstResponseToken: "Hello world",
      extFlags: 0,
    });
    storage.close();

    const counts = installFetchStub(
      () =>
        new Response('{"choices":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { real } = installSpyRegistry(mod);
    const drain = real.beginDrain("wl-a");
    expect(drain.ok).toBe(true);

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      t.env,
    );
    expect(res.status).toBe(503);
    const error = await readProxyError(res);
    expect(error.type).toBe("model_draining");
    expect(error.code).toBe("Draining");
    // The acquire must run before maybeKvLookup: under the mutation
    // 'acquire moved below maybeKvLookup' the warm-hit path still runs —
    // applyWarmKvHit does the /slots/ restore (count 1) and leaves the row
    // reserved/active — and this case kills it.
    expect(counts.slots).toBe(0);
    expect(counts.chatCompletions).toBe(0);
    expect(openaiProxy.__getOpenAIProxySlotAllocatorInUseForTests(t.env, "wl-a")).toBe(0);
    const afterStorage = openKvStorage(t.root);
    try {
      const row = new KvRegistry(afterStorage).get(sha);
      expect(row?.state).toBe("idle");
    } finally {
      afterStorage.close();
    }
  } finally {
    t.cleanup();
  }
});

test("#278: null-body path releases the lease and clears active leases", async () => {
  const t = tempKvEnv();
  try {
    const mod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    installFetchStub(
      () =>
        new Response(null, {
          status: 204,
        }),
    );
    const { real, releaseResults } = installSpyRegistry(mod);

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: KV_MODEL, input: "x" }),
      }),
      t.env,
    );
    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe("");
    expect(real.active("wl-a")).toEqual([]);
    expect(releaseResults.filter((released) => released)).toHaveLength(1);
  } finally {
    t.cleanup();
  }
});

test("#278: a throw inside the forward pipeline releases the lease exactly once", async () => {
  const t = tempKvEnv();
  try {
    const mod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    installFetchStub(() => {
      const upstream = new Response(
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(new TextEncoder().encode(UPSTREAM_TEXT));
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
      // Lock the body so abortUpstreamOnBodyCancel's getReader() throws,
      // propagating out of forward() through forwardAndBindResidencyLease.
      const lockedReader = upstream.body?.getReader();
      expect(lockedReader).toBeDefined();
      return upstream;
    });
    const { real, releaseResults } = installSpyRegistry(mod);

    let rejection: unknown = null;
    try {
      await openaiProxy.proxyOpenAI(embeddingsRequest(KV_MODEL), t.env);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect(real.active("wl-a")).toEqual([]);
    expect(releaseResults.filter((released) => released)).toHaveLength(1);
  } finally {
    t.cleanup();
  }
});

test("#278: forced commitUnload aborts the in-flight fetch signal", async () => {
  const t = tempKvEnv();
  try {
    const mod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const upstreamSignals: (AbortSignal | null)[] = [];
    let upstreamCancelled = false;
    installFetchStub((_url, init) => {
      fetchStarted();
      const signal = init?.signal ?? null;
      upstreamSignals.push(signal);
      const body = new ReadableStream<Uint8Array>({
        start(c): void {
          c.enqueue(new TextEncoder().encode(UPSTREAM_TEXT));
        },
        cancel(): void {
          upstreamCancelled = true;
        },
      });
      return new Promise<Response>((resolve, reject) => {
        if (signal === null) {
          resolve(
            new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
          );
          return;
        }
        const onAbort = (): void => {
          void body.cancel();
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
    });
    const { real } = installSpyRegistry(mod);

    const responsePromise = openaiProxy.proxyOpenAI(embeddingsRequest(KV_MODEL), t.env);
    await started;
    const activeBefore = real.active("wl-a");
    expect(activeBefore).toHaveLength(1);
    const drain = real.beginDrain("wl-a");
    expect(drain.ok).toBe(true);
    if (!drain.ok) {
      throw new Error("beginDrain(wl-a) refused");
    }
    // Force unload while the upstream fetch is still pending: the lease
    // signal must already be composed into the fetch signal so revocation
    // aborts upstream and the client gets a terminal error.
    const result = real.commitUnload(drain.token, { force: true, reason: "test" });
    expect(result).toEqual({ ok: true, revoked: activeBefore });
    expect(upstreamSignals[0]?.aborted).toBe(true);

    const res = await responsePromise;
    expect(res.status).toBe(502);
    expect(upstreamCancelled).toBe(true);
    expect(real.active("wl-a")).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#278: null-registry returns the upstream body stream untouched", async () => {
  const t = tempKvEnv();
  try {
    const mod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    mod.setResidencyLeaseRegistry(null);

    let upstreamBodyCancelled = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(new TextEncoder().encode(UPSTREAM_TEXT));
      },
      cancel(): void {
        upstreamBodyCancelled = true;
      },
    });
    installFetchStub(
      () =>
        new Response(upstreamBody, {
          status: 200,
          statusText: "OK",
          headers: {
            "content-type": "application/json",
            "x-custom": "value",
          },
        }),
    );

    const res = await openaiProxy.proxyOpenAI(embeddingsRequest(KV_MODEL), t.env);
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("OK");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-custom")).toBe("value");

    // The null-registry path must not interpose a stream: cancelling the
    // client body reaches the upstream stream's cancel synchronously. An
    // extra TransformStream in the pipeline defers that propagation.
    const cancelPromise = res.body!.cancel();
    expect(upstreamBodyCancelled).toBe(true);
    await cancelPromise;
  } finally {
    t.cleanup();
  }
});
