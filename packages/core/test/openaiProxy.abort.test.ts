import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { PeerNode } from "../src/config/peers.js";
import type { ResolvedEnv } from "../src/types.js";
import type { PeerSnapshot } from "../src/workloadRuntime.js";

import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { KvRegistry, openKvStorage, readWorkloadEpoch } from "../src/kvstore/index.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

function tempEnv(): { env: ResolvedEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-abort-"));
  return {
    env: resolveEnv({
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: dir,
      LLAMA_CPP_MODELS: join(dir, "models"),
    }),
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("client abort propagates to upstream fetch signal", async () => {
  const t = tempEnv();
  try {
    let observedSignal: AbortSignal | null | undefined;
    let signalAbortedAtFetchTime: boolean | undefined;
    let fetchReceivedAbortEvent = false;

    globalThis.fetch = ((_input: Request | URL | string, init?: RequestInit) => {
      observedSignal = init?.signal ?? null;
      signalAbortedAtFetchTime = observedSignal?.aborted ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        if (!observedSignal) {
          // If no signal was propagated, we resolve so the caller can assert on
          // the missing signal (the test failure surface).
          resolve(new Response("{}", { status: 200 }));
          return;
        }
        const onAbort = (): void => {
          fetchReceivedAbortEvent = true;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        if (observedSignal.aborted) {
          onAbort();
          return;
        }
        observedSignal.addEventListener("abort", onAbort, { once: true });
      });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "no-such-model",
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: controller.signal,
    });

    const responsePromise = openaiProxy.proxyOpenAI(req, t.env);
    // Give the pipeline a tick to reach the upstream fetch before aborting.
    await new Promise((r) => setTimeout(r, 5));
    const signalAbortedAfterClientAbort = observedSignal?.aborted ?? undefined;
    controller.abort();

    const response = await responsePromise;

    expect(observedSignal).toBeDefined();
    expect(observedSignal).not.toBeNull();
    expect(signalAbortedAtFetchTime).toBe(false);
    expect(signalAbortedAfterClientAbort).toBe(false);
    expect(fetchReceivedAbortEvent).toBe(true);
    // forward() catches the abort as an upstream failure and yields 502; that
    // path also runs the finally that releases warm-hit lease + reservation.
    expect(response.status).toBe(502);
  } finally {
    t.cleanup();
  }
});

const KV_MODEL = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";

function tempKvEnv(): { root: string; env: ResolvedEnv; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-abort-kv-"));
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

function writeLocalModelRunWorkload(runtimeRoot: string, workload: string, port: number): void {
  const dir = join(runtimeRoot, "workloads", workload);
  const slotDir = join(runtimeRoot, "kvstore", "slots", workload);
  mkdirSync(dir, { recursive: true });
  mkdirSync(slotDir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel: KV_MODEL,
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

test("client abort on a warm-KV hit releases the slot lease and returns the registry row to idle", async () => {
  const t = tempKvEnv();
  try {
    const slotBaseDir = join(t.root, "kvstore", "slots", "wl-a");
    writeLocalModelRunWorkload(t.root, "wl-a", 19511);
    const body = JSON.stringify({
      model: KV_MODEL,
      messages: [{ role: "user", content: "warm-abort" }],
    });
    const sha = shaForBody(body);
    const slotFile = join(slotBaseDir, `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");

    // Seed the KV registry with an idle warm entry — this drives applyWarmKvHit
    // to reserve/activate the row and acquire the single-slot allocator lease,
    // which is exactly the state releaseWarmHitLease must unwind on abort.
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, t.env);
    expect(workloadEpoch).not.toBeNull();
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
      workloadEpoch: workloadEpoch!,
      quarantined: 0,
      state: "idle",
      firstResponseToken: "Hello world",
      extFlags: 0,
    });
    storage.close();

    // Model the upstream as two calls in order: (1) POST /slots/…?action=restore
    // resolves synchronously so the warm-hit path completes reserve+activate and
    // acquires the slot lease; (2) POST /v1/chat/completions hangs on the client's
    // AbortSignal so the request is aborted mid-generation while the KV lease is
    // held. Only that second call needs to reject on abort.
    const flags = { chatFetchStarted: false, chatFetchRejectedOnAbort: false };
    globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);
      if (parsed.pathname.startsWith("/slots/")) {
        // Matches the warm-hit test's synchronous restore mock.
        return Promise.resolve(Response.json({ n_restored: 123, restore_epoch: null }));
      }
      if (parsed.pathname === "/v1/chat/completions") {
        flags.chatFetchStarted = true;
        const signal = init?.signal ?? null;
        return new Promise<Response>((_resolve, reject) => {
          if (!signal) {
            // No signal propagated → resolve so the assertions still fire and
            // the test surfaces the missing-signal failure explicitly.
            _resolve(new Response("{}", { status: 200 }));
            return;
          }
          if (signal.aborted) {
            flags.chatFetchRejectedOnAbort = true;
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              flags.chatFetchRejectedOnAbort = true;
              reject(new DOMException("The operation was aborted.", "AbortError"));
            },
            { once: true },
          );
        });
      }
      return Promise.resolve(Response.json({ ok: true }));
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const responsePromise = openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      }),
      t.env,
    );

    // Wait for the pipeline to progress through slot-restore and reach the
    // upstream chat fetch before aborting; otherwise we would abort before
    // the warm-hit lease is even acquired.
    for (let i = 0; i < 200 && !flags.chatFetchStarted; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(flags.chatFetchStarted).toBe(true);

    // While the chat fetch is in flight, the KV registry row should be active
    // (reserve → activate ran before the fetch) and the slot lease held.
    expect(openaiProxy.__getOpenAIProxySlotAllocatorInUseForTests(t.env, "wl-a")).toBe(1);
    const activeStorage = openKvStorage(t.root);
    try {
      const inFlightEntry = new KvRegistry(activeStorage).get(sha);
      expect(inFlightEntry?.state).toBe("active");
    } finally {
      activeStorage.close();
    }

    controller.abort();
    const response = await responsePromise;

    expect(flags.chatFetchRejectedOnAbort).toBe(true);
    // forward() catches AbortError and yields 502; proxyOpenAI's finally still
    // runs releaseWarmHitLease, which is what this test pins.
    expect(response.status).toBe(502);

    // Post-abort: the slot lease is released and the registry row is back to
    // idle (not stuck reserved/active). Without releaseWarmHitLease firing in
    // the finally, the row stays 'active' and the allocator stays at 1.
    expect(openaiProxy.__getOpenAIProxySlotAllocatorInUseForTests(t.env, "wl-a")).toBe(0);
    const afterStorage = openKvStorage(t.root);
    try {
      const afterEntry = new KvRegistry(afterStorage).get(sha);
      expect(afterEntry?.state).toBe("idle");
    } finally {
      afterStorage.close();
    }
  } finally {
    t.cleanup();
  }
});

test("peer-route 502 does not invalidate the route cache when the client aborted", async () => {
  const t = tempEnv();
  try {
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

    // First call: upstream returns 502 (fetch resolves, does not throw) while
    // the client AbortSignal is already aborted. This is the race the guard in
    // forward() must defend against: without it, `upstream.status === 502`
    // would clear the peer route/models cache, forcing a full rebuild for every
    // unrelated caller just because one client hung up.
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(new Response("bad gateway", { status: 502 }))) as unknown as typeof fetch;

    const buildsBefore = openaiProxy.__getOpenAIProxyRouteMapBuildCountForTests();

    const aborted = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "peer-only/model.gguf",
          messages: [{ role: "user", content: "peer-aborted" }],
        }),
        signal: controller.signal,
      }),
      t.env,
    );
    // The 502 is still forwarded to the client — the guard is about cache side
    // effects, not the status surface.
    expect(aborted.status).toBe(502);
    // The first request built the route map exactly once.
    expect(openaiProxy.__getOpenAIProxyRouteMapBuildCountForTests()).toBe(buildsBefore + 1);

    // Second call (non-aborted, upstream 200): if the guard held, the cache
    // was preserved and this call reuses the existing map with NO additional
    // build. Without the guard, invalidateRouteCacheEntry would have cleared
    // the cache during the aborted 502 and this would force a rebuild
    // (buildsBefore + 2). Contrast with the sibling test in openaiProxy.test.ts
    // ("peer 502 invalidates route cache…") where a non-aborted 502 does force
    // the rebuild.
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve(Response.json({ ok: true }))) as unknown as typeof fetch;
    const followup = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "peer-only/model.gguf",
          messages: [{ role: "user", content: "peer-followup" }],
        }),
      }),
      t.env,
    );
    expect(followup.status).toBe(200);
    expect(openaiProxy.__getOpenAIProxyRouteMapBuildCountForTests()).toBe(buildsBefore + 1);
  } finally {
    t.cleanup();
  }
});

test("normal (non-aborted) completion is unaffected by signal propagation", async () => {
  const t = tempEnv();
  try {
    let observedSignal: AbortSignal | null | undefined;
    globalThis.fetch = ((_input: Request | URL | string, init?: RequestInit) => {
      observedSignal = init?.signal ?? null;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "no-such-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const response = await openaiProxy.proxyOpenAI(req, t.env);
    expect(response.status).toBe(200);
    // Signal is present (composed from req.signal) but not aborted.
    expect(observedSignal).toBeDefined();
    expect(observedSignal).not.toBeNull();
    expect(observedSignal?.aborted).toBe(false);
  } finally {
    t.cleanup();
  }
});
