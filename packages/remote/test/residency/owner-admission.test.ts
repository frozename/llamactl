import type { LocalEngineDispatch } from "@llamactl/core/residency/engine-forwarder";

import { inferenceContracts, inferenceRpc, openaiProxy } from "@llamactl/core";
import { AgentConfigSchema } from "@llamactl/core/config/agent-config";
import { writeModelHostState } from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import {
  createResidencyLeases,
  getResidencyLeaseRegistry,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { expect, test } from "bun:test";

import type { InferenceHoldReceipt } from "../../src/residency/inference-holds.js";

import { envForTemp, makeTempRuntime } from "../../../core/test/helpers.js";
import { currentWorkerRpcHost } from "../../src/inference/procedures.js";
import { createOwnerAdmission } from "../../src/residency/owner-admission.js";
import { startAgentServer } from "../../src/server/serve.js";

const group = (
  foreground: number,
  background: number,
): NonNullable<ReturnType<typeof AgentConfigSchema.parse>["executionAdmission"]>[number] => ({
  name: "metal",
  foregroundPorts: [foreground],
  backgroundPorts: [background],
  foregroundConcurrency: 2,
  maxQueued: 4,
  maxQueueWaitMs: 1000,
  starvationBoundMs: 1000,
  maxQueuedBytes: 65536,
  maxPerPrincipal: 4,
});

test("agent config preserves execution admission and rejects a port with competing claims", () => {
  const raw = {
    apiVersion: "llamactl/v1",
    kind: "AgentConfig",
    certPath: "cert",
    keyPath: "key",
    tokenHash: "a".repeat(64),
    fingerprint: "sha256:" + "a".repeat(64),
    executionAdmission: [group(18200, 18210)],
  };
  expect(AgentConfigSchema.parse(raw)).toMatchObject({
    executionAdmission: raw.executionAdmission,
  });
  expect(
    AgentConfigSchema.safeParse({
      ...raw,
      executionAdmission: [...raw.executionAdmission, { ...group(18220, 18200), name: "other" }],
    }).success,
  ).toBe(false);
});

type Deferred = ReturnType<typeof Promise.withResolvers<undefined>>;
type FixtureEngine = { server: ReturnType<typeof Bun.serve>; entered: Deferred; bodyEnd: Deferred };

function engine(calls: string[], lane: string): FixtureEngine {
  const entered = Promise.withResolvers<undefined>();
  const bodyEnd = Promise.withResolvers<undefined>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      const { model } = (await req.json()) as { model: string };
      calls.push(lane + ":" + model);
      entered.resolve(undefined);
      const body = new ReadableStream<Uint8Array>({
        async start(controller): Promise<void> {
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: "test",
                object: "chat.completion.chunk",
                created: 1,
                model,
                choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
              })}\n\n`,
            ),
          );
          await bodyEnd.promise;
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { server, entered, bodyEnd };
}

function chat(port: number, model: string, signal?: AbortSignal): Promise<Response> {
  const req = new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, messages: [] }),
    ...(signal === undefined ? {} : { signal }),
  });
  return openaiProxy.proxyOpenAI(req, resolveEnv({ ...process.env, LLAMA_CPP_PORT: String(port) }));
}

const V1 = { major: 1, minor: 0 };
const RPC_CLAIMS = {
  serviceId: "worker-test",
  operations: [...inferenceRpc.InferenceRpcOperationSchema.options],
  deployments: ["deploy/worker/qwen"],
  models: [],
  tenants: ["test"],
  credentialScopeId: "test",
};

async function* workerChat(
  attemptId: string,
): AsyncGenerator<inferenceRpc.InferenceRpcStreamFrameV1> {
  const host = currentWorkerRpcHost();
  const catalog = host.catalog(RPC_CLAIMS);
  if (catalog.outcome !== "catalog") throw new Error("worker catalog not available");
  const deployment = catalog.deployments.find((d) => d.deploymentId === "deploy/worker/qwen");
  const epoch = deployment?.deploymentEpoch;
  if (deployment === undefined || typeof epoch !== "string") {
    throw new Error("foreground deployment epoch is missing");
  }
  const envelope = inferenceContracts.parseInferenceEnvelope({
    requestId: attemptId,
    attemptId,
    projectId: "test",
    operation: "generate",
    ingressProtocol: "openai-chat",
    publicModelId: "rpc",
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
    headerFingerprint: { allowlist: ["content-type"], fingerprint: "test" },
    deadline: Date.now() + 10_000,
    credentialScopeId: "test",
    tenantId: "test",
    nativeBody: { model: "rpc", stream: true, messages: [] },
  });
  const receipt = host.submit(RPC_CLAIMS, {
    version: V1,
    envelope,
    cancelId: attemptId,
    target: {
      deploymentId: deployment.deploymentId,
      expectedDeploymentEpoch: epoch,
      workerIncarnation: catalog.workerIncarnation,
      catalogGeneration: catalog.catalogGeneration,
    },
  });
  expect(receipt.outcome).toBe("accepted");
  yield* host.stream(RPC_CLAIMS, { attemptId }, new AbortController().signal);
}

test("worker RPC shares the HTTP queue and passes queued background work", async () => {
  const temp = makeTempRuntime();
  const calls: string[] = [];
  const fg = engine(calls, "fg");
  const bg = engine(calls, "bg");
  const env = envForTemp(temp);
  const saved = Object.keys(env).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, env);
  const options = {
    noAuth: true,
    tokenHash: "a".repeat(64),
    advertiseMdns: false,
    executionAdmission: [{ ...group(fg.server.port!, bg.server.port!), maxQueued: 2 }],
    workerRpc: {
      workerId: "worker",
      settings: (): { versions: (typeof V1)[]; serviceCredentials: [] } => ({
        versions: [V1],
        serviceCredentials: [],
      }),
    },
  };
  const agent = startAgentServer(options);
  try {
    writeModelHostState(
      {
        kind: "ModelHost",
        engine: "llamacpp",
        pid: process.pid,
        host: "127.0.0.1",
        port: fg.server.port!,
        modelAliases: ["rpc"],
        startedAt: "2026-11-27T15:00:00.000Z",
      },
      { name: "qwen" },
      resolveEnv(),
    );
    writeModelHostState(
      {
        kind: "ModelHost",
        engine: "llamacpp",
        pid: process.pid,
        host: "127.0.0.1",
        port: bg.server.port!,
        modelAliases: ["active", "queued"],
        startedAt: "2026-11-27T15:00:00.000Z",
      },
      { name: "granite" },
      resolveEnv(),
    );
    const active = await chat(bg.server.port!, "active");
    expect(active.status).toBe(200);
    const cancel = new AbortController();
    const queued = chat(bg.server.port!, "queued", cancel.signal);
    await Bun.sleep(20);
    const stream = workerChat("worker-1");
    const accepted = await stream.next();
    expect(accepted.value).toMatchObject({ frame: "event", event: { type: "accepted" } });
    const overflow = workerChat("worker-2");
    const first = await overflow.next();
    expect(first.value).toMatchObject({
      frame: "rejected",
      rejection: { code: "overloaded", retryAfterMs: 1000 },
    });
    await overflow.return(undefined);
    expect(currentWorkerRpcHost().status(RPC_CLAIMS, { attemptId: "worker-1" })).toMatchObject({
      state: "accepted",
    });
    const cancellation = currentWorkerRpcHost().cancel(RPC_CLAIMS, { attemptId: "worker-1" });
    expect(cancellation.outcome).toBe("cancelled");
    expect((await stream.next()).value).toMatchObject({
      frame: "event",
      event: { terminal: { outcome: "cancelled", started: false } },
    });
    await stream.return(undefined);
    expect(calls).toEqual(["bg:active"]);

    const successor = workerChat("worker-3");
    expect((await successor.next()).value).toMatchObject({
      frame: "event",
      event: { type: "accepted" },
    });
    const rpc = (async (): Promise<void> => {
      for await (const frame of successor) {
        if (frame.frame === "event" && frame.event.type === "terminal") {
          expect(frame.event.terminal.outcome).toBe("completed");
        }
      }
    })();
    expect(calls).toEqual(["bg:active"]);
    await active.body!.cancel();
    await Bun.sleep(30);
    expect(calls).toEqual(["bg:active"]);
    expect(getResidencyLeaseRegistry()?.active("granite")).toHaveLength(2);

    bg.bodyEnd.resolve(undefined);
    await fg.entered.promise;
    expect(calls).toEqual(["bg:active", "fg:rpc"]);
    fg.bodyEnd.resolve(undefined);
    await rpc;
    const bgResponse = await queued;
    expect(bgResponse.status).toBe(200);
    await bgResponse.text();
    expect(calls).toEqual(["bg:active", "fg:rpc", "bg:queued"]);
  } finally {
    fg.bodyEnd.resolve(undefined);
    bg.bodyEnd.resolve(undefined);
    await agent.stop();
    await fg.server.stop(true);
    await bg.server.stop(true);
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    temp.cleanup();
  }
});

function dispatch(
  port: number,
  send: LocalEngineDispatch["send"],
  overrides: Partial<LocalEngineDispatch> = {},
): LocalEngineDispatch {
  return {
    target: `http://127.0.0.1:${String(port)}/v1/chat/completions`,
    deadlineMs: Date.now() + 5000,
    body: "{}",
    clientSignal: new AbortController().signal,
    principal: { bearer: null },
    send,
    ...overrides,
  };
}

