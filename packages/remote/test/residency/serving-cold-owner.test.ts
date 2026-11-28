import type { ExecutionAdmissionConfig } from "@llamactl/core/config/agent-config";
import type { LocalEngineDispatch } from "@llamactl/core/residency/engine-forwarder";
import type { PeerSnapshot } from "@llamactl/core/workloadRuntime";

import { writeModelHostState } from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import { getLocalEngineForwarder } from "@llamactl/core/residency/engine-forwarder";
import { getResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TrustedColdOwner, TrustedColdPin } from "../../src/residency/cold-owner-admission.js";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import { readManagedProfileSelection } from "../../src/residency/managed-profile-selection.js";
import { createOwnerAdmission } from "../../src/residency/owner-admission.js";
import { peerColdBodyDigest } from "../../src/residency/peer-cold.js";
import { openResidencyOperationStore } from "../../src/residency/store.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { hashToken } from "../../src/server/auth.js";
import { prepareColdOwnerMount } from "../../src/server/cold-owner-mount.js";
import {
  type RunningAgent,
  type StartAgentOptions,
  startAgentServer,
} from "../../src/server/serve.js";
import {
  type ManagedAgentDependencies,
  startManagedAgentServer,
} from "../../src/server/start-managed-agent.js";
import { generateSelfSignedCert } from "../../src/server/tls.js";
import { parseModelHost, saveModelHost } from "../../src/workload/modelhost-store.js";
import { parseNodeRun, saveNodeRun } from "../../src/workload/noderun-store.js";
import { parseWorkload, saveWorkload } from "../../src/workload/store.js";

const MODEL = "org/cold.gguf";
const WORKLOAD = "cold-model";
const TOKEN = "cold-owner-test-token";
const NODE = "fixture-cold-owner";
const capacity: ManagedAgentDependencies = {
  nowMs: () => 100_000,
  onCapacityAudit: () => undefined,
  readCapacity: () => ({
    source: "linux-procfs",
    observedAtMs: 100_000,
    physicalBytes: 64 * 1024 ** 3,
    availableBytes: 48 * 1024 ** 3,
    scope: { kind: "host-physical" },
    pressure: "normal",
    swapUsedBytes: 0,
  }),
};
const CAP: ExecutionAdmissionConfig[number] = {
  name: "test-device",
  foregroundPorts: [19000],
  backgroundPorts: [19001],
  foregroundConcurrency: 1,
  maxQueued: 4,
  maxQueuedBytes: 4096,
  maxPerPrincipal: 4,
  maxQueueWaitMs: 2000,
  starvationBoundMs: 2000,
  maxContextTokens: 128,
  maxCompletionTokens: 8,
};

function isolate(dir: string): () => void {
  const env = {
    DEV_STORAGE: dir,
    LOCAL_AI_RUNTIME_DIR: join(dir, "runtime"),
    LLAMACTL_WORKLOADS_DIR: join(dir, "workloads"),
    LLAMACTL_RESIDENCY_STORE: join(dir, "operations.sqlite"),
    LLAMACTL_UNIFIED_PROXY: "0",
  };
  const previous = Object.keys(env).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, env);
  saveNodeRun(
    parseNodeRun(`
apiVersion: llamactl/v1
kind: NodeRun
metadata: { name: ${NODE} }
spec: { node: ${NODE}, budget: { memoryGiB: 24 } }
`),
    env.LLAMACTL_WORKLOADS_DIR,
  );
  saveWorkload(
    parseWorkload(`
apiVersion: llamactl/v1
kind: ModelRun
metadata: { name: ${WORKLOAD} }
spec: { node: local, target: { kind: rel, value: ${MODEL} } }
`),
    env.LLAMACTL_WORKLOADS_DIR,
  );
  return (): void => {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  };
}

function request(agent: RunningAgent, authenticated = true, signal?: AbortSignal): Request {
  return new Request(`${agent.url}/v1/completions`, {
    method: "POST",
    body: JSON.stringify({ model: MODEL, prompt: [1, 2], max_tokens: 3 }),
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    ...(signal === undefined ? {} : { signal }),
  });
}

