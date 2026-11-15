/**
 * Part of #281 (DF-08): Worker RPC slice; create-proxy.ts ingress is a later slice.
 *
 * The serve-level pin: `startAgentServer`'s `chatCompletionsAdmission`
 * option must reach the published Worker RPC host, so Worker RPC
 * inference counts against the same shared cap the chat-completions
 * ingress holds. Without the wiring the agent's RPC streams freely
 * while the cap is saturated. Agents are real `startAgentServer`
 * instances on loopback with no TLS; the Worker RPC host is driven
 * in-process through `currentWorkerRpcHost()` — no kubeconfig, no
 * service credential, no upstream beyond the fake engine on 127.0.0.1.
 */
import { inferenceContracts, inferenceRpc } from "@llamactl/core";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { RequestAdmission } from "../../src/residency/request-admission.js";

import { envForTemp, makeTempRuntime } from "../../../core/test/helpers.js";
import {
  currentWorkerRpcHost,
  type WorkerRpcBackend,
  type WorkerRpcBackendEvent,
  type WorkerRpcBackendKind,
  type WorkerRpcHost,
} from "../../src/inference/procedures.js";
import { mkdirSync, writeFileSync } from "../../src/safe-fs.js";
import { generateToken } from "../../src/server/auth.js";
import {
  CHAT_INGRESS_MODEL,
  createChatCompletionsAdmission,
} from "../../src/server/chat-admission.js";
import { type RunningAgent, startAgentServer } from "../../src/server/serve.js";
import { type FakeEngine, startFakeEngine } from "../fixtures/inference-rpc-v1/fake-engine.js";

type Claims = inferenceRpc.InferenceServiceClaimsV1;
type Envelope = inferenceContracts.InferenceEnvelopeV1;
type StreamFrame = inferenceRpc.InferenceRpcStreamFrameV1;
type SubmitInput = inferenceRpc.InferenceRpcSubmitRequestV1;

const WORKER = "worker-i6";
const TENANT = "local";
const WORKLOAD = "wl-rpc";
const MODEL = "rpc/model.gguf";
const DEPLOYMENT = `deploy/${WORKER}/${WORKLOAD}`;
const V1_0 = { major: 1, minor: 0 };
const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMACTL_CONFIG",
  "LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS",
  "LLAMACTL_CHAT_ADMISSION_MAX_QUEUED",
  "LLAMACTL_RESIDENCY_LEASES",
] as const;

let temp: ReturnType<typeof makeTempRuntime>;
let engine: FakeEngine;
const envBackup: Record<string, string | undefined> = {};
const agents: RunningAgent[] = [];

interface HeldRun {
  signal: AbortSignal;
  /** Resolves the hold gate: the backend then yields its `end` event. */
  release: () => void;
}

const heldRuns: HeldRun[] = [];

function claims(): Claims {
  return {
    serviceId: "svc-leases",
    operations: [...inferenceRpc.InferenceRpcOperationSchema.options],
    deployments: [DEPLOYMENT],
    models: [],
    tenants: [TENANT],
    credentialScopeId: TENANT,
  };
}

const CLAIMS = claims();

function envelope(attemptId: string): Envelope {
  return inferenceContracts.parseInferenceEnvelope({
    requestId: `req-${attemptId}`,
    attemptId,
    deadline: Date.now() + 60_000,
    tenantId: TENANT,
    projectId: TENANT,
    credentialScopeId: TENANT,
    operation: "generate",
    ingressProtocol: "openai-chat",
    publicModelId: MODEL,
    features: {
      operation: "generate",
      protocol: "openai-chat",
      stream: true,
      modalities: ["text"],
      tools: false,
      structuredOutput: false,
      session: false,
      cancellation: true,
    },
    stream: true,
    nativeBody: { model: MODEL, stream: true, messages: [{ role: "user", content: "hi" }] },
    headerFingerprint: { allowlist: ["content-type"], fingerprint: "install" },
  });
}

function writeWorkload(): void {
  const dir = join(temp.runtimeDir, "workloads", WORKLOAD);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel: MODEL,
      // A slot save path makes the route KV-eligible for every case in this file; only the fake
      // engine's SSE answers keep KV persistence off (maybePersistKv skips event streams).
      extraArgs: ["--slot-save-path", join(temp.runtimeDir, "kvstore", "slots", WORKLOAD)],
      host: "127.0.0.1",
      port: Number(new URL(engine.url).port),
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-10-19T00:00:00.000Z",
      tunedProfile: null,
    }),
  );
}

const CONTENT: WorkerRpcBackendEvent = {
  type: "content",
  payload: {
    type: "chunk",
    chunk: {
      id: "chatcmpl-adm-1",
      object: "chat.completion.chunk",
      model: MODEL,
      created: 1_700_000_000,
      choices: [{ index: 0, delta: { content: "adm" } }],
    },
  },
};

