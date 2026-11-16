/**
 * Part of #316 — propagate a client abort to the peer node's engine.
 *
 * The via:local chat path runs POST /v1/chat/completions →
 * handleRagChatCompletions → an in-process appRouter.createCaller →
 * chatComplete's non-admitted inproc://local branch →
 * dispatchProxyRequest → openaiProxy.forward → the engine fetch. Two
 * seams must both carry the abort or it dies in-process:
 *
 *   1. resolveCaller builds the tRPC caller. It must hand the inbound
 *      request's signal to createCaller as its options arg, or the
 *      chatComplete procedure sees signal === undefined. (M2 —
 *      createCaller({}) without the request signal.)
 *   2. chatComplete's non-admitted inproc://local branch builds the
 *      dispatch Request by hand; it must forward the procedure signal
 *      so proxyOpenAI's forward() can compose it into the upstream
 *      fetch. (M1 — the signal deleted from that Request.)
 *
 * openaiProxy.forward already composes context.req.signal into the
 * upstream fetch (#321), so once both seams carry it, aborting the
 * client fetch aborts the engine's in-flight request.
 *
 * The fake engine parks every POST /v1/chat/completions behind a gate
 * and records arrived / abortedAtMs / settled per request; its
 * server-side req.signal 'abort' listener resolves the pending response
 * 499 — the same observable the residency ingress-admission fake
 * upstream uses.
 */
import type { RequestQueueLimits } from "@llamactl/core/residency/queue-policy";

import { saveConfig } from "@llamactl/core/config/kubeconfig";
import { freshConfig } from "@llamactl/core/config/schema";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config as kubecfg } from "../src/index.js";
import { __setSharedUnifiedProxyForTests } from "../src/proxy/create-proxy.js";
import {
  createRequestAdmission,
  type RequestAdmission,
} from "../src/residency/request-admission.js";
import { router as appRouter } from "../src/router.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import { generateToken } from "../src/server/auth.js";
import { type RunningAgent, startAgentServer } from "../src/server/serve.js";

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_MODELS",
  "LLAMA_CPP_HOST",
  "LLAMA_CPP_PORT",
  "LLAMACTL_UNIFIED_PROXY",
  "LLAMACTL_CONFIG",
  "LLAMACTL_USAGE_DIR",
] as const;

const ADMISSION_LIMITS: RequestQueueLimits = {
  maxExecutions: 1,
  maxQueued: 1,
  maxQueuedBytes: 1_048_576,
  maxQueueWaitMs: 30_000,
  maxPerPrincipal: 10,
  starvationBoundMs: 30_000,
  maxContextTokens: Number.MAX_SAFE_INTEGER,
  retryAfterMs: 2_500,
};

const ABORT_BUDGET_MS = 500;

/** Poll `pred` every 10ms until it holds or the deadline passes. */
async function waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(10);
  }
}

// ── Request bodies ────────────────────────────────────────────────────────
// A monotonic counter keeps every message unique so no deterministic
// cache can ever answer a repeat.

let bodySeq = 0;

function nextText(): string {
  bodySeq += 1;
  return `hi ${String(bodySeq)}`;
}

function chatRequest(): { model: string; messages: { role: string; content: string }[] } {
  return {
    model: "no-such-model",
    messages: [{ role: "user", content: nextText() }],
  };
}

function viaLocalBody(): string {
  return JSON.stringify({
    model: "no-such-model",
    via: "local",
    messages: [{ role: "user", content: nextText() }],
  });
}

// ── Fake engine ───────────────────────────────────────────────────────────

interface EngineGate {
  /** Resolve the parked request with the JSON completion at 200. */
  release: () => void;
  /** Resolve the parked request as a client abort (499). */
  abort: () => void;
}

interface EngineRequestRecord {
  /** Arrival timestamp (ms). */
  arrived: number;
  /** Set when the server-side req.signal fires 'abort'; the gated response then resolves 499. */
  abortedAtMs: number | null;
  /** True once the gated response has been resolved (release or abort). */
  settled: boolean;
}

interface FakeEngine {
  readonly port: number;
  /** One record per POST /v1/chat/completions the engine has seen, oldest first. */
  readonly requests: readonly EngineRequestRecord[];
  /** Live per-request gates, oldest first; settled ones drop out. */
  readonly gates: readonly EngineGate[];
  hits(): number;
  abortedCount(): number;
  lastAbortedAtMs(): number | null;
  stop(): Promise<void>;
}

const COMPLETION_JSON = JSON.stringify({
  id: "chatcmpl-via-abort",
  object: "chat.completion",
  created: 0,
  model: "no-such-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "hi" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 1 },
});