function fixtureOwner(
  activate: TrustedColdOwner["activate"],
  endpoint = "http://127.0.0.1:19000",
): TrustedColdOwner {
  return {
    pin: (entry): TrustedColdPin => ({
      model: entry.id,
      workload: entry.workload,
      ownerNodeId: entry.ownerNodeId,
      deploymentId: "fixture-deployment",
      artifactRevision: "fixture-artifact",
      policyRevision: "fixture-policy",
      endpoint,
      pretokenizedCompletion: true,
    }),
    activate,
    ready: (): Promise<undefined> => Promise.resolve(undefined),
    stillOwns: (): boolean => false,
  };
}

test("mount prerequisites reject no-auth and foreign or missing managed ownership", () => {
  const warm = createOwnerAdmission([CAP]);
  const managed = {
    run: (): Promise<{ ran: false; detail: string }> =>
      Promise.resolve({ ran: false, detail: "fixture" }),
    runOwnedLifecycle: <T>(run: () => T): T => run(),
    ownsNode: (node: string): boolean => node === "local",
  };
  let calls = 0;
  const base = {
    factory: (): TrustedColdOwner => {
      calls++;
      return fixtureOwner((): Promise<"refused"> => Promise.resolve("refused"));
    },
    managed,
    warm,
    executionAdmission: [CAP],
    managedRuntime: true,
    tls: true,
    noAuth: false,
    declaredModels: true,
    residencyLeases: true,
  };
  try {
    for (const disabled of [
      { noAuth: true },
      { managedRuntime: false },
      { managed: undefined },
      { managed: { ...managed, ownsNode: (): boolean => false } },
      { residencyLeases: false },
    ]) {
      expect(prepareColdOwnerMount({ ...base, ...disabled })).toBeUndefined();
    }
    expect(calls).toBe(0);
    expect(prepareColdOwnerMount(base)).toBeDefined();
    expect(calls).toBe(1);
  } finally {
    warm.stop();
  }
});

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "only the authenticated TLS managed agent with declarations and explicit caps mounts a local cold owner",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-serve-cold-owner-"));
    const restore = isolate(dir);
    let running: RunningAgent | undefined;
    try {
      let factories = 0;
      let attempts = 0;
      const factory = (): TrustedColdOwner => {
        factories++;
        return fixtureOwner((): Promise<"refused"> => {
          attempts++;
          return Promise.resolve("refused");
        });
      };
      const cert = await generateSelfSignedCert({ dir, commonName: "127.0.0.1" });
      const tls = { certPath: cert.certPath, keyPath: cert.keyPath };
      const base = { tokenHash: hashToken(TOKEN), advertiseMdns: false };
      const opts = { ...base, tls, declaredModels: true, executionAdmission: [CAP] };

      running = startAgentServer({ ...opts, managedColdOwnerFactory: factory });
      expect(factories).toBe(0);
      await running.stop();
      running = undefined;

      const { maxContextTokens: _context, ...unbounded } = CAP;
      const { maxCompletionTokens: _completion, ...noCompletionCap } = CAP;
      for (const options of [
        { ...base, declaredModels: true, executionAdmission: [CAP] },
        { ...base, tls, declaredModels: false, executionAdmission: [CAP] },
        { ...base, tls, declaredModels: true, executionAdmission: [unbounded] },
        { ...base, tls, declaredModels: true, executionAdmission: [noCompletionCap] },
      ]) {
        running = await startManagedAgentServer(
          { ...options, managedColdOwnerFactory: factory },
          NODE,
          capacity,
        );
        expect(factories).toBe(0);
        await running.stop();
        running = undefined;
      }

      running = await startManagedAgentServer(
        { ...opts, managedColdOwnerFactory: factory },
        NODE,
        capacity,
      );
      expect(factories).toBe(1);
      expect(running.tryQuiesceOwnerAdmissions).toBeUndefined();
      expect((await fetch(request(running, false), { tls: { ca: cert.certPem } })).status).toBe(
        401,
      );
      expect(attempts).toBe(0);
      const response = await fetch(request(running), { tls: { ca: cert.certPem } });
      expect(response.status).toBe(503);
      expect(attempts).toBe(1);

      process.env["LLAMACTL_UNIFIED_PROXY"] = "1";
      expect((await fetch(request(running, false), { tls: { ca: cert.certPem } })).status).toBe(
        401,
      );
      expect(attempts).toBe(1);
      const unified = await fetch(request(running), { tls: { ca: cert.certPem } });
      expect(unified.status).toBe(503);
      expect(attempts).toBe(2);
    } finally {
      await running?.stop();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "managed agent shutdown cancels the cold launch and waits for it to settle",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-serve-cold-stop-"));
    const restore = isolate(dir);
    const entered = Promise.withResolvers<undefined>();
    const canceled = Promise.withResolvers<undefined>();
    const settleLaunch = Promise.withResolvers<undefined>();
    let running: RunningAgent | undefined;
    try {
      const cert = await generateSelfSignedCert({ dir, commonName: "127.0.0.1" });
      running = await startManagedAgentServer(
        {
          tokenHash: hashToken(TOKEN),
          tls: { certPath: cert.certPath, keyPath: cert.keyPath },
          advertiseMdns: false,
          declaredModels: true,
          executionAdmission: [CAP],
          managedColdOwnerFactory: (): TrustedColdOwner =>
            fixtureOwner(async (_pin, signal): Promise<"uncertain"> => {
              signal.addEventListener(
                "abort",
                () => {
                  canceled.resolve(undefined);
                },
                { once: true },
              );
              entered.resolve(undefined);
              await settleLaunch.promise;
              return "uncertain";
            }),
        },
        NODE,
        capacity,
      );
      const dispatch = running.handleRequest;
      if (dispatch === undefined) throw new Error("expected test agent request seam");
      const registry = getResidencyLeaseRegistry();
      expect(registry).not.toBeNull();
      const pending = dispatch(request(running));
      await entered.promise;
      let stopped = false;
      const stopping = running.stop().then(() => {
        stopped = true;
      });
      await canceled.promise;
      await pending;
      await Bun.sleep(25);
      expect(stopped).toBe(false);
      expect(getResidencyLeaseRegistry()).toBe(registry);
      settleLaunch.resolve(undefined);
      await stopping;
      expect(stopped).toBe(true);
      expect(getResidencyLeaseRegistry()).not.toBe(registry);
      running = undefined;
    } finally {
      settleLaunch.resolve(undefined);
      await running?.stop();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

async function ownerFixtureOptions(
  dir: string,
  factory: NonNullable<StartAgentOptions["managedColdOwnerFactory"]>,
  caps = CAP,
): Promise<StartAgentOptions> {
  const cert = await generateSelfSignedCert({ dir, commonName: "127.0.0.1" });
  return {
    tokenHash: hashToken(TOKEN),
    tls: { certPath: cert.certPath, keyPath: cert.keyPath },
    advertiseMdns: false,
    declaredModels: true,
    executionAdmission: [caps],
    managedColdOwnerFactory: factory,
  };
}

function dispatchWarm(
  send: LocalEngineDispatch["send"],
  signal = new AbortController().signal,
): Promise<Response> {
  const forward = getLocalEngineForwarder();
  const response = forward?.({
    target: "http://127.0.0.1:19000/v1/completions",
    workload: WORKLOAD,
    pretokenizedCompletion: true,
    body: JSON.stringify({ model: MODEL, prompt: [1], max_tokens: 1 }),
    deadlineMs: Date.now() + 5000,
    clientSignal: signal,
    principal: { bearer: null },
    send,
  });
  if (response === undefined) throw new Error("fixture missing warm owner");
  return response;
}

test("an explicit maintenance window uses the owner pause and publishes through the managed coordinator", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-idle-profile-"));
  const restore = isolate(dir);
  const path = join(dir, "operations.sqlite");
  let running: RunningAgent | undefined;
  let exclusiveIngress = false;
  try {
    const manifest = parseWorkload(`
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: ${WORKLOAD}
  annotations: { llamactl.io/residency-profiles: 'interactive,maintenance' }
spec:
  node: local
  enabled: false
  target: { kind: rel, value: ${MODEL} }
  resources: { expectedMemoryGiB: 1 }
`);
    const workloadsDir = join(dir, "workloads");
    saveWorkload(manifest, workloadsDir);
    const opts = await ownerFixtureOptions(dir, () =>
      fixtureOwner(() => Promise.resolve("refused")),
    );
    running = await startManagedAgentServer(opts, NODE, {
      ...capacity,
      ownerActivity: { verifyExclusiveIngress: () => exclusiveIngress },
    });
    const apply = running.tryApplyIdleProfile;
    expect(typeof apply).toBe("function");
    if (apply === undefined) throw new Error("fixture idle profile is unavailable");

    const dispatch = running.handleRequest;
    if (dispatch === undefined) throw new Error("fixture owner handler missing");
    const selected = await dispatch(
      new Request(`${running.url}/trpc/residencyApplyManagedProfile`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          node: NODE,
          to: "interactive",
          dryRun: false,
          confirm: true,
          version: 1,
        }),
      }),
    );
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ result: { data: { ok: true } } });
    const initial = readManagedProfileSelection(path, NODE);
    expect(initial).toMatchObject({ kind: "selected", profile: "interactive" });

    const window = new AbortController();
    const change = { from: "interactive", to: "maintenance", signal: window.signal };
    expect(await apply(change)).toMatchObject({ ok: false, refusal: { reason: "OwnerNotIdle" } });
    exclusiveIngress = true;
    expect(await apply({ ...change, signal: AbortSignal.abort() })).toMatchObject({
      ok: false,
      refusal: { reason: "IdleProfileCanceled" },
    });
    expect(await apply({ ...change, from: "stale-profile" })).toMatchObject({
      ok: false,
      refusal: { reason: "ProfileSelectionChanged" },
    });
    expect(readManagedProfileSelection(path, NODE)).toEqual(initial);
    const result = await apply(change);
    expect(result).toMatchObject({ ok: true, from: "interactive", to: "maintenance" });
    if (typeof result.operationId !== "string") throw new Error("fixture operation id missing");
    expect(readManagedProfileSelection(path, NODE)).toEqual({
      kind: "selected",
      profile: "maintenance",
      operationId: result.operationId,
    });
    const store = openResidencyOperationStore({ path });
    try {
      expect(store.listNonterminal()).toEqual([]);
    } finally {
      store.close();
    }
    const pause = running.tryQuiesceOwnerAdmissions?.();
    expect(pause?.isCurrent()).toBe(true);
    pause?.release();

    const send = (): Promise<Response> => Promise.resolve(new Response(null, { status: 204 }));
    expect((await dispatchWarm(send)).status).toBe(503);
    saveWorkload({ ...manifest, spec: { ...manifest.spec, enabled: true } }, workloadsDir);
    expect((await dispatchWarm(send)).status).toBe(204);
    const interrupted = openResidencyOperationStore({ path });
    try {
      const operationId = "unpublished-replacement";
      const pending = interrupted.claimAndBeginOperation(
        { ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER, incarnation: "one" },
        {
          operationId,
          model: `profile-switch:${NODE}`,
          targetState: "managed-profile:interactive",
          desiredRevision: 0,
          reservationGiB: 0,
          nowMs: Date.now(),
        },
      );
      if (!pending.ok) throw new Error("fixture could not reserve the interrupted profile");
      expect(
        interrupted.commitReservation({
          operationId,
          fenceToken: pending.record.fenceToken,
          expectedVersion: pending.record.version,
          nowMs: Date.now(),
        }),
      ).toEqual({ ok: true });
      expect(readManagedProfileSelection(path, NODE)).toMatchObject({ kind: "switching" });
    } finally {
      interrupted.close();
    }

    let unpublishedDials = 0;
    const unavailable = await dispatchWarm(() => {
      unpublishedDials++;
      return send();
    });
    expect(unavailable.status).toBe(503);
    expect(unpublishedDials).toBe(0);
  } finally {
    await running?.stop();
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mounted owner fence excludes warm and cold admissions until its exact handle releases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-owner-activity-"));
  const restore = isolate(dir);
  let running: RunningAgent | undefined;
  let coldAttempts = 0;
  let warmDials = 0;
  let exclusiveIngress = false;
  const send = (): Promise<Response> => {
    warmDials++;
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  try {
    const opts = await ownerFixtureOptions(dir, () =>
      fixtureOwner((): Promise<"refused"> => {
        coldAttempts++;
        return Promise.resolve("refused");
      }),
    );
    const deps = {
      ...capacity,
      ownerActivity: { verifyExclusiveIngress: (): boolean => exclusiveIngress },
    };
    const unsupported = await startManagedAgentServer(
      { ...opts, workerRpc: { workerId: NODE, settings: () => undefined } },
      NODE,
      deps,
    ).then(
      async (unexpected) => {
        await unexpected.stop();
      },
      (error: unknown) => error,
    );
    expect(unsupported).toMatchObject({ message: "ManagedOwnerActivityIngressUnsupported" });
    running = await startManagedAgentServer(opts, NODE, deps);
    const acquire = running.tryQuiesceOwnerAdmissions;
    const dispatch = running.handleRequest;
    if (acquire === undefined || dispatch === undefined)
      throw new Error("fixture fence was not mounted");
    expect(acquire()).toBeUndefined();
    exclusiveIngress = true;
    const liveLease = getResidencyLeaseRegistry()?.acquire("ingress-before-owner-reservation");
    if (liveLease?.ok !== true) throw new Error("fixture lease missing");
    expect(acquire()).toBeUndefined();
    liveLease.lease.release();
    const first = acquire();
    if (first === undefined) throw new Error("idle managed owner refused");
    expect(first.isCurrent()).toBe(true);
    expect(acquire()).toBeUndefined();

    expect((await dispatch(request(running))).status).toBe(503);
    expect(first.signal.aborted).toBe(true);
    expect(coldAttempts).toBe(0);
    expect((await dispatchWarm(send)).status).toBe(503);
    expect(warmDials).toBe(0);
    expect(acquire()).toBeUndefined();

    first.release();
    const second = acquire();
    if (second === undefined) throw new Error("exact release did not reopen owner");
    first.release();
    expect(second.isCurrent()).toBe(true);
    expect((await dispatchWarm(send)).status).toBe(503);
    expect(warmDials).toBe(0);
    expect(second.signal.aborted).toBe(true);
    second.release();
    expect((await dispatchWarm(send)).status).toBe(204);
    expect(warmDials).toBe(1);

    const last = acquire();
    if (last === undefined) throw new Error("terminal engine response still fenced");
    exclusiveIngress = false;
    expect(last.isCurrent()).toBe(false);
    expect(last.signal.aborted).toBe(true);
    last.release();
  } finally {
    await running?.stop();
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("client cancellation retains the warm fence until engine completion and across an unresolved restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-owner-warm-activity-"));
  const restore = isolate(dir);
  const entered = Promise.withResolvers<undefined>();
  const terminal = Promise.withResolvers<Response>();
  let running: RunningAgent | undefined;
  try {
    const opts = await ownerFixtureOptions(dir, () =>
      fixtureOwner((): Promise<"refused"> => Promise.resolve("refused")),
    );
    const deps = { ...capacity, ownerActivity: { verifyExclusiveIngress: (): boolean => true } };
    running = await startManagedAgentServer(opts, NODE, deps);
    const acquire = running.tryQuiesceOwnerAdmissions;
    if (acquire === undefined) throw new Error("fixture fence was not mounted");
    const signal = new AbortController();
    const inference = dispatchWarm(() => {
      entered.resolve(undefined);
      return terminal.promise;
    }, signal.signal);
    expect(acquire()).toBeUndefined();
    await entered.promise;
    expect(acquire()).toBeUndefined();
    signal.abort();
    expect((await inference).status).toBe(499);
    expect(acquire()).toBeUndefined();
    terminal.resolve(new Response(null, { status: 204 }));
    await new Promise<void>((deliver) => {
      setImmediate(deliver);
    });
    const settled = acquire();
    if (settled === undefined) throw new Error("confirmed warm completion stayed busy");
    settled.release();

    expect((await dispatchWarm(() => Promise.reject(new Error("unresolved engine")))).status).toBe(
      503,
    );
    expect(acquire()).toBeUndefined();
    await running.stop();
    running = await startManagedAgentServer(opts, NODE, deps);
    const reopened = running.tryQuiesceOwnerAdmissions;
    if (reopened === undefined) throw new Error("restarted owner did not mount fence");
    expect(reopened()).toBeUndefined();
  } finally {
    terminal.resolve(new Response(null, { status: 204 }));
    await running?.stop();
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("a cancelled cold request remains busy through an uncertain activation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-owner-cold-activity-"));
  const restore = isolate(dir);
  const entered = Promise.withResolvers<undefined>();
  const interrupted = Promise.withResolvers<undefined>();
  const settle = Promise.withResolvers<"uncertain">();
  let running: RunningAgent | undefined;
  try {
    const opts = await ownerFixtureOptions(dir, () =>
      fixtureOwner((_pin, signal) => {
        signal.addEventListener(
          "abort",
          () => {
            interrupted.resolve(undefined);
          },
          { once: true },
        );
        entered.resolve(undefined);
        return settle.promise;
      }),
    );
    const deps = { ...capacity, ownerActivity: { verifyExclusiveIngress: (): boolean => true } };
    running = await startManagedAgentServer(opts, NODE, deps);
    const acquire = running.tryQuiesceOwnerAdmissions;
    const dispatch = running.handleRequest;
    if (acquire === undefined || dispatch === undefined)
      throw new Error("fixture fence was not mounted");
    const signal = new AbortController();
    const inference = dispatch(request(running, true, signal.signal));
    await entered.promise;
    expect(acquire()).toBeUndefined();
    signal.abort();
    await interrupted.promise;
    await inference;
    expect(acquire()).toBeUndefined();
    settle.resolve("uncertain");
    await new Promise<void>((deliver) => {
      setImmediate(deliver);
    });
    expect(acquire()).toBeUndefined();
  } finally {
    settle.resolve("uncertain");
    await running?.stop();
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("cold-to-warm handoff cannot expose an idle gap before engine dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-owner-handoff-"));
  const restore = isolate(dir);
  const engine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ id: "fixture", choices: [] }),
  });
  let running: RunningAgent | undefined;
  let tryPause: RunningAgent["tryQuiesceOwnerAdmissions"];
  let idleGaps = 0;
  try {
    const opts = await ownerFixtureOptions(
      dir,
      () => ({
        ...fixtureOwner((): Promise<"refused"> => Promise.resolve("refused"), engine.url.origin),
        ready: (pin): ReturnType<TrustedColdOwner["ready"]> =>
          Promise.resolve({ pin, runtimeGeneration: "fixture-runtime" }),
        stillOwns: (): boolean => {
          const leaked = tryPause?.();
          if (leaked !== undefined) {
            idleGaps++;
            leaked.release();
          }
          return true;
        },
      }),
      { ...CAP, foregroundPorts: [Number(engine.port)] },
    );
    running = await startManagedAgentServer(opts, NODE, {
      ...capacity,
      ownerActivity: { verifyExclusiveIngress: (): boolean => true },
    });
    tryPause = running.tryQuiesceOwnerAdmissions;
    const dispatch = running.handleRequest;
    if (dispatch === undefined || tryPause === undefined)
      throw new Error("fixture fence was not mounted");
    const response = await dispatch(request(running));
    expect(response.status).toBe(200);
    await response.text();
    expect(idleGaps).toBe(0);
    const idle = tryPause();
    expect(idle).toBeDefined();
    idle?.release();
  } finally {
    await running?.stop();
    await engine.stop(true);
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("scoped peer cold ingress reaches the managed queue over TLS and cannot be replayed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-peer-cold-ingress-"));
  const restore = isolate(dir);
  let running: RunningAgent | undefined;
  let loads = 0;
  let allowActivation = false;
  let ready = false;
  let engineCalls = 0;
  let sharedCredential = false;
  const engine = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      engineCalls++;
      expect(new URL(req.url).pathname).toBe("/v1/completions");
      expect(req.headers.get("authorization")).toBeNull();
      expect(await req.json()).toEqual({ model: MODEL, prompt: [1], max_tokens: 3 });
      return Response.json({ id: "fixture-completion" });
    },
  });
  const peerToken = "cold-fixture-gateway-credential";
  const artifactRevision = `sha256:${"a".repeat(64)}`;
  const policyRevision = `sha256:${"b".repeat(64)}`;
  try {
    const enginePort = engine.port;
    if (enginePort === undefined) throw new Error("fixture model server unavailable");
    const cert = await generateSelfSignedCert({ dir, commonName: "127.0.0.1" });
    const opts: StartAgentOptions = {
      tokenHash: hashToken(TOKEN),
      bearerTokens: () =>
        sharedCredential
          ? [{ name: "mistaken-shared-token", tokenHash: hashToken(peerToken) }]
          : [],
      tls: { certPath: cert.certPath, keyPath: cert.keyPath },
      advertiseMdns: false,
      declaredModels: true,
      executionAdmission: [{ ...CAP, foregroundPorts: [enginePort] }],
      managedColdOwnerFactory: (): TrustedColdOwner => {
        const owner = fixtureOwner(
          (): Promise<"refused" | "ready"> => {
            loads++;
            ready = allowActivation;
            return Promise.resolve(ready ? "ready" : "refused");
          },
          `http://127.0.0.1:${String(enginePort)}`,
        );
        return {
          ...owner,
          ready: (pin) =>
            Promise.resolve(ready ? { pin, runtimeGeneration: "fixture" } : undefined),
          stillOwns: ({ runtimeGeneration }) => ready && runtimeGeneration === "fixture",
          pin: (entry): TrustedColdPin | undefined => {
            const pin = owner.pin(entry);
            return pin === undefined ? undefined : { ...pin, artifactRevision, policyRevision };
          },
        };
      },
      managedPeerColdCredentials: [
        { name: "fixture-gateway", tokenHash: hashToken(peerToken), models: [MODEL] },
      ],
    };
    running = await startManagedAgentServer(opts, NODE, {
      ...capacity,
      ownerActivity: { verifyExclusiveIngress: () => true },
    });
    const origin = running.url;
    const post = (route: string, body: unknown, token: string): Promise<Response> =>
      fetch(`${origin}/_llamactl/peer-cold/v1/${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        tls: { ca: cert.certPem },
      });
    const completion = { model: MODEL, prompt: [1], max_tokens: 3 };
    const body = JSON.stringify(completion);
    const input = {
      version: 1,
      requestId: crypto.randomUUID(),
      owner: NODE,
      model: MODEL,
      workload: WORKLOAD,
      artifactRevision,
      policyRevision,
      bodyDigest: peerColdBodyDigest(body),
      path: "/v1/completions",
      budgetMs: 10_000,
    };
    expect((await post("resolve", input, TOKEN)).status).toBe(401);
    expect((await post("resolve", { ...input, owner: "other-owner" }, peerToken)).status).toBe(403);
    const pausedReceipt = await post(
      "resolve",
      { ...input, requestId: crypto.randomUUID() },
      peerToken,
    );
    expect(pausedReceipt.status).toBe(200);
    const { receipt: pausedId } = (await pausedReceipt.json()) as { receipt: string };
    const pause = running.tryQuiesceOwnerAdmissions?.();
    if (pause === undefined) throw new Error("fixture owner did not pause");
    try {
      const blocked = await post("execute", { receipt: pausedId, completion: body }, peerToken);
      expect(blocked.status).toBe(503);
      expect(pause.signal.aborted).toBe(true);
      expect(loads).toBe(0);
    } finally {
      pause.release();
    }
    expect((await post("execute", { receipt: pausedId, completion: body }, peerToken)).status).toBe(
      409,
    );

    const receipt = await post("resolve", input, peerToken);
    expect(receipt.status).toBe(200);
    const { receipt: id } = (await receipt.json()) as { receipt: string };
    expect(loads).toBe(0);
    const execution = { receipt: id, completion: body };
    expect((await post("execute", execution, peerToken)).status).toBe(503);
    expect(loads).toBe(1);
    expect((await post("execute", execution, peerToken)).status).toBe(409);
    expect(loads).toBe(1);

    const now = Date.now();
    const snapshot = {
      pressure: "NORMAL" as const,
      fetchedAt: now,
      workloads: [],
      declaredProvenance: {
        schemaVersion: 1 as const,
        entries: [
          {
            id: MODEL,
            workload: WORKLOAD,
            ownerNodeId: NODE,
            kind: "ModelRun" as const,
            state: "cold" as const,
            artifactRevision,
            policyRevision,
          },
        ],
      },
    };
    const peers = [
      {
        id: NODE,
        endpoint: origin,
        certificate: cert.certPem,
        fingerprint: cert.fingerprint,
        token: TOKEN,
      },
      {
        id: "other-owner",
        endpoint: "https://other-owner.invalid",
        certificate: "fixture-other-ca",
        token: "other-read-only",
      },
    ];
    const snapshots = new Map<string, PeerSnapshot>([[NODE, snapshot]]);
    const gatewayCompletion = async (request?: {
      method?: string;
      query?: string;
      session?: string;
      unavailableCatalog?: boolean;
    }): Promise<{ status: number; body: unknown }> => {
      const fixture = new URL("./peer-cold-gateway-fixture.ts", import.meta.url);
      const child = Bun.spawn([process.execPath, fixture.pathname], {
        stdin: new Response(
          JSON.stringify({
            peers,
            snapshots: [...snapshots],
            now,
            token: peerToken,
            body: completion,
            request,
          }),
        ),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, body, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exit !== 0) throw new Error(`fixture gateway failed: ${errors}`);
      return JSON.parse(body) as { status: number; body: unknown };
    };
    const partition = await gatewayCompletion();
    expect(partition.status).toBe(503);
    expect(partition.body).toMatchObject({
      error: { code: "peer_cold_owner_unavailable" },
    });
    expect(loads).toBe(1);

    snapshots.set("other-owner", {
      ...snapshot,
      declaredProvenance: {
        schemaVersion: 1,
        entries: snapshot.declaredProvenance.entries.map((entry) => ({
          ...entry,
          ownerNodeId: "other-owner",
        })),
      },
    });
    const competing = await gatewayCompletion();
    expect(competing.status).toBe(503);
    expect(competing.body).toMatchObject({
      error: { code: "peer_cold_owner_unavailable" },
    });
    expect(loads).toBe(1);

    snapshots.set("other-owner", {
      workloads: [],
      pressure: "NORMAL",
      fetchedAt: now,
      declaredInventory: {
        schemaVersion: 2,
        ownerNodeId: "other-owner",
        complete: true,
        entries: [],
      },
    });
    allowActivation = true;
    expect(await gatewayCompletion()).toEqual({ status: 200, body: { id: "fixture-completion" } });
    expect(loads).toBe(2);
    expect(engineCalls).toBe(1);
    for (const request of [
      { method: "PUT" },
      { query: "?stream=true" },
      { session: "fixture-existing-session" },
      { unavailableCatalog: true },
    ]) {
      const refused = await gatewayCompletion(request);
      expect(refused.status).toBe(503);
      expect(refused.body).toMatchObject({ error: { code: "peer_cold_owner_unavailable" } });
    }
    expect(engineCalls).toBe(1);
    snapshots.set("unlisted-owner", {
      ...snapshot,
      declaredProvenance: {
        schemaVersion: 1,
        entries: snapshot.declaredProvenance.entries.map((entry) => ({
          ...entry,
          ownerNodeId: "unlisted-owner",
        })),
      },
    });
    const unexpectedPeer = await gatewayCompletion();
    expect(unexpectedPeer.status).toBe(503);
    expect(unexpectedPeer.body).toMatchObject({ error: { code: "peer_cold_owner_unavailable" } });
    expect(engineCalls).toBe(1);
    sharedCredential = true;
    expect(
      (await post("resolve", { ...input, requestId: crypto.randomUUID() }, peerToken)).status,
    ).toBe(401);
    expect(
      (
        await fetch(request(running, false), {
          headers: { authorization: `Bearer ${peerToken}` },
          tls: { ca: cert.certPem },
        })
      ).status,
    ).toBe(401);
  } finally {
    await running?.stop();
    await engine.stop(true);
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an opted-in named gateway keeps its declared warm local route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-peer-cold-warm-local-"));
  const restore = isolate(dir);
  const previous = process.env["LLAMACTL_UNIFIED_PROXY"];
  process.env["LLAMACTL_UNIFIED_PROXY"] = "1";
  const localModel = "fixture-local/warm.gguf";
  let running: RunningAgent | undefined;
  const engine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (): Response => Response.json({ id: "warm-local" }),
  });
  try {
    const cert = await generateSelfSignedCert({ dir, commonName: "127.0.0.1" });
    saveModelHost(
      parseModelHost(`
apiVersion: llamactl/v1
kind: ModelHost
metadata: { name: warm-local }
spec:
  node: local
  engine: llamacpp
  binary: /fixture/not-executed/llama-server
  endpoint: { host: 127.0.0.1, port: ${engine.url.port} }
  hostedModels: [{ rel: ${localModel} }]
`),
      join(dir, "workloads"),
    );
    writeModelHostState(
      {
        kind: "ModelHost",
        engine: "llamacpp",
        pid: process.pid,
        host: "127.0.0.1",
        port: Number(engine.url.port),
        modelAliases: [localModel],
        startedAt: "2026-11-15T00:00:00.000Z",
      },
      { name: "warm-local" },
      resolveEnv(),
    );
    running = startAgentServer({
      nodeName: "fixture-named-gateway",
      tokenHash: hashToken(TOKEN),
      tls: { certPath: cert.certPath, keyPath: cert.keyPath },
      advertiseMdns: false,
      declaredModels: true,
      managedPeerColdGateway: {
        peers: [],
        peerCold: { models: [MODEL], credentialFor: () => undefined },
      },
    });
    const response = await fetch(`${running.url}/v1/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ model: localModel, prompt: "fixture", max_tokens: 1 }),
      tls: { ca: cert.certPem },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "warm-local" });
  } finally {
    await running?.stop();
    await engine.stop(true);
    process.env["LLAMACTL_UNIFIED_PROXY"] = previous;
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
