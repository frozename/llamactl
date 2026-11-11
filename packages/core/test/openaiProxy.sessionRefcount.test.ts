import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PeerNode } from "../src/config/peers.js";
import type { AcquireResult, Lease, ResidencyLeases } from "../src/residency/leases.js";
import type { SessionRefcounts } from "../src/residency/sessions.js";
import type { ResolvedEnv } from "../src/types.js";
import type { PeerSnapshot } from "../src/workloadRuntime.js";

import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { KvRegistry, openKvStorage, readWorkloadEpoch } from "../src/kvstore/index.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

// #520: the x-llamactl-session header drives session refcounts next to the
// HTTP lease, only when both registries are published. Variable specifiers
// keep tsc from resolving the not-yet-existing sessions seam, so each case
// fails by assertion at the pinned base rather than by a resolution error.
const LEASES_MODULE = "../src/residency/leases.js";
const SESSIONS_MODULE = "../src/residency/sessions.js";
const SESSION_HEADER = "x-llamactl-session";

const originalFetch = globalThis.fetch;

afterEach(async () => {
  const leasesMod = (await import(LEASES_MODULE)) as unknown as {
    setResidencyLeaseRegistry?: (registry: ResidencyLeases | null) => void;
  };
  if (typeof leasesMod.setResidencyLeaseRegistry === "function") {
    leasesMod.setResidencyLeaseRegistry(null);
  }
  const sessionsMod = (await import(SESSIONS_MODULE)) as unknown as {
    setSessionRefcountRegistry?: (registry: SessionRefcounts | null) => void;
  };
  if (typeof sessionsMod.setSessionRefcountRegistry === "function") {
    sessionsMod.setSessionRefcountRegistry(null);
  }
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

const KV_MODEL = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";
const OTHER_MODEL = "Other-GGUF/other-Q4_K_M.gguf";
const WL_A_PORT = 19621;
const WL_B_PORT = 19622;
const UPSTREAM_TEXT = '{"embeddings":{"x":[0.1,0.2]}}';

type LeaseModule = {
  createResidencyLeases: () => ResidencyLeases;
  setResidencyLeaseRegistry: (registry: ResidencyLeases | null) => void;
  getResidencyLeaseRegistry: () => ResidencyLeases | null;
  bindLeaseToBody: (
    body: ReadableStream<Uint8Array>,
    lease: Lease,
    onSettle?: () => void,
  ) => ReadableStream<Uint8Array>;
};

type SessionAcquireResult =
  | { ok: true; workload: string; refs: number; generation: number }
  | { ok: false; reason: "AffinityConflict"; boundWorkload: string };

type SessionRefcountsV2 = Omit<SessionRefcounts, "acquire" | "release"> & {
  acquire: (sessionId: string, workload: string) => SessionAcquireResult;
  release: (sessionId: string, generation?: number) => void;
};

type SessionsModule = {
  createSessionRefcounts: (options: {
    idleTimeoutMs: number;
    now?: () => number;
  }) => SessionRefcountsV2;
  setSessionRefcountRegistry: (registry: SessionRefcounts | null) => void;
  currentSessionRefcounts: () => SessionRefcounts | null;
};

type SessionsSpy = SessionRefcountsV2 & { releaseCalls: string[] };

async function loadLeaseModule(): Promise<LeaseModule> {
  const mod = (await import(LEASES_MODULE)) as unknown as LeaseModule;
  expect(typeof mod.setResidencyLeaseRegistry).toBe("function");
  expect(typeof mod.getResidencyLeaseRegistry).toBe("function");
  expect(typeof mod.bindLeaseToBody).toBe("function");
  return mod;
}

async function loadSessionsModule(): Promise<SessionsModule> {
  const mod = (await import(SESSIONS_MODULE)) as unknown as SessionsModule;
  expect(typeof mod.setSessionRefcountRegistry).toBe("function");
  expect(typeof mod.currentSessionRefcounts).toBe("function");
  return mod;
}

function tempKvEnv(): { root: string; env: ResolvedEnv; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-sessions-"));
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

function spySessions(real: SessionRefcountsV2): SessionsSpy {
  const releaseCalls: string[] = [];
  return {
    acquire: (sessionId, workload) => real.acquire(sessionId, workload),
    release: (sessionId, generation): void => {
      releaseCalls.push(sessionId);
      real.release(sessionId, generation);
    },
    touch: (sessionId): void => {
      real.touch(sessionId);
    },
    forceRelease: (workload) => real.forceRelease(workload),
    activeSessions: (workload) => real.activeSessions(workload),
    checkUnload: (workload, opts) => real.checkUnload(workload, opts),
    releaseCalls,
  };
}

function installSessionRefcounts(
  mod: SessionsModule,
  now: () => number,
): { real: SessionRefcountsV2; spy: SessionsSpy } {
  const real = mod.createSessionRefcounts({ idleTimeoutMs: 1_000, now });
  const spy = spySessions(real);
  mod.setSessionRefcountRegistry(spy);
  return { real, spy };
}

function throwingSessions(): SessionRefcounts & { calls: string[] } {
  const calls: string[] = [];
  const boom = (name: string): never => {
    calls.push(name);
    throw new Error(`sessions.${name} must not be called without a lease registry`);
  };
  return {
    acquire: () => boom("acquire"),
    release: () => boom("release"),
    touch: () => boom("touch"),
    forceRelease: () => boom("forceRelease"),
    activeSessions: () => boom("activeSessions"),
    checkUnload: () => boom("checkUnload"),
    calls,
  };
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

function embeddingsRequest(model: string, extraHeaders?: Record<string, string>): Request {
  return new Request("http://localhost/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
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

async function measureProxyOpenAITicks(
  req: Request,
  env: ResolvedEnv,
): Promise<{ turns: number; res: Response }> {
  let fetchStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  installFetchStub(() => {
    fetchStarted();
    return new Response(UPSTREAM_TEXT, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const state = { settled: false };
  const pending = openaiProxy.proxyOpenAI(req, env).then((res) => {
    state.settled = true;
    return res;
  });
  await started;
  let turns = 0;
  for (; turns < 2_000; turns += 1) {
    if (state.settled) break;
    await Promise.resolve();
  }
  expect(state.settled).toBe(true);
  return { turns, res: await pending };
}

test("#520: a session ref releases with the response body, then idle-expires", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    const upstream = gatedUpstream();
    installFetchStub(() => upstream.respond());
    let nowMs = 1_000;
    const { spy: sessions } = installSessionRefcounts(sessionsMod, () => nowMs);
    const { real: leases } = installSpyRegistry(leasesMod);

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(sessions.activeSessions("wl-a")).toEqual(["s1"]);
    expect(leases.active("wl-a")).toHaveLength(1);

    // refs > 0 must not idle-expire: an implementation that releases at
    // headers time drops refs to 0 and prunes s1 here.
    nowMs += 5_000;
    expect(sessions.activeSessions("wl-a")).toEqual(["s1"]);

    upstream.close();
    expect(await res.text()).toBe(UPSTREAM_TEXT);
    expect(leases.active("wl-a")).toEqual([]);
    expect(sessions.releaseCalls).toEqual(["s1"]);
    expect(sessions.activeSessions("wl-a")).toEqual(["s1"]);
    expect(sessions.checkUnload("wl-a")).toEqual({
      ok: false,
      reason: "SessionActive",
      sessions: ["s1"],
    });

    nowMs += 1_000;
    expect(sessions.activeSessions("wl-a")).toEqual([]);
    expect(sessions.checkUnload("wl-a")).toEqual({ ok: true, released: [] });
  } finally {
    t.cleanup();
  }
});

test("#520: sequential requests do not accumulate session refs", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    installFetchStub(
      () =>
        new Response(UPSTREAM_TEXT, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    let nowMs = 1_000;
    const { spy: sessions } = installSessionRefcounts(sessionsMod, () => nowMs);
    installSpyRegistry(leasesMod);

    for (const req of [
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s1" }),
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s1" }),
    ]) {
      const res = await openaiProxy.proxyOpenAI(req, t.env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(UPSTREAM_TEXT);
    }
    expect(sessions.releaseCalls).toEqual(["s1", "s1"]);
    nowMs += 1_000;
    expect(sessions.activeSessions("wl-a")).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#520: a session bound to another workload conflicts with 409", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    writeLocalModelRunWorkload(t.root, "wl-b", WL_B_PORT, OTHER_MODEL);
    const counts = installFetchStub(
      () =>
        new Response(UPSTREAM_TEXT, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { real: sessionsReal } = installSessionRefcounts(sessionsMod, () => 1_000);
    const { real: leases } = installSpyRegistry(leasesMod);
    expect(sessionsReal.acquire("s1", "wl-b")).toMatchObject({
      ok: true,
      workload: "wl-b",
      refs: 1,
    });

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(res.status).toBe(409);
    const error = await readProxyError(res);
    expect(error.code).toBe("AffinityConflict");
    expect(error.type).toBe("session_affinity_conflict");
    expect(leases.active("wl-a")).toEqual([]);
    expect(counts.byPort.get(WL_A_PORT) ?? 0).toBe(0);
  } finally {
    t.cleanup();
  }
});

test("#520: a session conflict never touches the warm-KV slot", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    const slotBaseDir = join(t.root, "kvstore", "slots", "wl-a");
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    writeLocalModelRunWorkload(t.root, "wl-b", WL_B_PORT, OTHER_MODEL);
    const body = JSON.stringify({
      model: KV_MODEL,
      messages: [{ role: "user", content: "conflict-kv" }],
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
    const { real: sessionsReal } = installSessionRefcounts(sessionsMod, () => 1_000);
    const { real: leases } = installSpyRegistry(leasesMod);
    sessionsReal.acquire("s1", "wl-b");

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SESSION_HEADER]: "s1",
        },
        body,
      }),
      t.env,
    );
    expect(res.status).toBe(409);
    const error = await readProxyError(res);
    expect(error.code).toBe("AffinityConflict");
    expect(error.type).toBe("session_affinity_conflict");
    // The session acquire must run before maybeKvLookup: under a mutation
    // that moves it below, the warm-hit path still runs — applyWarmKvHit
    // does the /slots/ restore (count 1) and leaves the row reserved —
    // and this case kills it.
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
    expect(leases.active("wl-a")).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#520: without a sessions registry a headed request proxies normally", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    installFetchStub(
      () =>
        new Response(UPSTREAM_TEXT, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { real: leases } = installSpyRegistry(leasesMod);
    sessionsMod.setSessionRefcountRegistry(null);
    expect(sessionsMod.currentSessionRefcounts()).toBeNull();

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UPSTREAM_TEXT);
    expect(leases.active("wl-a")).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#520: no session header means no session work", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    installFetchStub(
      () =>
        new Response(UPSTREAM_TEXT, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { spy: sessions } = installSessionRefcounts(sessionsMod, () => 1_000);
    installSpyRegistry(leasesMod);

    const res = await openaiProxy.proxyOpenAI(embeddingsRequest(KV_MODEL), t.env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UPSTREAM_TEXT);
    expect(sessions.activeSessions("wl-a")).toEqual([]);
    expect(sessions.releaseCalls).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#520: a whitespace session header is treated as absent", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    installFetchStub(
      () =>
        new Response(UPSTREAM_TEXT, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { spy: sessions } = installSessionRefcounts(sessionsMod, () => 1_000);
    installSpyRegistry(leasesMod);

    // Fetch Headers strips leading and trailing whitespace, so '   '
    // reaches the proxy as ''. This pins the empty-string path, which
    // kills a `!== null` guard that would hand '' to acquire and produce
    // a 500 instead of proxying normally.
    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "   " }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UPSTREAM_TEXT);
    expect(sessions.activeSessions("wl-a")).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#520: sessions published without leases stays inert", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    installFetchStub(
      () =>
        new Response(UPSTREAM_TEXT, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    leasesMod.setResidencyLeaseRegistry(null);
    const throwing = throwingSessions();
    sessionsMod.setSessionRefcountRegistry(throwing);

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UPSTREAM_TEXT);
    expect(throwing.calls).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#520: both seams null leaves the upstream body stream untouched", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    leasesMod.setResidencyLeaseRegistry(null);
    sessionsMod.setSessionRefcountRegistry(null);

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

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("OK");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-custom")).toBe("value");

    // With both seams null nothing may interpose a stream: cancelling the
    // client body reaches the upstream stream's cancel synchronously.
    const cancelPromise = res.body!.cancel();
    expect(upstreamBodyCancelled).toBe(true);
    await cancelPromise;
  } finally {
    t.cleanup();
  }
});

test("#520: session work stays inside the lease gate", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    leasesMod.setResidencyLeaseRegistry(null);
    sessionsMod.setSessionRefcountRegistry(null);

    const baseline = await measureProxyOpenAITicks(embeddingsRequest(KV_MODEL), t.env);
    expect(baseline.res.status).toBe(200);
    expect(await baseline.res.text()).toBe(UPSTREAM_TEXT);

    // Only the sessions seam is published (a real registry) while the
    // lease seam stays null, so the header must add zero work. This
    // catches session acquire or awaits leaking outside the
    // `lease !== null` gate — it does NOT prove the change adds no
    // awaits overall; the stream-identity case above is that pin.
    const { spy: sessions } = installSessionRefcounts(sessionsMod, () => 1_000);
    const headed = await measureProxyOpenAITicks(
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(headed.res.status).toBe(200);
    expect(await headed.res.text()).toBe(UPSTREAM_TEXT);
    expect(headed.turns).toBe(baseline.turns);
    expect(sessions.activeSessions("wl-a")).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#520: an upstream failure releases the session ref", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    installFetchStub(() => Promise.reject(new TypeError("connection refused")));
    let nowMs = 1_000;
    const { spy: sessions } = installSessionRefcounts(sessionsMod, () => nowMs);
    installSpyRegistry(leasesMod);

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(res.status).toBe(502);
    await res.text();
    expect(sessions.releaseCalls).toEqual(["s1"]);
    nowMs += 1_000;
    expect(sessions.activeSessions("wl-a")).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#520: a client abort before headers releases the session exactly once", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
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
    let nowMs = 1_000;
    const { spy: sessions } = installSessionRefcounts(sessionsMod, () => nowMs);
    installSpyRegistry(leasesMod);

    const controller = new AbortController();
    const responsePromise = openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/embeddings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SESSION_HEADER]: "s1",
        },
        body: JSON.stringify({ model: KV_MODEL, input: "x" }),
        signal: controller.signal,
      }),
      t.env,
    );
    await started;
    controller.abort();
    const res = await responsePromise;
    expect(res.status).toBe(502);
    // Assert before the body settles: the 502 body is lease-bound, so
    // only the abort-path release can satisfy this ordering.
    expect(sessions.releaseCalls).toEqual(["s1"]);
    await res.text();
    expect(sessions.releaseCalls).toEqual(["s1"]);
    nowMs += 1_000;
    expect(sessions.activeSessions("wl-a")).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#520: a forced unload releases the session synchronously, exactly once", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    const upstream = gatedUpstream();
    installFetchStub(() => upstream.respond());
    let nowMs = 1_000;
    const { spy: sessions } = installSessionRefcounts(sessionsMod, () => nowMs);
    const { real: leases } = installSpyRegistry(leasesMod);

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(sessions.activeSessions("wl-a")).toEqual(["s1"]);
    expect(sessions.releaseCalls).toEqual([]);

    const drain = leases.beginDrain("wl-a");
    expect(drain.ok).toBe(true);
    if (!drain.ok) {
      throw new Error("beginDrain(wl-a) refused");
    }
    const commit = leases.commitUnload(drain.token, { force: true, reason: "test" });
    expect(commit.ok).toBe(true);
    // No await between commitUnload and this assertion: the lease signal
    // abort dispatches synchronously, so a session release wired to it is
    // already recorded. Without a lease.signal abort listener the release
    // would only happen later via settle() — or never with no read pending.
    expect(sessions.releaseCalls).toEqual(["s1"]);

    // Bound the wait: if the bound body never learns about the revocation
    // this read pends forever and the suite hangs instead of failing.
    const readResult = await Promise.race([
      reader.read().then(
        () => null,
        (error: unknown) => error,
      ),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => {
          resolve("timeout");
        }, 2_000);
      }),
    ]);
    expect(readResult).not.toBe("timeout");
    expect(readResult).toBeInstanceOf(Error);
    if (readResult instanceof Error) {
      expect(readResult.message).toContain("lease revoked: forced unload");
    }
    expect(sessions.releaseCalls).toEqual(["s1"]);
    nowMs += 1_000;
    expect(sessions.activeSessions("wl-a")).toEqual([]);
    expect(sessions.checkUnload("wl-a").ok).toBe(true);
  } finally {
    t.cleanup();
  }
});

