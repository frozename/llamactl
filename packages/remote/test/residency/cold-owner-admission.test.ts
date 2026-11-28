import type { ColdEngineDispatch } from "@llamactl/core/residency/engine-forwarder";

import { openaiProxy } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createColdOwnerAdmission } from "../../src/residency/cold-owner-admission.js";
import { createOwnerAdmission } from "../../src/residency/owner-admission.js";

const LIMITS = {
  maxExecutions: 2,
  maxQueued: 8,
  maxQueuedBytes: 1000,
  maxQueueWaitMs: 5000,
  maxPerPrincipal: 8,
  starvationBoundMs: 5000,
  maxContextTokens: 128,
  retryAfterMs: 100,
};
const PORT = 18200;
const MODEL = "declared";
const PIN = {
  model: MODEL,
  workload: "workload-a",
  ownerNodeId: "local",
  deploymentId: "deploy/local/workload-a",
  artifactRevision: "artifact-v1",
  policyRevision: "policy-v1",
  endpoint: `http://127.0.0.1:${String(PORT)}`,
  pretokenizedCompletion: true as const,
};
const READY = { pin: PIN, runtimeGeneration: "generation-1" };
const DECLARATION: ColdEngineDispatch["declaration"] = {
  id: MODEL,
  workload: PIN.workload,
  kind: "ModelRun",
  ownerNodeId: "local",
  state: "cold",
  autoLoadEligible: true,
};

function warmOwner(maxCompletionTokens = 8, port = PORT): ReturnType<typeof createOwnerAdmission> {
  return createOwnerAdmission([
    {
      name: "device",
      foregroundPorts: [port],
      backgroundPorts: [18210],
      foregroundConcurrency: 1,
      maxQueued: 4,
      maxQueuedBytes: 1000,
      maxQueueWaitMs: 5000,
      maxPerPrincipal: 8,
      starvationBoundMs: 5000,
      maxCompletionTokens,
      maxContextTokens: 128,
    },
  ]);
}

const request = (signal = new AbortController().signal): ColdEngineDispatch => ({
  declaration: DECLARATION,
  path: "/v1/completions",
  deadlineMs: Date.now() + 5000,
  body: '{"model":"declared","prompt":[1,2],"max_tokens":3}',
  clientSignal: signal,
  principal: { bearer: null },
  send: () => Promise.resolve(new Response(null, { status: 204 })),
});