/**
 * Fake llama-server: parks every POST /v1/chat/completions behind a
 * per-request gate. release() resolves the JSON body at 200; a client
 * abort (the server-side req.signal 'abort' event) stamps abortedAtMs
 * and resolves 499 so the gate never leaks.
 */
function startFakeEngine(): FakeEngine {
  const requests: EngineRequestRecord[] = [];
  const gates: EngineGate[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req: Request): Promise<Response> | Response {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/v1/models") {
        return Response.json({ object: "list", data: [] });
      }
      if (req.method !== "POST" || path !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      const record: EngineRequestRecord = {
        arrived: Date.now(),
        abortedAtMs: null,
        settled: false,
      };
      requests.push(record);
      return new Promise<Response>((resolve) => {
        const finish = (res: Response): void => {
          if (record.settled) return;
          record.settled = true;
          const at = gates.indexOf(gate);
          if (at !== -1) gates.splice(at, 1);
          resolve(res);
        };
        const onAbort = (): void => {
          record.abortedAtMs = Date.now();
          finish(new Response(null, { status: 499 }));
        };
        const gate: EngineGate = {
          release: (): void => {
            finish(
              new Response(COMPLETION_JSON, {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          },
          abort: onAbort,
        };
        gates.push(gate);
        if (req.signal.aborted) {
          onAbort();
        } else {
          req.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    },
  });

  return {
    port: server.port ?? 0,
    requests,
    gates,
    hits: () => requests.length,
    abortedCount: () => requests.filter((r) => r.abortedAtMs !== null).length,
    lastAbortedAtMs: (): number | null => {
      const aborted = requests.filter((r) => r.abortedAtMs !== null);
      return aborted.at(-1)?.abortedAtMs ?? null;
    },
    stop: () => server.stop(true),
  };
}

function latestGate(engine: FakeEngine): EngineGate {
  const gate = engine.gates.at(-1);
  if (gate === undefined) throw new Error("engine never saw a request");
  return gate;
}

// ── counted admission ─────────────────────────────────────────────────────

/** Wraps an admission so every acquire() and release() invocation is counted. */
function countedAdmission(admission: RequestAdmission): {
  admission: RequestAdmission;
  acquires: () => number;
  releases: () => number;
} {
  let acquires = 0;
  let releases = 0;
  return {
    acquires: () => acquires,
    releases: () => releases,
    admission: {
      acquire: async (request, options) => {
        acquires += 1;
        const release = await admission.acquire(request, options);
        return () => {
          releases += 1;
          release();
        };
      },
      snapshot: () => admission.snapshot(),
    },
  };
}

type Opts = Parameters<typeof startAgentServer>[0];

describe("#316: a client abort on via:local chat reaches the engine", () => {
  let dir = "";
  let engine: FakeEngine;
  let agent: RunningAgent | null = null;
  let admission: RequestAdmission;
  let token = "";
  let tokenHash = "";
  const savedEnv = new Map<string, string | undefined>();

  function startAgent(withAdmission: boolean, override?: RequestAdmission): RunningAgent {
    const adm = override ?? admission;
    const options: Opts = {
      tokenHash,
      advertiseMdns: false,
      ...(withAdmission ? { chatCompletionsAdmission: adm } : {}),
    };
    agent = startAgentServer(options);
    return agent;
  }

  function authedHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    };
  }

  function postViaLocal(opts?: { signal?: AbortSignal }): Promise<Response> {
    return fetch(`${agent!.url}/v1/chat/completions`, {
      method: "POST",
      headers: authedHeaders(),
      body: viaLocalBody(),
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llamactl-rag-via-abort-"));
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    engine = startFakeEngine();
    process.env["DEV_STORAGE"] = join(dir, "dev-storage");
    process.env["LOCAL_AI_RUNTIME_DIR"] = join(dir, "runtime");
    process.env["LLAMA_CPP_MODELS"] = join(dir, "models");
    process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
    process.env["LLAMA_CPP_PORT"] = String(engine.port);
    process.env["LLAMACTL_USAGE_DIR"] = join(dir, "usage");
    const configPath = join(dir, "config.yaml");
    process.env["LLAMACTL_CONFIG"] = configPath;
    saveConfig(freshConfig(), configPath);
    // The legacy openaiProxy.proxyOpenAI path — the unified proxy is a
    // separate dispatch the issue does not cover.
    Reflect.deleteProperty(process.env, "LLAMACTL_UNIFIED_PROXY");
    const generated = generateToken();
    token = generated.token;
    tokenHash = generated.hash;
    admission = createRequestAdmission({
      limits: ADMISSION_LIMITS,
      load: () => Promise.resolve(),
    });
  });

  afterEach(async () => {
    // Abort leftover gates rather than releasing them: a parked call
    // must reject, not resolve a fabricated 200 that would queue a
    // usage write after the env restore below.
    for (const gate of [...engine.gates]) gate.abort();
    await agent?.stop();
    agent = null;
    await engine.stop();
    rmSync(dir, { recursive: true, force: true });
    __setSharedUnifiedProxyForTests(null);
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  // ── fixture pin ────────────────────────────────────────────────────────

  // Pin: the temp kubeconfig's "local" node resolves to the in-process
  // endpoint, so every case below exercises the inproc://local branch
  // rather than a remote provider.
  test("(v0) pin: node 'local' resolves to inproc://local", () => {
    const resolved = kubecfg.resolveNode(kubecfg.loadConfig(), "local");
    expect(resolved.node.endpoint).toBe("inproc://local");
  });

  // ── RED cases ──────────────────────────────────────────────────────────

  // Kills M1: the signal deleted from the Request built in router.ts
  // chatComplete's non-admitted inproc://local branch. With ctx {} the
  // caller takes that branch; at base the Request carries no signal, so
  // the abort never reaches dispatchProxyRequest and the engine's
  // in-flight request is never cancelled — lastAbortedAtMs stays null
  // and the waitFor returns false.
  test("router chatComplete inproc://local carries the caller signal to the engine", async () => {
    const ac = new AbortController();
    const caller = appRouter.createCaller({}, { signal: ac.signal });
    const pending = caller.chatComplete({
      node: "local",
      request: chatRequest(),
    });
    void pending.catch(() => undefined);
    expect(await waitFor(() => engine.hits() > 0)).toBe(true);

    const t0 = Date.now();
    ac.abort();
    expect(await waitFor(() => engine.lastAbortedAtMs() !== null, ABORT_BUDGET_MS)).toBe(true);
    const abortedAtMs = engine.lastAbortedAtMs();
    expect(abortedAtMs).not.toBeNull();
    if (abortedAtMs !== null) {
      expect(abortedAtMs - t0).toBeLessThanOrEqual(ABORT_BUDGET_MS);
    }
    const outcome = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(outcome).not.toBeNull();
  }, 15_000);

  // Kills M2: resolveCaller building the tRPC caller with
  // createCaller({}) and no request signal — the chatComplete
  // procedure then sees signal === undefined, so the abort dies before
  // the engine fetch even when M1 is fixed. At base the engine never
  // sees the abort: the waitFor returns false.
  test("a client hangup on POST /v1/chat/completions with via:local aborts the engine", async () => {
    startAgent(false);
    const ac = new AbortController();
    const pending = postViaLocal({ signal: ac.signal });
    void pending.catch(() => undefined);
    expect(await waitFor(() => engine.hits() > 0)).toBe(true);

    ac.abort();
    expect(await waitFor(() => engine.lastAbortedAtMs() !== null, ABORT_BUDGET_MS)).toBe(true);
    expect(engine.hits()).toBe(1);
    const outcome = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(outcome).not.toBeNull();
  }, 15_000);

  // ── guards (pass at base and after the fix) ────────────────────────────

  // Guard: a non-aborted via:local chat is unchanged — the engine
  // answers 200 with choices, exactly one engine hit, no abort record.
  test("non-aborted via:local chat is unchanged", async () => {
    startAgent(false);
    const pending = postViaLocal();
    void pending.catch(() => undefined);
    expect(await waitFor(() => engine.hits() > 0)).toBe(true);
    latestGate(engine).release();
    const res = await pending;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices?: unknown };
    expect(body.choices).toBeDefined();
    expect(engine.abortedCount()).toBe(0);
    expect(engine.hits()).toBe(1);
  }, 15_000);

  // Guard: the outer HTTP slot is released exactly once on abort. The
  // in-process via-forward must not acquire a nested slot (the counted
  // acquires stays 1) and the abort path must not double-release.
  test("aborted via:local releases the ingress admission slot exactly once", async () => {
    const counted = countedAdmission(admission);
    startAgent(true, counted.admission);
    const ac = new AbortController();
    const pending = postViaLocal({ signal: ac.signal });
    void pending.catch(() => undefined);
    expect(await waitFor(() => engine.hits() > 0)).toBe(true);

    ac.abort();
    expect(counted.acquires()).toBe(1);
    expect(await waitFor(() => counted.releases() === 1)).toBe(true);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
    await Bun.sleep(200);
    expect(counted.releases()).toBe(1);
    const outcome = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(outcome).not.toBeNull();
  }, 15_000);
});