test("#520: a late release from a request whose session was force-released cannot drop a re-acquired session", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    const upstream = gatedUpstream();
    installFetchStub(() => upstream.respond());
    const { real: sessionsReal, spy: sessions } = installSessionRefcounts(sessionsMod, () => 1_000);
    installSpyRegistry(leasesMod);

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(sessions.releaseCalls).toEqual([]);

    // Only the sessions registry is dropped: the lease and the streaming
    // body stay live, so the request's late release lands on a session
    // re-acquired under a newer generation.
    expect(sessionsReal.forceRelease("wl-a")).toEqual(["s1"]);
    expect(sessionsReal.acquire("s1", "wl-a")).toMatchObject({ ok: true, refs: 1 });

    upstream.close();
    expect(await res.text()).toBe(UPSTREAM_TEXT);
    expect(sessions.releaseCalls).toEqual(["s1"]);

    expect(sessionsReal.acquire("s1", "wl-a")).toMatchObject({ ok: true, refs: 2 });
  } finally {
    t.cleanup();
  }
});

test("#520: session ID exceeding max length returns 400", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    installFetchStub(
      () =>
        new Response(UPSTREAM_TEXT, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { spy: sessions } = installSessionRefcounts(sessionsMod, () => 1_000);
    installSpyRegistry(leasesMod);

    const longId = "s".repeat(129);
    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: longId }),
      t.env,
    );
    expect(res.status).toBe(400);
    const error = await readProxyError(res);
    expect(error.code).toBe("InvalidSessionId");
    expect(error.type).toBe("session_id_invalid");
    expect(sessions.releaseCalls).toEqual([]);
    expect(sessions.activeSessions("wl-a")).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#520: session ID with invalid characters returns 400", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    installFetchStub(
      () =>
        new Response(UPSTREAM_TEXT, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { spy: sessions } = installSessionRefcounts(sessionsMod, () => 1_000);
    installSpyRegistry(leasesMod);

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s@#$invalid" }),
      t.env,
    );
    expect(res.status).toBe(400);
    const error = await readProxyError(res);
    expect(error.code).toBe("InvalidSessionId");
    expect(error.type).toBe("session_id_invalid");
    expect(sessions.releaseCalls).toEqual([]);
    expect(sessions.activeSessions("wl-a")).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#520: session releases on 503 draining refusal", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    installFetchStub(
      () =>
        new Response(UPSTREAM_TEXT, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { spy: sessions } = installSessionRefcounts(sessionsMod, () => 1_000);
    const { spy: leases } = installSpyRegistry(leasesMod);

    sessions.acquire("s1", "wl-a");
    const drain = leases.beginDrain("wl-a");
    expect(drain.ok).toBe(true);

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(res.status).toBe(503);
    const error = await readProxyError(res);
    expect(error.code).toBe("Draining");
    expect(sessions.releaseCalls).toEqual(["s1"]);
  } finally {
    t.cleanup();
  }
});