test("identical cold waiters share one activation and preserve the warm engine slot after disconnect", async () => {
  const warm = warmOwner();
  const activate = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  let launches = 0;
  let ready = false;
  const owner = createColdOwnerAdmission({
    ownerNodeId: "local",
    limits: LIMITS,
    warm,
    owner: {
      pin: () => PIN,
      activate: async (): Promise<"ready"> => {
        launches++;
        await activate.promise;
        ready = true;
        return "ready";
      },
      ready: () => Promise.resolve(ready ? READY : undefined),
      stillOwns: () => true,
    },
  });
  const end = Promise.withResolvers<undefined>();
  let dials = 0;
  const first = owner.forward({
    ...request(),
    send: (): Promise<Response> => {
      dials++;
      entered.resolve(undefined);
      return Promise.resolve(
        new Response(
          new ReadableStream({
            async start(controller): Promise<void> {
              controller.enqueue(new TextEncoder().encode("chunk"));
              await end.promise;
              controller.close();
            },
          }),
        ),
      );
    },
  });
  const second = owner.forward({
    ...request(),
    declaration: { ...DECLARATION, state: "loading", autoLoadEligible: false },
    send: (): Promise<Response> => {
      dials++;
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  });
  try {
    activate.resolve(undefined);
    await entered.promise;
    expect(launches).toBe(1);
    const response = await first;
    await response.body?.cancel();
    expect(dials).toBe(1);
    expect(warm.snapshot()[0]?.executing).toBe(1);
  } finally {
    end.resolve(undefined);
  }
  expect((await second).status).toBe(204);
  expect(dials).toBe(2);
  expect(warm.snapshot()[0]?.executing).toBe(0);
  owner.stop();
  warm.stop();
});

test("invalid bounded requests, unowned rows and cancelled waiters never activate a cold target", async () => {
  const warm = warmOwner(4);
  let launches = 0;
  const owner = createColdOwnerAdmission({
    ownerNodeId: "local",
    limits: LIMITS,
    warm,
    owner: {
      pin: () => PIN,
      activate: (): Promise<"ready"> => {
        launches++;
        return Promise.resolve("ready");
      },
      ready: () => Promise.resolve(READY),
      stillOwns: () => true,
    },
  });
  expect(
    (
      await owner.forward({
        ...request(),
        body: '{"model":"declared","prompt":[1,2],"max_tokens":8}',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await owner.forward({
        ...request(),
        declaration: { ...DECLARATION, ownerNodeId: "another-node" },
      })
    ).status,
  ).toBe(503);
  expect(
    (
      await owner.forward({
        ...request(),
        body: '{"model":"different","prompt":[1],"max_tokens":1}',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await owner.forward({
        ...request(),
        declaration: { ...DECLARATION, state: "loading", autoLoadEligible: false },
      })
    ).status,
  ).toBe(503);
  const stopped = new AbortController();
  const waiting = owner.forward(request(stopped.signal));
  stopped.abort();
  expect((await waiting).status).toBe(499);
  expect(launches).toBe(0);
  expect(warm.snapshot()[0]?.executing).toBe(0);
  owner.stop();
  warm.stop();
});

test("a canceled cold load holds the next activation until the owner has settled", async () => {
  const warm = warmOwner();
  const firstEntered = Promise.withResolvers<AbortSignal>();
  const firstStopped = Promise.withResolvers<undefined>();
  const nextPin = {
    ...PIN,
    model: "different",
    workload: "workload-b",
    deploymentId: "deploy/local/workload-b",
  };
  const nextDeclaration = { ...DECLARATION, id: nextPin.model, workload: nextPin.workload };
  const activated: string[] = [];
  const owner = createColdOwnerAdmission({
    ownerNodeId: "local",
    warm,
    limits: LIMITS,
    owner: {
      pin: (entry) => (entry.id === MODEL ? PIN : nextPin),
      activate: async (pin, signal) => {
        if (pin.model === MODEL) {
          firstEntered.resolve(signal);
          await firstStopped.promise;
          return "refused";
        }
        activated.push(pin.model);
        return "ready";
      },
      ready: (pin) =>
        Promise.resolve(
          activated.includes(pin.model) ? { pin, runtimeGeneration: "generation-2" } : undefined,
        ),
      stillOwns: () => true,
    },
  });
  const cancelled = new AbortController();
  const first = owner.forward(request(cancelled.signal));
  const engineSignal = await firstEntered.promise;
  try {
    const next = owner.forward({
      ...request(),
      declaration: nextDeclaration,
      body: '{"model":"different","prompt":[1,2],"max_tokens":3}',
    });
    cancelled.abort();
    expect((await first).status).toBe(499);
    expect(engineSignal.aborted).toBe(true);
    expect(owner.snapshot().queued).toBe(1);
    expect(activated).toEqual([]);
    firstStopped.resolve(undefined);
    expect((await next).status).toBe(204);
    expect(activated).toEqual(["different"]);
    expect(owner.snapshot()).toMatchObject({ queued: 0, executing: 0, resident: [] });
  } finally {
    firstStopped.resolve(undefined);
    owner.stop();
    warm.stop();
  }
});

test("a late ready verdict after cancellation leaves no cohort state or duplicate activation", async () => {
  const warm = warmOwner();
  const entered = Promise.withResolvers<undefined>();
  const settle = Promise.withResolvers<undefined>();
  let launches = 0;
  let ready = false;
  const owner = createColdOwnerAdmission({
    ownerNodeId: "local",
    warm,
    limits: LIMITS,
    owner: {
      pin: () => PIN,
      activate: async () => {
        launches++;
        entered.resolve(undefined);
        await settle.promise;
        ready = true;
        return "ready";
      },
      ready: () => Promise.resolve(ready ? READY : undefined),
      stillOwns: () => true,
    },
  });
  const client = new AbortController();
  const first = owner.forward(request(client.signal));
  try {
    await entered.promise;
    client.abort();
    expect((await first).status).toBe(499);
    expect((await owner.forward(request())).status).toBe(503);
    settle.resolve(undefined);
    await Bun.sleep(0);
    expect(owner.snapshot()).toMatchObject({ queued: 0, executing: 0, resident: [] });
    expect((await owner.forward(request())).status).toBe(204);
    expect(launches).toBe(1);
  } finally {
    settle.resolve(undefined);
    owner.stop();
    warm.stop();
  }
});

test.each(["deploymentId", "artifactRevision", "policyRevision"] as const)(
  "readiness for a different %s fences new activations without dialing",
  async (field) => {
    const warm = warmOwner();
    let launches = 0;
    let dials = 0;
    const owner = createColdOwnerAdmission({
      ownerNodeId: "local",
      warm,
      limits: LIMITS,
      owner: {
        pin: () => PIN,
        activate: () => {
          launches++;
          return Promise.resolve("ready");
        },
        ready: () =>
          Promise.resolve(
            launches === 0 ? undefined : { ...READY, pin: { ...PIN, [field]: "different" } },
          ),
        stillOwns: () => true,
      },
    });
    const pending = {
      ...request(),
      send: (): Promise<Response> => {
        dials++;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await owner.forward(pending);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: { code: "cold_owner_fenced" } });
      }
      expect(launches).toBe(1);
      expect(dials).toBe(0);
    } finally {
      owner.stop();
      warm.stop();
    }
  },
);

test.each(["same-alias deployment", "runtime generation"] as const)(
  "a %s change while queued for warm capacity cannot dial",
  async (changed) => {
    const warm = warmOwner();
    let pin = PIN;
    let generation = READY.runtimeGeneration;
    const owner = createColdOwnerAdmission({
      ownerNodeId: "local",
      warm,
      limits: LIMITS,
      owner: {
        pin: () => pin,
        activate: () => Promise.reject(new Error("already ready")),
        ready: () => Promise.resolve(READY),
        stillOwns: (deployment) => deployment.runtimeGeneration === generation,
      },
    });
    const stop = Promise.withResolvers<undefined>();
    let dials = 0;
    const first = await owner.forward({
      ...request(),
      send: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              async start(controller): Promise<void> {
                await stop.promise;
                controller.close();
              },
            }),
          ),
        ),
    });
    try {
      expect(first.status).toBe(200);
      const second = owner.forward({
        ...request(),
        send: (): Promise<Response> => {
          dials++;
          return Promise.resolve(new Response(null, { status: 204 }));
        },
      });
      await Bun.sleep(0);
      expect(warm.snapshot()[0]?.queued).toBe(1);
      if (changed === "same-alias deployment")
        pin = { ...PIN, deploymentId: "deploy/local/different" };
      else generation = "generation-2";
      stop.resolve(undefined);
      await first.text();
      const refused = await second;
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ error: { code: "execution_target_changed" } });
      expect(dials).toBe(0);
      expect(warm.snapshot()[0]?.executing).toBe(0);
    } finally {
      stop.resolve(undefined);
      owner.stop();
      warm.stop();
    }
  },
);