const END: WorkerRpcBackendEvent = {
  type: "end",
  result: { ok: true, finishReason: "stop" },
  usage: { source: "unknown" },
};

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * A backend that records each attempt's run in `heldRuns`, yields one
 * content event, then waits on the test-held release or the signal
 * abort, after which it yields its `end` event.
 */
function controllableBackend(): WorkerRpcBackend {
  const backend: WorkerRpcBackend = {
    execute: (_deployment, _envelope, signal) => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      heldRuns.push({ signal, release: open });
      return (async function* (): AsyncGenerator<WorkerRpcBackendEvent> {
        yield CONTENT;
        await Promise.race([gate, aborted(signal)]);
        if (signal.aborted) return;
        yield END;
      })();
    },
  };
  return backend;
}

function onlyHeldRun(): HeldRun {
  expect(heldRuns).toHaveLength(1);
  const run = heldRuns[0];
  if (run === undefined) throw new Error("backend never ran");
  return run;
}

type ServeOpts = Parameters<typeof startAgentServer>[0];

function workerRpcFor(backend: WorkerRpcBackend | undefined): NonNullable<ServeOpts["workerRpc"]> {
  return {
    workerId: WORKER,
    settings: () => ({ versions: [V1_0], serviceCredentials: [] }),
    drainTimeoutMs: 1_000,
    ...(backend !== undefined
      ? {
          backends: new Map<WorkerRpcBackendKind, WorkerRpcBackend>([["local-model", backend]]),
        }
      : {}),
  };
}

function startAgent(
  opts: { backend?: WorkerRpcBackend; admission?: RequestAdmission } = {},
): RunningAgent {
  const options: ServeOpts = {
    bindHost: "127.0.0.1",
    port: 0,
    tokenHash: generateToken().hash,
    advertiseMdns: false,
    workerRpc: workerRpcFor(opts.backend),
    ...(opts.admission !== undefined ? { chatCompletionsAdmission: opts.admission } : {}),
  };
  const agent = startAgentServer(options);
  agents.push(agent);
  return agent;
}

function submitInput(host: WorkerRpcHost, attemptId: string): SubmitInput {
  const listing = host.catalog(CLAIMS);
  if (listing.outcome !== "catalog") throw new Error("catalog rejected");
  const deployment = listing.deployments.find((d) => d.deploymentId === DEPLOYMENT);
  return {
    version: V1_0,
    envelope: envelope(attemptId),
    target: {
      deploymentId: DEPLOYMENT,
      expectedDeploymentEpoch: deployment?.deploymentEpoch ?? "",
      catalogGeneration: listing.catalogGeneration,
      workerIncarnation: listing.workerIncarnation,
    },
    cancelId: `cancel-${attemptId}`,
  };
}

function streamIterator(host: WorkerRpcHost, attemptId: string): AsyncIterator<StreamFrame> {
  return host.stream(CLAIMS, { attemptId }, new AbortController().signal)[Symbol.asyncIterator]();
}