function heldResponse(): { response: Response; end: () => void; fail: () => void } {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        output = controller;
        output.enqueue(new Uint8Array([65]));
      },
    }),
  );
  return {
    response,
    end: (): void => {
      output.close();
    },
    fail: (): void => {
      output.error(new Error("upstream disconnected"));
    },
  };
}

test("a broken engine stream fences the group before a queued request can dial", async () => {
  const gate = createOwnerAdmission([group(18200, 18210)]);
  const held = heldResponse();
  const first = await gate.forward(dispatch(18210, () => Promise.resolve(held.response)));
  expect(first?.status).toBe(200);
  let sent = false;
  const waiting = gate.forward(
    dispatch(18200, () => {
      sent = true;
      return Promise.resolve(Response.json({}));
    }),
  );
  expect(gate.snapshot()).toMatchObject([{ queued: 1, executing: 1, fenced: false }]);
  const drain = first!.text();
  held.fail();
  expect(await drain.catch((error: unknown) => error)).toEqual(new Error("upstream disconnected"));
  const refusal = await waiting;
  expect(refusal?.status).toBe(503);
  expect(await refusal!.json()).toMatchObject({ error: { code: "execution_group_fenced" } });
  expect(gate.snapshot()).toMatchObject([{ queued: 0, executing: 0, fenced: true }]);
  expect(sent).toBe(false);
  gate.stop();
});