test("native HTTP forwards only the preflight-normalized request to the exact approved local owner", async () => {
  const seen: { path: string; body: unknown }[] = [];
  const engine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      seen.push({ path: new URL(req.url).pathname, body: await req.json() });
      return Response.json({ choices: [{ text: "approved owner" }] });
    },
  });
  const root = mkdtempSync(join(tmpdir(), "cold-owner-http-"));
  const env = resolveEnv({
    HOME: root,
    LLAMACTL_HOME: root,
    LLAMA_CPP_PORT: "1",
  });
  const pin = { ...PIN, endpoint: engine.url.origin };
  let launches = 0;
  const warm = warmOwner(8, engine.port ?? 0);
  const owner = createColdOwnerAdmission({
    ownerNodeId: "local",
    warm,
    limits: LIMITS,
    owner: {
      pin: () => pin,
      activate: () => {
        launches++;
        return Promise.resolve("ready");
      },
      ready: () => Promise.resolve(launches === 0 ? undefined : { ...READY, pin }),
      stillOwns: () => true,
    },
  });
  openaiProxy.setDeclaredModelSource(() => [DECLARATION]);
  const requestFor = (body: object, pathname = "/v1/completions"): Request =>
    new Request(`http://proxy.test${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, ...body }),
    });
  const optedIn = (body: object, pathname?: string): Promise<Response> =>
    openaiProxy.proxyOpenAI(requestFor(body, pathname), env, { trustedColdOwner: owner.forward });
  try {
    expect(
      (await openaiProxy.proxyOpenAI(requestFor({ prompt: [1], max_tokens: 2 }), env)).status,
    ).toBe(503);
    expect(
      (
        await optedIn(
          { messages: [{ role: "user", content: "no estimates" }], max_tokens: 2 },
          "/v1/chat/completions",
        )
      ).status,
    ).toBe(400);
    expect((await optedIn({ prompt: new Array<number>(127).fill(1), max_tokens: 2 })).status).toBe(
      400,
    );
    expect((await optedIn({ prompt: [1], max_tokens: 20 })).status).toBe(400);
    expect(launches).toBe(0);
    expect(seen).toEqual([]);
    const response = await optedIn({ prompt: [1, 2], n_predict: 3 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ choices: [{ text: "approved owner" }] });
    expect(launches).toBe(1);
    expect(seen).toEqual([
      {
        path: "/v1/completions",
        body: { model: MODEL, prompt: [1, 2], max_tokens: 3 },
      },
    ]);
  } finally {
    openaiProxy.setDeclaredModelSource(null);
    owner.stop();
    warm.stop();
    await engine.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a peer cold receipt rejects replacement of the exact compiled deployment before dispatch", async () => {
  const warm = warmOwner();
  let current = PIN;
  let launches = 0;
  let sends = 0;
  const owner = createColdOwnerAdmission({
    ownerNodeId: "local",
    limits: LIMITS,
    warm,
    owner: {
      pin: () => current,
      activate: (): Promise<"ready"> => {
        launches++;
        return Promise.resolve("ready");
      },
      ready: () => Promise.resolve({ ...READY, pin: current }),
      stillOwns: () => true,
    },
  });
  try {
    expect(typeof owner.bindPeer).toBe("function");
    expect(owner.bindPeer(DECLARATION, { ...PIN, artifactRevision: "stale" })).toBeUndefined();
    const dispatch = owner.bindPeer(DECLARATION, PIN);
    if (dispatch === undefined) throw new Error("fixture did not issue a dispatch receipt");
    expect(launches).toBe(0);
    current = { ...PIN, deploymentId: "recompiled/context-64" };
    const response = await dispatch({
      ...request(),
      send: () => {
        sends++;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    expect(response.status).toBe(503);
    expect(launches).toBe(0);
    expect(sends).toBe(0);
  } finally {
    owner.stop();
    warm.stop();
  }
});

test("a peer with a cold snapshot may bind the exact ready target without activating it again", async () => {
  const warm = warmOwner();
  let launches = 0;
  let ready = true;
  const owner = createColdOwnerAdmission({
    ownerNodeId: "local",
    limits: LIMITS,
    warm,
    owner: {
      pin: () => PIN,
      activate: (): Promise<"ready"> => {
        launches++;
        return Promise.resolve("ready");
      },
      ready: () => Promise.resolve(ready ? READY : undefined),
      stillOwns: () => ready,
    },
  });
  try {
    const declaration = { ...DECLARATION, state: "ready" as const, autoLoadEligible: false };
    const dispatch = owner.bindPeer(declaration, PIN);
    if (dispatch === undefined)
      throw new Error("fixture could not bind the exact ready generation");
    expect((await dispatch(request())).status).toBe(204);
    ready = false;
    expect((await dispatch(request())).status).toBe(503);
    expect(launches).toBe(0);
  } finally {
    owner.stop();
    warm.stop();
  }
});