/** The next frame, or a thrown bound — a missing frame fails the case, never hangs it. */
async function nextFrameWithin(
  it: AsyncIterator<StreamFrame>,
  boundMs: number,
): Promise<StreamFrame> {
  const next = it.next();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no stream frame within ${String(boundMs)} ms`));
    }, boundMs);
  });
  try {
    const result = await Promise.race([next, bound]);
    if (result.done) throw new Error("stream ended before the expected frame");
    return result.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `pending` already settled inside the bound; still pending means false. */
async function settledWithin(pending: Promise<unknown>, boundMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, boundMs);
  });
  try {
    return await Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      elapsed,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Awaits an already-created promise under a bound, so a stall fails the case. */
async function awaitBounded<T>(pending: Promise<T>, boundMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what}: no result within ${String(boundMs)} ms`));
    }, boundMs);
  });
  try {
    return await Promise.race([pending, bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Polls `pred` until it holds; throws — failing the case — when the bound passes. */
async function waitFor(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() >= deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function collectFrames(
  it: AsyncIterator<StreamFrame>,
  boundMs = 5_000,
): Promise<StreamFrame[]> {
  const frames: StreamFrame[] = [];
  const draining = (async (): Promise<StreamFrame[]> => {
    for (;;) {
      const next = await it.next();
      if (next.done) return frames;
      frames.push(next.value);
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("stream did not reach its terminal"));
    }, boundMs);
  });
  try {
    return await Promise.race([draining, bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function terminalOutcomeOf(frames: readonly StreamFrame[]): string | undefined {
  const events = frames.flatMap((f) => (f.frame === "event" ? [f.event] : []));
  const last = events.at(-1);
  return last?.type === "terminal" ? last.terminal.outcome : undefined;
}

/** Saturates one execution slot the way the chat-completions ingress does. */
async function holdChatSlot(adm: RequestAdmission): Promise<() => void> {
  return await adm.acquire({
    requestId: "http-hold",
    principal: "agent",
    priority: "interactive",
    model: CHAT_INGRESS_MODEL,
    bytes: 0,
    promptTokens: 0,
    maxCompletionTokens: 0,
  });
}

beforeAll(() => {
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  temp = makeTempRuntime();
  const tempEnv = envForTemp(temp);
  process.env["DEV_STORAGE"] = tempEnv["DEV_STORAGE"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = tempEnv["LOCAL_AI_RUNTIME_DIR"];
  process.env["LLAMACTL_CONFIG"] = join(temp.devStorage, "llamactl-config.json");
  // The admission and lease flags are saved above and deleted here so no
  // case inherits a developer's live setting; afterAll restores them.
  Reflect.deleteProperty(process.env, "LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS");
  Reflect.deleteProperty(process.env, "LLAMACTL_CHAT_ADMISSION_MAX_QUEUED");
  Reflect.deleteProperty(process.env, "LLAMACTL_RESIDENCY_LEASES");
  engine = startFakeEngine();
  writeWorkload();
});

afterEach(async () => {
  for (const run of heldRuns.splice(0)) run.release();
  for (const agent of agents.splice(0)) await agent.stop();
});

afterAll(async () => {
  try {
    await engine.stop();
    temp.cleanup();
  } finally {
    for (const key of ENV_KEYS) {
      const prev = envBackup[key];
      if (prev === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = prev;
    }
  }
});

describe("#281 DF-08: chatCompletionsAdmission reaches the Worker RPC host", () => {
  // Kills: serve.ts maybePublishWorkerRpc not passing
  // opts.chatCompletionsAdmission to createWorkerRpcHost — the agent's
  // RPC then ignores the shared cap entirely.
  test("(s1) without the option a saturated cap is ignored; with it Worker RPC queues on the shared admission", async () => {
    // Control: an agent without chatCompletionsAdmission never consults
    // the (externally saturated) admission instance.
    const adm = createChatCompletionsAdmission({ maxExecutions: 1, maxQueued: 4 });
    const releaseControl = await holdChatSlot(adm);
    const controlAgent = startAgent({ backend: controllableBackend() });
    const controlHost = currentWorkerRpcHost();
    expect(controlHost.submit(CLAIMS, submitInput(controlHost, "att-control")).outcome).toBe(
      "accepted",
    );
    const controlIt = streamIterator(controlHost, "att-control");
    const controlFirst = await nextFrameWithin(controlIt, 2_000);
    expect(controlFirst).toMatchObject({ frame: "event" });
    if (controlFirst.frame === "event") expect(controlFirst.event.type).toBe("accepted");
    const controlContent = await nextFrameWithin(controlIt, 200);
    expect(controlContent).toMatchObject({ frame: "event" });
    if (controlContent.frame === "event") expect(controlContent.event.type).toBe("content");
    expect(adm.snapshot().queued).toBe(0);
    for (const run of heldRuns.splice(0)) run.release();
    const controlRest = await collectFrames(controlIt, 2_000);
    expect(terminalOutcomeOf(controlRest)).toBe("completed");
    agents.splice(agents.indexOf(controlAgent), 1);
    await controlAgent.stop();
    releaseControl();

    // Shared admission: the agent's Worker RPC host must queue on adm2.
    const adm2 = createChatCompletionsAdmission({ maxExecutions: 1, maxQueued: 4 });
    const releaseHold = await holdChatSlot(adm2);
    startAgent({ backend: controllableBackend(), admission: adm2 });
    const host = currentWorkerRpcHost();
    expect(host.submit(CLAIMS, submitInput(host, "att-shared")).outcome).toBe("accepted");
    const it = streamIterator(host, "att-shared");
    const accepted = await nextFrameWithin(it, 2_000);
    expect(accepted).toMatchObject({ frame: "event" });
    if (accepted.frame === "event") expect(accepted.event.type).toBe("accepted");
    const pending = it.next();
    await waitFor(() => adm2.snapshot().queued === 1);
    expect(await settledWithin(pending, 100)).toBe(false);
    expect(heldRuns).toHaveLength(0);

    releaseHold();
    const content = await awaitBounded(pending, 2_000, "queued attempt content");
    expect(content.done).toBe(false);
    if (!content.done) {
      expect(content.value).toMatchObject({ frame: "event" });
      if (content.value.frame === "event") expect(content.value.event.type).toBe("content");
    }
    expect(adm2.snapshot().executing).toBe(1);
    expect(heldRuns).toHaveLength(1);
    onlyHeldRun().release();
    const rest = await collectFrames(it, 5_000);
    expect(terminalOutcomeOf(rest)).toBe("completed");
    expect(adm2.snapshot().executing).toBe(0);
  }, 15_000);
});
