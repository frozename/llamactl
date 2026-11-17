import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelHostReadiness } from "../src/engines/types.js";
import type { ResidencyLeases } from "../src/residency/leases.js";
import type { SessionRefcounts } from "../src/residency/sessions.js";
import type { ResolvedEnv } from "../src/types.js";
import type { PeerSnapshot } from "../src/workloadRuntime.js";

import { writeModelHostState } from "../src/engines/state.js";
import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { createResidencyLeases, setResidencyLeaseRegistry } from "../src/residency/leases.js";
import { createSessionRefcounts, setSessionRefcountRegistry } from "../src/residency/sessions.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

// #520 session-affinity routing: a headed request must prefer the workload
// its session is bound to, scanned in candidate order, still gated by the
// same declared serving-readiness verdicts and still requiring both seams.
// Every case below fails by assertion at the pinned base — the binding
// lookup does not exist yet, so bound sessions hit the 409 AffinityConflict
// (or never consult the registry) instead of sticking to their workload.

const originalFetch = globalThis.fetch;

afterEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  openaiProxy.__setOpenAIProxyServingReadinessForTests(null);
  openaiProxy.__setOpenAIProxyClusterRoutingForTests({});
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

const AFF_MODEL = "Affinity-GGUF/affinity-Q4_K_M.gguf";
const PORT_A = 19631;
const PORT_B = 19632;
const PORT_C = 19633;
const PEER_PORT = 7843;
const UPSTREAM_TEXT = '{"embeddings":{"x":[0.1,0.2]}}';
const SESSION_HEADER = "x-llamactl-session";

function tempKvEnv(): { root: string; env: ResolvedEnv; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-affinity-"));
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

function writeModelRun(
  runtimeRoot: string,
  workload: string,
  port: number,
  rel: string,
  opts?: { extraArgs?: string[]; readiness?: ModelHostReadiness },
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
      extraArgs: opts?.extraArgs ?? [],
      slotSavePath: slotDir,
      host: "127.0.0.1",
      port,
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-05-24T00:00:00.000Z",
      tunedProfile: null,
      ...(opts?.readiness !== undefined ? { readiness: opts.readiness } : {}),
    }),
  );
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

const EXPERIMENTAL_CATALOG_TSV =
  'exp-model\tExp test\texp\tcustom\tcustom\texp/model.gguf\torg/exp\tgguf\t{"qualification":{"stage":"experimental"}}\n';

const writeExperimentalCatalog = (dir: string): void => {
  writeFileSync(join(dir, "curated-models.tsv"), EXPERIMENTAL_CATALOG_TSV);
};

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