test("#520: session releases on 503 not loaded refusal", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    installFetchStub(
      () =>
        new Response(UPSTREAM_TEXT, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { spy: sessions } = installSessionRefcounts(sessionsMod, () => 1_000);
    const { spy: leases } = installSpyRegistry(leasesMod);

    sessions.acquire("s1", "wl-a");
    const drain = leases.beginDrain("wl-a");
    expect(drain.ok).toBe(true);
    const unload = leases.commitUnload(
      (drain as unknown as { token: { workload: string; epoch: number } }).token,
    );
    expect(unload.ok).toBe(true);

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(res.status).toBe(503);
    const error = await readProxyError(res);
    expect(error.code).toBe("Unloaded");
    expect(sessions.releaseCalls).toEqual(["s1"]);
  } finally {
    t.cleanup();
  }
});

test("#520: a peer-routed session request holds no refcount and does not poison the id", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
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
    installFetchStub(
      () =>
        new Response(UPSTREAM_TEXT, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { spy: sessions } = installSessionRefcounts(sessionsMod, () => 1_000);
    const { acquireWorkloads } = installSpyRegistry(leasesMod);

    // Peer routes carry a workload id but bypass both seams: no lease
    // acquire and no session refcount may be taken for them.
    const peerRes = await openaiProxy.proxyOpenAI(
      embeddingsRequest("peer-only/model.gguf", { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(peerRes.status).toBe(200);
    expect(await peerRes.text()).toBe(UPSTREAM_TEXT);
    expect(acquireWorkloads).toEqual([]);
    expect(sessions.releaseCalls).toEqual([]);
    expect(sessions.activeSessions("peer-a:peer-only/model.gguf")).toEqual([]);

    // A leaked peer-side ref would bind s1 to the peer workload and turn
    // this local request into a 409 AffinityConflict.
    const localRes = await openaiProxy.proxyOpenAI(
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(localRes.status).toBe(200);
    expect(await localRes.text()).toBe(UPSTREAM_TEXT);
    expect(sessions.releaseCalls).toEqual(["s1"]);
  } finally {
    t.cleanup();
  }
});

test("#520: a null-body response releases the session ref exactly once", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    installFetchStub(() => new Response(null, { status: 204 }));
    const { spy: sessions } = installSessionRefcounts(sessionsMod, () => 1_000);
    const { real: leases } = installSpyRegistry(leasesMod);

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    // No body means nothing is handed to bindLeaseToBody: the finally must
    // release the session even though a lease was held.
    expect(sessions.releaseCalls).toEqual(["s1"]);
    expect(leases.active("wl-a")).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#520: a forward throw releases the session ref exactly once", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
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
    const { spy: sessions } = installSessionRefcounts(sessionsMod, () => 1_000);
    const { real: leases } = installSpyRegistry(leasesMod);

    let rejection: unknown = null;
    try {
      await openaiProxy.proxyOpenAI(embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s1" }), t.env);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect(sessions.releaseCalls).toEqual(["s1"]);
    expect(leases.active("wl-a")).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#278: bindLeaseToBody fires onSettle exactly once when abort races a pending read", async () => {
  const leasesMod = await loadLeaseModule();
  const real = leasesMod.createResidencyLeases();
  const acquired = real.acquire("wl-bind");
  if (!acquired.ok) {
    throw new Error("acquire(wl-bind) refused");
  }
  const lease = acquired.lease;

  // The upstream never produces data, so the bound stream's first pull is
  // parked on reader.read() when the forced unload lands.
  const upstream = new ReadableStream<Uint8Array>();
  let settleCalls = 0;
  const bound = leasesMod.bindLeaseToBody(upstream, lease, () => {
    settleCalls += 1;
  });
  const reader = bound.getReader();
  const pendingRead = reader.read();
  // Let pull() reach its pending upstream read before revoking.
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  const drain = real.beginDrain("wl-bind");
  if (!drain.ok) {
    throw new Error("beginDrain(wl-bind) refused");
  }
  expect(real.commitUnload(drain.token, { force: true })).toEqual({
    ok: true,
    revoked: [lease.id],
  });
  // Abort dispatch is synchronous: the abort path has already fired
  // onSettle once. A second call here means the listener does not guard
  // onSettle itself.
  expect(settleCalls).toBe(1);

  // The cancelled upstream read resolves done and runs settle(); the
  // once-flag must keep onSettle at exactly one call across both paths.
  const readResult = await Promise.race([
    pendingRead.then(
      () => null,
      (error: unknown) => error,
    ),
    new Promise<"timeout">((resolve) => {
      setTimeout(() => {
        resolve("timeout");
      }, 2_000);
    }),
  ]);
  expect(readResult).not.toBe("timeout");
  expect(readResult).toBeInstanceOf(Error);
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  expect(settleCalls).toBe(1);
});

async function readBoundError(stream: ReadableStream<Uint8Array>): Promise<unknown> {
  const reader = stream.getReader();
  return await Promise.race([
    reader.read().then(
      () => null,
      (error: unknown) => error,
    ),
    new Promise<"timeout">((resolve) => {
      setTimeout(() => {
        resolve("timeout");
      }, 2_000);
    }),
  ]);
}

test("#520: bindLeaseToBody settles exactly once when the lease was revoked before binding", async () => {
  const leasesMod = await loadLeaseModule();
  const real = leasesMod.createResidencyLeases();
  const acquired = real.acquire("wl-prebind");
  if (!acquired.ok) {
    throw new Error("acquire(wl-prebind) refused");
  }
  const lease = acquired.lease;
  const drain = real.beginDrain("wl-prebind");
  if (!drain.ok) {
    throw new Error("beginDrain(wl-prebind) refused");
  }
  expect(real.commitUnload(drain.token, { force: true })).toEqual({
    ok: true,
    revoked: [lease.id],
  });
  expect(lease.signal.aborted).toBe(true);

  // The abort already dispatched, so only a bind-time check can settle.
  let settleCalls = 0;
  const bound = leasesMod.bindLeaseToBody(
    new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(new TextEncoder().encode(UPSTREAM_TEXT));
      },
    }),
    lease,
    () => {
      settleCalls += 1;
    },
  );
  expect(settleCalls).toBe(1);

  const readResult = await readBoundError(bound);
  expect(readResult).not.toBe("timeout");
  expect(readResult).toBeInstanceOf(Error);
  expect((readResult as Error).message).toContain("lease revoked");
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  expect(settleCalls).toBe(1);
});

test("#520: a lease revoked between forward and bind releases the session ref exactly once", async () => {
  const t = tempKvEnv();
  try {
    const sessionsMod = await loadSessionsModule();
    const leasesMod = await loadLeaseModule();
    writeLocalModelRunWorkload(t.root, "wl-a", WL_A_PORT);
    const { spy: sessions } = installSessionRefcounts(sessionsMod, () => 1_000);
    const { real: leases } = installSpyRegistry(leasesMod);
    let revoked: string[] = [];
    // The stub ignores the composed abort signal: it builds the upstream
    // response, then a forced unload lands before the proxy binds the body,
    // so bindLeaseToBody receives an already-aborted lease.
    installFetchStub(() => {
      const upstream = new Response(UPSTREAM_TEXT, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      const drain = leases.beginDrain("wl-a");
      if (!drain.ok) {
        throw new Error("beginDrain(wl-a) refused");
      }
      const unload = leases.commitUnload(drain.token, { force: true });
      if (unload.ok) revoked = unload.revoked;
      return upstream;
    });

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(KV_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(revoked).toHaveLength(1);
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();
    // Settled at bind time, before the body is consumed.
    expect(sessions.releaseCalls).toEqual(["s1"]);

    const readResult = await readBoundError(res.body as ReadableStream<Uint8Array>);
    expect(readResult).not.toBe("timeout");
    expect(readResult).toBeInstanceOf(Error);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(sessions.releaseCalls).toEqual(["s1"]);
    expect(leases.active("wl-a")).toEqual([]);
  } finally {
    t.cleanup();
  }
});