test("a detached request keeps its residency lease until the engine finishes", async () => {
  const previous = getResidencyLeaseRegistry();
  const leases = createResidencyLeases();
  setResidencyLeaseRegistry(leases);
  const gate = createOwnerAdmission([group(18200, 18210)]);
  try {
    const held = heldResponse();
    const reply = await gate.forward(
      dispatch(18210, () => Promise.resolve(held.response), {
        workload: "granite",
      }),
    );
    await reply?.body?.cancel();
    expect(leases.active("granite")).toHaveLength(1);
    const drain = leases.beginDrain("granite");
    expect(drain.ok).toBe(true);
    if (!drain.ok) throw new Error("fixture drain refused");
    const idle = leases.whenIdle(drain.token, { signal: AbortSignal.timeout(1000) });
    held.end();
    expect(await idle).toEqual({ idle: true });
    expect(leases.active("granite")).toHaveLength(0);
  } finally {
    gate.stop();
    setResidencyLeaseRegistry(previous);
  }
});

test("an unconfirmed engine abort blocks unload through and after reader cancellation", async () => {
  const previous = getResidencyLeaseRegistry();
  const leases = createResidencyLeases();
  setResidencyLeaseRegistry(leases);
  let settlements = 0;
  const gate = createOwnerAdmission([group(18200, 18210)], {
    inferenceHolds: {
      begin(): InferenceHoldReceipt {
        return {
          confirmCompletion: (): boolean => {
            settlements++;
            return true;
          },
        };
      },
      state: (): "current" => "current",
    },
  });
  const engineAbort = new AbortController();
  const cancelStarted = Promise.withResolvers<undefined>();
  const cancelFinished = Promise.withResolvers<undefined>();
  const body = new ReadableStream<Uint8Array>({
    cancel(): Promise<undefined> {
      cancelStarted.resolve(undefined);
      return cancelFinished.promise;
    },
  });
  try {
    const response = await gate.forward(
      dispatch(18210, () => Promise.resolve(new Response(body)), {
        workload: "granite",
        engineSignal: engineAbort.signal,
      }),
    );
    expect(response?.status).toBe(200);
    const reading = response?.text().catch((error: unknown) => error);
    const drain = leases.beginDrain("granite");
    if (!drain.ok) throw new Error("fixture drain refused");
    expect(drain.active).toHaveLength(1);

    engineAbort.abort(new Error("engine deadline passed"));
    await cancelStarted.promise;
    expect(leases.commitUnload(drain.token)).toMatchObject({ ok: false, reason: "LeasesActive" });

    cancelFinished.resolve(undefined);
    expect(await reading).toEqual(new Error("engine deadline passed"));
    await Bun.sleep(0);
    expect(leases.commitUnload(drain.token)).toMatchObject({ ok: false, reason: "LeasesActive" });
    expect(gate.snapshot()).toMatchObject([{ executing: 0, fenced: true }]);
    expect(settlements).toBe(0);
  } finally {
    cancelFinished.resolve(undefined);
    gate.stop();
    setResidencyLeaseRegistry(previous);
  }
});