const okUpstream = (): Response =>
  new Response(UPSTREAM_TEXT, {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function embeddingsRequest(model: string, extraHeaders?: Record<string, string>): Request {
  return new Request("http://localhost/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ model, input: "x" }),
  });
}

async function readProxyError(res: Response): Promise<{
  type?: string | undefined;
  code?: string | undefined;
  message?: string | undefined;
}> {
  const body = (await res.json()) as {
    error?: { type?: string; code?: string; message?: string };
  };
  return body.error ?? {};
}

type SessionSpy = SessionRefcounts & { activeSessionsCalls: string[] };

function installSessionSpy(now: () => number): { real: SessionRefcounts; spy: SessionSpy } {
  const real = createSessionRefcounts({ idleTimeoutMs: 1_000, now });
  const activeSessionsCalls: string[] = [];
  const spy: SessionSpy = {
    acquire: (sessionId, workload) => real.acquire(sessionId, workload),
    release: (sessionId, generation) => {
      real.release(sessionId, generation);
    },
    touch: (sessionId) => {
      real.touch(sessionId);
    },
    forceRelease: (workload) => real.forceRelease(workload),
    activeSessions: (workload) => {
      activeSessionsCalls.push(workload);
      return real.activeSessions(workload);
    },
    checkUnload: (workload, opts) => real.checkUnload(workload, opts),
    activeSessionsCalls,
  };
  setSessionRefcountRegistry(spy);
  return { real, spy };
}

type LeaseSpy = ResidencyLeases & { acquireCalls: string[] };

function makeLeaseSpy(): { real: ResidencyLeases; spy: LeaseSpy; acquireCalls: string[] } {
  const real = createResidencyLeases();
  const acquireCalls: string[] = [];
  const spy: LeaseSpy = {
    acquire: (workload) => {
      acquireCalls.push(workload);
      return real.acquire(workload);
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
    acquireCalls,
  };
  return { real, spy, acquireCalls };
}

function installLeaseSpy(): { real: ResidencyLeases; spy: LeaseSpy; acquireCalls: string[] } {
  const made = makeLeaseSpy();
  setResidencyLeaseRegistry(made.spy);
  return made;
}

function bindSession(real: SessionRefcounts, sessionId: string, workload: string): void {
  const result = real.acquire(sessionId, workload);
  if (result.ok) real.release(sessionId, result.generation);
}

function throwingSessions(): SessionRefcounts & { calls: string[] } {
  const calls: string[] = [];
  const boom = (name: string): never => {
    calls.push(name);
    throw new Error(`sessions.${name} must not be called`);
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

interface ProbeCall {
  url: string;
  port: number;
  pathname: string;
}

function installReadinessProbe(
  respond: (call: ProbeCall) => Response | Promise<Response>,
  onFirstCall?: () => void,
): { calls: ProbeCall[] } {
  const calls: ProbeCall[] = [];
  let firstCall = true;
  const probe = (async (input: Request | URL | string) => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    const call: ProbeCall = { url: raw, port: Number(url.port), pathname: url.pathname };
    calls.push(call);
    if (firstCall) {
      firstCall = false;
      onFirstCall?.();
    }
    return await respond(call);
  }) as unknown as typeof fetch;
  openaiProxy.__setOpenAIProxyServingReadinessForTests({ fetch: probe });
  return { calls };
}

test("#520 A1: a session keeps its workload across tool calls when a higher-priority replica appears", async () => {
  // Kills: no affinity preference — once wl-a sorts first, the bound s1
  // request resolves to wl-a and dies on the 409 AffinityConflict.
  const t = tempKvEnv();
  try {
    writeModelRun(t.root, "wl-b", PORT_B, AFF_MODEL);
    const counts = installFetchStub(okUpstream);
    const { real: sessionsReal } = installSessionSpy(() => 1_000);
    installLeaseSpy();

    const first = await openaiProxy.proxyOpenAI(
      embeddingsRequest(AFF_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(UPSTREAM_TEXT);

    writeModelRun(t.root, "wl-a", PORT_A, AFF_MODEL);
    openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();

    const headerless = await openaiProxy.proxyOpenAI(embeddingsRequest(AFF_MODEL), t.env);
    expect(headerless.status).toBe(200);
    expect(await headerless.text()).toBe(UPSTREAM_TEXT);

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(AFF_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UPSTREAM_TEXT);
    expect(counts.byPort.get(PORT_A) ?? 0).toBe(1);
    expect(counts.byPort.get(PORT_B) ?? 0).toBe(2);
    expect(sessionsReal.activeSessions("wl-b")).toEqual(["s1"]);
  } finally {
    t.cleanup();
  }
});

test("#520 A2: the binding lookup runs only for session requests, in route order", async () => {
  // Kills: the lookup running for headerless requests, and no affinity
  // preference (at base the s1 request conflicts 409 and calls stay []).
  const t = tempKvEnv();
  try {
    writeModelRun(t.root, "wl-a", PORT_A, AFF_MODEL);
    writeModelRun(t.root, "wl-b", PORT_B, AFF_MODEL);
    const counts = installFetchStub(okUpstream);
    const { real: sessionsReal, spy: sessions } = installSessionSpy(() => 1_000);
    bindSession(sessionsReal, "s1", "wl-b");
    installLeaseSpy();

    const headerless = await openaiProxy.proxyOpenAI(embeddingsRequest(AFF_MODEL), t.env);
    expect(headerless.status).toBe(200);
    expect(await headerless.text()).toBe(UPSTREAM_TEXT);
    expect(counts.byPort.get(PORT_A) ?? 0).toBe(1);
    expect(sessions.activeSessionsCalls).toEqual([]);

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(AFF_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UPSTREAM_TEXT);
    expect(counts.byPort.get(PORT_B) ?? 0).toBe(1);
    expect(sessions.activeSessionsCalls).toEqual(["wl-a", "wl-b"]);
  } finally {
    t.cleanup();
  }
});

test("#520 A3 GUARD G4: affinity never routes to a not-ready bound workload", async () => {
  // Kills: 'preferred candidate skips the readiness verdict' — that mutant
  // forwards the session request to the warming bound replica (200 on B).
  const t = tempKvEnv();
  try {
    writeModelRun(t.root, "wl-a", PORT_A, AFF_MODEL);
    writeModelRun(t.root, "wl-b", PORT_B, AFF_MODEL, { readiness: { path: "/ready" } });
    const counts = installFetchStub(okUpstream);
    const { real: sessionsReal } = installSessionSpy(() => 1_000);
    bindSession(sessionsReal, "s1", "wl-b");
    const { real: leases } = installLeaseSpy();
    const probe = installReadinessProbe(() =>
      Response.json({ status: "loading" }, { status: 503 }),
    );

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(AFF_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(res.status).toBe(409);
    const error = await readProxyError(res);
    expect(error.code).toBe("AffinityConflict");
    expect(error.type).toBe("session_affinity_conflict");
    expect(error.message).toContain("bound to wl-b");
    expect(counts.byPort.get(PORT_B) ?? 0).toBe(0);
    expect(counts.byPort.get(PORT_A) ?? 0).toBe(0);
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.pathname).toBe("/ready");
    expect(probe.calls[0]?.port).toBe(PORT_B);
    expect(leases.active("wl-a")).toEqual([]);
    expect(leases.active("wl-b")).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#520 A4: a ready bound workload receives the session request", async () => {
  // Kills: the preference ignoring a passing readiness verdict — the request
  // falls back to wl-a and conflicts (409 at base).
  const t = tempKvEnv();
  try {
    writeModelRun(t.root, "wl-a", PORT_A, AFF_MODEL);
    writeModelRun(t.root, "wl-b", PORT_B, AFF_MODEL, { readiness: { path: "/ready" } });
    const counts = installFetchStub(okUpstream);
    const { real: sessionsReal } = installSessionSpy(() => 1_000);
    bindSession(sessionsReal, "s1", "wl-b");
    installLeaseSpy();
    const probe = installReadinessProbe(() => Response.json({ status: "ready" }));

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest(AFF_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UPSTREAM_TEXT);
    expect(counts.byPort.get(PORT_B) ?? 0).toBe(1);
    expect(counts.byPort.get(PORT_A) ?? 0).toBe(0);
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.pathname).toBe("/ready");
    expect(probe.calls[0]?.port).toBe(PORT_B);
  } finally {
    t.cleanup();
  }
});

test("#520 A5: a bound session stays on its experimental workload (affinity wins over #518 ordering)", async () => {
  // Kills: the lookup restricted to non-experimental candidates, or applied
  // after the #518 fallback filter — both drop a-exp and conflict on
  // stable-host (409 at base).
  const t = tempKvEnv();
  try {
    writeExperimentalCatalog(t.root);
    writeModelHost(t.env, "stable-host", { port: PORT_A, aliases: ["shared-alias"] });
    writeModelRun(t.root, "a-exp", PORT_B, "exp/model.gguf", {
      extraArgs: ["--alias", "shared-alias"],
    });
    const counts = installFetchStub(okUpstream);
    const { real: sessionsReal } = installSessionSpy(() => 1_000);
    bindSession(sessionsReal, "s1", "a-exp");
    installLeaseSpy();

    const headerless = await openaiProxy.proxyOpenAI(embeddingsRequest("shared-alias"), t.env);
    expect(headerless.status).toBe(200);
    expect(await headerless.text()).toBe(UPSTREAM_TEXT);
    expect(counts.byPort.get(PORT_A) ?? 0).toBe(1);

    const unbound = await openaiProxy.proxyOpenAI(
      embeddingsRequest("shared-alias", { [SESSION_HEADER]: "s2" }),
      t.env,
    );
    expect(unbound.status).toBe(200);
    expect(await unbound.text()).toBe(UPSTREAM_TEXT);
    expect(sessionsReal.activeSessions("stable-host")).toEqual(["s2"]);

    const res = await openaiProxy.proxyOpenAI(
      embeddingsRequest("shared-alias", { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UPSTREAM_TEXT);
    expect(counts.byPort.get(PORT_A) ?? 0).toBe(2);
    expect(counts.byPort.get(PORT_B) ?? 0).toBe(1);
    expect(sessionsReal.activeSessions("a-exp")).toEqual(["s1"]);
  } finally {
    t.cleanup();
  }
});

test("#520 A6: peer candidates are never consulted for a binding", async () => {
  // Kills: the lookup including peer candidates — a peer route whose
  // workload key matches the binding would be preferred, and peer ids would
  // pollute activeSessionsCalls (at base calls stay [] and s2 goes peer).
  const t = tempKvEnv();
  try {
    writeExperimentalCatalog(t.root);
    openaiProxy.__setOpenAIProxyClusterRoutingForTests({
      clusterPeers: [{ id: "peer-a", endpoint: `https://peer-a.local:${String(PEER_PORT)}` }],
      peerSnapshots: new Map<string, PeerSnapshot>([
        [
          "peer-a",
          {
            workloads: [
              {
                modelId: "exp/model.gguf",
                port: 9333,
                labels: { "llamactl.io/qualification": "validated" },
              },
            ],
            pressure: "NORMAL",
            fetchedAt: Date.now(),
          },
        ],
      ]),
    });
    writeModelRun(t.root, "wl-x", PORT_C, "exp/model.gguf");
    const counts = installFetchStub(okUpstream);
    const { real: sessionsReal, spy: sessions } = installSessionSpy(() => 1_000);
    installLeaseSpy();

    bindSession(sessionsReal, "s1", "peer-a:exp/model.gguf");
    const peerBound = await openaiProxy.proxyOpenAI(
      embeddingsRequest("exp/model.gguf", { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(peerBound.status).toBe(200);
    expect(await peerBound.text()).toBe(UPSTREAM_TEXT);
    expect(sessions.activeSessionsCalls).toEqual(["wl-x"]);
    expect(counts.byPort.get(PEER_PORT) ?? 0).toBe(1);
    expect(counts.byPort.get(PORT_C) ?? 0).toBe(0);

    bindSession(sessionsReal, "s2", "wl-x");
    const localBound = await openaiProxy.proxyOpenAI(
      embeddingsRequest("exp/model.gguf", { [SESSION_HEADER]: "s2" }),
      t.env,
    );
    expect(localBound.status).toBe(200);
    expect(await localBound.text()).toBe(UPSTREAM_TEXT);
    expect(sessions.activeSessionsCalls).toEqual(["wl-x", "wl-x"]);
    expect(counts.byPort.get(PORT_C) ?? 0).toBe(1);
  } finally {
    t.cleanup();
  }
});

test("#520 A7: affinity is released by the idle timeout", async () => {
  // Kills: a binding outliving idle expiry — at clock 2500 the pruned s1
  // entry would still prefer wl-b instead of re-binding to wl-a.
  const t = tempKvEnv();
  try {
    writeModelRun(t.root, "wl-a", PORT_A, AFF_MODEL);
    writeModelRun(t.root, "wl-b", PORT_B, AFF_MODEL);
    const counts = installFetchStub(okUpstream);
    const clock = { now: 1_000 };
    const { real: sessionsReal } = installSessionSpy(() => clock.now);
    installLeaseSpy();
    bindSession(sessionsReal, "s1", "wl-b");

    clock.now = 1_500;
    const mid = await openaiProxy.proxyOpenAI(
      embeddingsRequest(AFF_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(mid.status).toBe(200);
    expect(await mid.text()).toBe(UPSTREAM_TEXT);
    expect(counts.byPort.get(PORT_B) ?? 0).toBe(1);

    clock.now = 2_500;
    const late = await openaiProxy.proxyOpenAI(
      embeddingsRequest(AFF_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(late.status).toBe(200);
    expect(await late.text()).toBe(UPSTREAM_TEXT);
    expect(counts.byPort.get(PORT_A) ?? 0).toBe(1);
    expect(counts.byPort.get(PORT_B) ?? 0).toBe(1);
    expect(sessionsReal.activeSessions("wl-a")).toEqual(["s1"]);
  } finally {
    t.cleanup();
  }
});

test("#520 A8: affinity stays inert unless both seams are installed", async () => {
  // Kills: the lookup running with only the sessions seam installed — the
  // throwing stub must see zero calls while the lease registry is absent.
  const t = tempKvEnv();
  try {
    writeModelRun(t.root, "wl-a", PORT_A, AFF_MODEL);
    writeModelRun(t.root, "wl-b", PORT_B, AFF_MODEL);
    const counts = installFetchStub(okUpstream);
    setResidencyLeaseRegistry(null);
    const throwing = throwingSessions();
    setSessionRefcountRegistry(throwing);

    const first = await openaiProxy.proxyOpenAI(
      embeddingsRequest(AFF_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(UPSTREAM_TEXT);
    expect(counts.byPort.get(PORT_A) ?? 0).toBe(1);
    expect(throwing.calls).toEqual([]);

    setResidencyLeaseRegistry(createResidencyLeases());
    const { real: sessionsReal } = installSessionSpy(() => 1_000);
    bindSession(sessionsReal, "s1", "wl-b");

    const second = await openaiProxy.proxyOpenAI(
      embeddingsRequest(AFF_MODEL, { [SESSION_HEADER]: "s1" }),
      t.env,
    );
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(UPSTREAM_TEXT);
    expect(counts.byPort.get(PORT_B) ?? 0).toBe(1);
    expect(sessionsReal.activeSessions("wl-b")).toEqual(["s1"]);
  } finally {
    t.cleanup();
  }
});

test("#520 A9(a): the lease seam is read once per request, before route resolution", async () => {
  // Kills: 'acquireProxyResidencyLease re-reads getResidencyLeaseRegistry()'
  // — the readiness probe swaps the published registry mid-resolution, and
  // the post-resolution re-read would lease through L2 instead of L1.
  const t = tempKvEnv();
  try {
    writeModelRun(t.root, "wl-b", PORT_B, AFF_MODEL, { readiness: { path: "/ready" } });
    const counts = installFetchStub(okUpstream);
    const l1 = installLeaseSpy();
    const l2 = makeLeaseSpy();
    installReadinessProbe(
      () => Response.json({ status: "ready" }),
      () => {
        setResidencyLeaseRegistry(l2.spy);
      },
    );

    const res = await openaiProxy.proxyOpenAI(embeddingsRequest(AFF_MODEL), t.env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UPSTREAM_TEXT);
    expect(counts.byPort.get(PORT_B) ?? 0).toBe(1);
    expect(l1.acquireCalls).toEqual(["wl-b"]);
    expect(l2.acquireCalls).toEqual([]);
  } finally {
    t.cleanup();
  }
});

test("#520 A9(b): the sessions seam is read once per request, before route resolution", async () => {
  // Kills: 'the sessions seam is read after route resolution' — the probe
  // swaps in a throwing registry mid-resolution; the registry captured
  // before resolution must still serve the acquire.
  const t = tempKvEnv();
  try {
    writeModelRun(t.root, "wl-b", PORT_B, AFF_MODEL, { readiness: { path: "/ready" } });
    const counts = installFetchStub(okUpstream);
    setResidencyLeaseRegistry(createResidencyLeases());
    const { real: sessionsReal } = installSessionSpy(() => 1_000);
    const throwing = throwingSessions();
    installReadinessProbe(
      () => Response.json({ status: "ready" }),
      () => {
        setSessionRefcountRegistry(throwing);
      },
    );

    let res: Response;
    try {
      res = await openaiProxy.proxyOpenAI(
        embeddingsRequest(AFF_MODEL, { [SESSION_HEADER]: "s1" }),
        t.env,
      );
    } catch {
      res = new Response("proxyOpenAI threw", { status: 500 });
    }
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UPSTREAM_TEXT);
    expect(counts.byPort.get(PORT_B) ?? 0).toBe(1);
    expect(throwing.calls).toEqual([]);
    expect(sessionsReal.activeSessions("wl-b")).toEqual(["s1"]);
  } finally {
    t.cleanup();
  }
});