test("owner admission refuses before dialing when the durable inference hold cannot begin", async () => {
  const previous = getResidencyLeaseRegistry();
  const leases = createResidencyLeases();
  setResidencyLeaseRegistry(leases);
  const starts: string[] = [];
  const gate = createOwnerAdmission([group(18200, 18210)], {
    inferenceHolds: {
      begin(workload: string): undefined {
        starts.push(workload);
        return undefined;
      },
      state: () => "unknown",
    },
  });
  let dials = 0;
  try {
    const response = await gate.forward(
      dispatch(
        18210,
        () => {
          dials++;
          return Promise.resolve(new Response(null, { status: 204 }));
        },
        { workload: "granite" },
      ),
    );
    expect(response?.status).toBe(503);
    expect(starts).toEqual(["granite"]);
    expect(dials).toBe(0);
    expect(leases.active("granite")).toEqual([]);
  } finally {
    gate.stop();
    setResidencyLeaseRegistry(previous);
  }
});

test("owner admission settles a durable hold only when the engine outcome is confirmed", async () => {
  const previous = getResidencyLeaseRegistry();
  const leases = createResidencyLeases();
  setResidencyLeaseRegistry(leases);
  const events: string[] = [];
  let canSettle = true;
  const gate = createOwnerAdmission([group(18200, 18210)], {
    inferenceHolds: {
      begin(workload: string): InferenceHoldReceipt {
        events.push("hold:" + workload);
        return {
          confirmCompletion: (): boolean => {
            events.push("settle");
            return canSettle;
          },
        };
      },
      state: (): "current" => "current",
    },
  });
  const send = (): Promise<Response> => {
    events.push("dial");
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  try {
    const confirmed = await gate.forward(dispatch(18210, send, { workload: "granite" }));
    expect(confirmed?.status).toBe(204);
    expect(events).toEqual(["hold:granite", "dial", "settle"]);
    expect(leases.active("granite")).toHaveLength(0);

    canSettle = false;
    const verified = await gate.forward(dispatch(18210, send, { workload: "granite" }));
    expect(verified?.status).toBe(204);
    expect(events).toEqual(["hold:granite", "dial", "settle", "hold:granite", "dial", "settle"]);
    expect(leases.active("granite")).toHaveLength(1);
    expect(gate.snapshot()).toMatchObject([{ executing: 0, fenced: true }]);
  } finally {
    gate.stop();
    setResidencyLeaseRegistry(previous);
  }
});

test("owner admission rechecks target ownership after recording a durable hold", async () => {
  const previous = getResidencyLeaseRegistry();
  const leases = createResidencyLeases();
  setResidencyLeaseRegistry(leases);
  let ownsTarget = true;
  let settled = false;
  let dialed = false;
  const gate = createOwnerAdmission([group(18200, 18210)], {
    inferenceHolds: {
      begin(): InferenceHoldReceipt {
        ownsTarget = false;
        return {
          confirmCompletion: (): boolean => {
            settled = true;
            return true;
          },
        };
      },
      state: (): "current" => "current",
    },
  });
  try {
    const response = await gate.forward(
      dispatch(
        18210,
        () => {
          dialed = true;
          return Promise.resolve(new Response(null, { status: 204 }));
        },
        { workload: "granite", stillOwnsTarget: () => ownsTarget },
      ),
    );
    expect(response?.status).toBe(503);
    expect(settled).toBe(true);
    expect(dialed).toBe(false);
    expect(leases.active("granite")).toHaveLength(0);
  } finally {
    gate.stop();
    setResidencyLeaseRegistry(previous);
  }
});

test("the owner bounds request bytes, queue deadlines and cancellable waiting", async () => {
  const gate = createOwnerAdmission([{ ...group(18200, 18210), maxQueuedBytes: 16 }]);
  const held = heldResponse();
  const send = (): Promise<Response> => Promise.resolve(held.response);
  const active = await gate.forward(dispatch(18210, send));
  let sent = false;
  const unexpected = (): Promise<Response> => {
    sent = true;
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  try {
    const tooLarge = await gate.forward(dispatch(18200, unexpected, { body: "a".repeat(17) }));
    expect(tooLarge?.status).toBe(413);
    const deadline = await gate.forward(
      dispatch(18200, unexpected, { deadlineMs: Date.now() + 30 }),
    );
    expect(deadline?.status).toBe(504);
    const controller = new AbortController();
    const waiting = gate.forward(dispatch(18200, unexpected, { clientSignal: controller.signal }));
    expect(gate.snapshot()).toMatchObject([{ queued: 1, executing: 1 }]);
    controller.abort();
    expect((await waiting)?.status).toBe(499);
    expect(gate.snapshot()).toMatchObject([{ queued: 0, executing: 1 }]);
    expect(sent).toBe(false);
  } finally {
    held.end();
    await active?.text();
    gate.stop();
  }
});

test("the owner rechecks the adapter's actual body before using its reserved permit", async () => {
  const owner = createOwnerAdmission([{ ...group(18200, 18210), maxCompletionTokens: 4 }]);
  let sends = 0;
  const send = (): Promise<Response> => {
    sends += 1;
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  const request = dispatch(18200, send, { body: '{"max_tokens":4}' });
  const ticket = owner.acquire(request);
  if (ticket === undefined || "refusal" in ticket) throw new Error("fixture admission refused");
  const permit = await ticket.pending;
  const result = await permit.send(send, '{"max_tokens":5}');
  expect(result.status).toBe(400);
  expect(await result.json()).toMatchObject({ error: { code: "ContextLimitExceeded" } });
  expect(sends).toBe(0);
  expect(owner.snapshot()[0]?.executing).toBe(0);
  owner.stop();
});

test("two interactive requests can execute together without admitting a third or Granite", async () => {
  const gate = createOwnerAdmission([{ ...group(18200, 18210), maxQueued: 2 }]);
  const one = heldResponse();
  const two = heldResponse();
  const a = await gate.forward(dispatch(18200, () => Promise.resolve(one.response)));
  const b = await gate.forward(dispatch(18200, () => Promise.resolve(two.response)));
  let backgroundDials = 0;
  const background = gate.forward(
    dispatch(18210, () => {
      backgroundDials++;
      return Promise.resolve(new Response(null, { status: 204 }));
    }),
  );
  const overflow = await gate.forward(dispatch(18210, () => Promise.resolve(new Response())));
  expect(overflow?.status).toBe(429);
  expect(overflow?.headers.get("retry-after")).toBe("1");
  const third = await gate.forward(
    dispatch(18200, () => Promise.resolve(new Response(null, { status: 204 })), {
      deadlineMs: Date.now() + 20,
    }),
  );
  expect(third?.status).toBe(504);
  expect(gate.snapshot()).toMatchObject([{ queued: 1, executing: 2 }]);
  one.end();
  await a?.text();
  expect(backgroundDials).toBe(0);
  two.end();
  await b?.text();
  expect((await background)?.status).toBe(204);
  expect(backgroundDials).toBe(1);
  gate.stop();
});

test("HTTP admission verifies ownership again after queueing", async () => {
  const gate = createOwnerAdmission([group(18200, 18210)]);
  const held = heldResponse();
  const active = await gate.forward(dispatch(18210, () => Promise.resolve(held.response)));
  let owned = true;
  let dials = 0;
  const pending = gate.forward(
    dispatch(
      18200,
      () => {
        dials++;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
      { stillOwnsTarget: () => owned },
    ),
  );
  expect(gate.snapshot()).toMatchObject([{ queued: 1, executing: 1 }]);
  expect(gate.snapshot()[0]?.oldestQueuedWaitMs).toBeGreaterThanOrEqual(0);
  owned = false;
  held.end();
  await active?.text();
  const refusal = await pending;
  expect(refusal?.status).toBe(503);
  expect(await refusal?.json()).toMatchObject({ error: { code: "execution_target_changed" } });
  expect(dials).toBe(0);
  expect(gate.snapshot()).toMatchObject([{ queued: 0, executing: 0, fenced: false }]);
  expect(gate.snapshot()[0]?.oldestQueuedWaitMs).toBeUndefined();
  gate.stop();
});

test("a stopping owner refuses queued and new requests without another dial", async () => {
  const gate = createOwnerAdmission([group(18200, 18210)]);
  const held = heldResponse();
  const active = await gate.forward(dispatch(18210, () => Promise.resolve(held.response)));
  let sends = 0;
  const foreground = dispatch(18200, () => {
    sends++;
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const queued = gate.forward(foreground);
  expect(gate.snapshot()).toMatchObject([{ queued: 1, executing: 1 }]);
  await active?.body?.cancel();
  gate.stop();
  expect((await queued)?.status).toBe(503);
  expect((await gate.forward(foreground))?.status).toBe(503);
  expect(sends).toBe(0);
});
