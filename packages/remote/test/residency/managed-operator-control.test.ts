import { createResidencyLeases, getResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import { join } from "node:path";

import type { RunningAgent } from "../../src/server/serve.js";

import { reapFakeProcesses } from "../../../core/test/fake-process-reaper.js";
import { makeTempRuntime } from "../../../core/test/helpers.js";
import { enterManagedOperatorAction } from "../../src/residency/managed-operator-control.js";
import { managedProfileTargetState } from "../../src/residency/managed-profile-selection.js";
import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/profile-owner.js";
import { fenceWorkloadStop } from "../../src/residency/stop-fence.js";
import { openResidencyOperationStore } from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "../../src/safe-fs.js";
import { hashToken } from "../../src/server/auth.js";
import {
  type ManagedAgentDependencies,
  startManagedAgentServer,
} from "../../src/server/start-managed-agent.js";
import { modelRunStartInvocation } from "../../src/workload/apply.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";
import { ModelRunSchema } from "../../src/workload/schema.js";
import { saveWorkload } from "../../src/workload/store.js";

const node = "manual-owner";
const workload = "operator-model";
const token = "fixture-operator-token";
const profile = "operator-profile";

const capacity: ManagedAgentDependencies = {
  nowMs: () => 10_000,
  onCapacityAudit: () => undefined,
  readCapacity: () => ({
    source: "linux-procfs",
    observedAtMs: 10_000,
    physicalBytes: 64 * 1024 ** 3,
    availableBytes: 48 * 1024 ** 3,
    scope: { kind: "host-physical" },
    pressure: "normal",
    swapUsedBytes: 0,
  }),
};

test("canceling an operator's drain keeps the engine and its existing lease open", async () => {
  const registry = createResidencyLeases();
  const held = registry.acquire(workload);
  if (!held.ok) throw new Error("fixture lease unavailable");
  const controller = new AbortController();
  const stop = mock(() => Promise.resolve("stopped"));
  const waiting = fenceWorkloadStop({
    workload,
    registry,
    stop,
    wait: { timeoutMs: 2000, signal: controller.signal },
    isVerifiedStop: (outcome) => outcome === "stopped",
    refuse: ({ reason }) => reason,
  });
  try {
    expect(registry.snapshot(workload)).toMatchObject({ phase: "draining", waiters: 1 });
    const unrelated = registry.acquire("unrelated");
    expect(unrelated.ok).toBe(true);
    if (unrelated.ok) unrelated.lease.release();
    controller.abort();
    expect(await waiting).toBe("LeasesActive");
    expect(stop).not.toHaveBeenCalled();
    expect(registry.snapshot(workload)).toMatchObject({
      phase: "open",
      active: [held.lease.id],
      waiters: 0,
    });
  } finally {
    held.lease.release();
  }
});

function isolate(env: Record<string, string>): () => void {
  const previous = Object.keys(env).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, env);
  return (): void => {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  };
}

function selectProfile(path: string): void {
  const store = openResidencyOperationStore({ path });
  try {
    const start = store.claimAndBeginOperation(
      { ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER, incarnation: "fixture-selection" },
      {
        operationId: "fixture-selected",
        model: `profile-switch:${node}`,
        targetState: managedProfileTargetState(profile),
        desiredRevision: 0,
        reservationGiB: 0,
        nowMs: 1,
      },
    );
    if (!start.ok) throw new Error("fixture profile claim refused");
    const committed = store.commitReservation({
      operationId: start.record.operationId,
      fenceToken: start.record.fenceToken,
      expectedVersion: start.record.version,
      nowMs: 2,
    });
    if (!committed.ok) throw new Error("fixture profile commit refused");
    const done = store.finishOperation({
      operationId: start.record.operationId,
      fenceToken: start.record.fenceToken,
      expectedVersion: start.record.version + 1,
      outcome: "succeeded",
      nowMs: 3,
    });
    if (!done.ok) throw new Error("fixture profile finish refused");
  } finally {
    store.close();
  }
}

async function fixtureEngine(
  root: string,
): Promise<{ binary: string; port: number; marker: string }> {
  const binary = join(root, "llama-server");
  const marker = join(root, "engine-started");
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  if (port === undefined) throw new Error("fixture port unavailable");
  await probe.stop();
  const program = `
    await Bun.write(${JSON.stringify(marker)}, "started");
    const server = Bun.serve({hostname:"127.0.0.1",port:${String(port)},fetch:()=>new Response("ok")});
    process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
    await new Promise(() => undefined);
  `.replaceAll("\n", " ");
  writeFileSync(
    binary,
    `#!/bin/bash\nexec -a llama-server ${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)} -- "$@"\n`,
    { mode: 0o755 },
  );
  return { binary, port, marker };
}

async function operatorCall(
  agent: RunningAgent,
  procedure: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${agent.url}/trpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const result = (await response.json()) as { result?: { data: unknown }; error?: unknown };
  return result.result?.data ?? result.error;
}

function control(agent: RunningAgent, input: Record<string, unknown>): Promise<unknown> {
  return operatorCall(agent, "residencyControl", { node, workload, ...input });
}

async function checkContention(agent: RunningAgent): Promise<void> {
  const leaveProfile = enterManagedOperatorAction(node, "profile");
  if (leaveProfile === undefined) throw new Error("fixture profile scope refused");
  try {
    expect(await control(agent, { action: "load", dryRun: false, confirm: true })).toMatchObject({
      ok: false,
      reason: "NodeBusy",
    });
    expect(await control(agent, { action: "load" })).toMatchObject({
      ok: true,
      outcome: "preview",
    });
  } finally {
    leaveProfile();
  }

  const leaveManual = enterManagedOperatorAction(node, "manual");
  if (leaveManual === undefined) throw new Error("fixture manual scope refused");
  try {
    expect(
      await operatorCall(agent, "residencyApplyManagedProfile", {
        node,
        to: profile,
        version: 1,
        dryRun: false,
        confirm: true,
      }),
    ).toMatchObject({
      ok: false,
      refusal: { reason: "NodeBusy" },
    });
  } finally {
    leaveManual();
  }
}

test("an unmounted operator control is explicitly unavailable", async () => {
  expect(
    await router.createCaller({}).residencyControl({ action: "load", node, workload }),
  ).toMatchObject({
    ok: false,
    reason: "ManagedControlUnavailable",
  });
});

test("authenticated manual control uses the managed launch and stop fences", async () => {
  const temp = makeTempRuntime();
  const workloadsDir = join(temp.devStorage, "workloads");
  const storePath = join(temp.devStorage, "operations.db");
  const restore = isolate({
    DEV_STORAGE: temp.devStorage,
    LOCAL_AI_RUNTIME_DIR: temp.runtimeDir,
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LLAMACTL_RESIDENCY_STORE: storePath,
    LLAMACTL_OPS_CHAT_AUDIT: join(temp.devStorage, "ops-chat.jsonl"),
    LLAMA_CPP_MODELS: temp.modelsDir,
    LLAMA_CPP_CACHE: join(temp.devStorage, "cache"),
    LLAMA_CPP_LOGS: join(temp.devStorage, "logs"),
    LLAMA_CPP_USE_TUNED_ARGS: "false",
    LLAMACTL_UNIFIED_PROXY: "0",
  });
  let running: RunningAgent | undefined;
  try {
    const engine = await fixtureEngine(temp.devStorage);
    mkdirSync(temp.modelsDir, { recursive: true });
    writeFileSync(join(temp.modelsDir, "fixture.gguf"), "synthetic model");
    const manifest = ModelRunSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: { name: workload, annotations: { "llamactl.io/residency-profiles": profile } },
      spec: {
        node,
        target: { kind: "rel", value: "fixture.gguf" },
        binary: engine.binary,
        endpoint: { host: "127.0.0.1", port: engine.port },
        enabled: true,
        timeoutSeconds: 3,
        resources: { expectedMemoryGiB: 4 },
      },
    });
    const file = saveWorkload(manifest, workloadsDir);
    const plain = readFileSync(file, "utf8");
    saveNodeRun(
      {
        apiVersion: "llamactl/v1",
        kind: "NodeRun",
        metadata: { name: node, labels: {} },
        spec: { node, infra: [], budget: { memoryGiB: 24 } },
      },
      workloadsDir,
    );
    selectProfile(storePath);
    running = await startManagedAgentServer(
      { bindHost: "127.0.0.1", port: 0, tokenHash: hashToken(token), advertiseMdns: false },
      node,
      capacity,
    );
    const denied = await fetch(`${running.url}/trpc/residencyControl`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node, workload, action: "load" }),
    });
    expect(denied.status).toBe(401);

    const tool = "llamactl.residency.control";
    const argumentsFor = { node, workload, action: "load" };
    expect(
      (
        await fetch(`${running.url}/trpc/operatorRunTool`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: tool, arguments: argumentsFor }),
        })
      ).status,
    ).toBe(401);
    expect(
      await operatorCall(running, "operatorRunTool", {
        name: tool,
        arguments: argumentsFor,
      }),
    ).toMatchObject({ ok: true, result: { outcome: "preview" } });
    expect(
      await operatorCall(running, "operatorRunTool", {
        name: tool,
        dryRun: false,
        arguments: argumentsFor,
      }),
    ).toMatchObject({ ok: false, error: { code: "ConfirmationRequired" } });
    expect(
      await operatorCall(running, "operatorRunTool", {
        name: tool,
        dryRun: true,
        arguments: { ...argumentsFor, node: "wrong-owner" },
      }),
    ).toMatchObject({ ok: false, error: { code: "NotServingNode" } });
    expect(
      await router.createCaller({}).operatorRunTool({
        name: tool,
        dryRun: true,
        arguments: argumentsFor,
      }),
    ).toMatchObject({ ok: false, error: { code: "ManagedControlUnavailable" } });
    const profileTool = "llamactl.residency.applyProfile";
    const profileArguments = { node, to: profile, managed: true };
    expect(
      await operatorCall(running, "operatorRunTool", {
        name: profileTool,
        arguments: profileArguments,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "UnknownState" },
      result: { dryRun: true, node, refusal: { workloads: [workload] } },
    });
    expect(
      await operatorCall(running, "operatorRunTool", {
        name: profileTool,
        dryRun: false,
        arguments: profileArguments,
      }),
    ).toMatchObject({ ok: false, error: { code: "ConfirmationRequired" } });
    expect(
      await router.createCaller({}).operatorRunTool({
        name: profileTool,
        arguments: profileArguments,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "ManagedOwnerRequired" },
      result: { dryRun: true },
    });
    const leaveManual = enterManagedOperatorAction(node, "manual");
    if (leaveManual === undefined) throw new Error("fixture manual scope refused");
    try {
      expect(
        await operatorCall(running, "operatorRunTool", {
          name: profileTool,
          dryRun: false,
          arguments: { ...profileArguments, confirm: true },
        }),
      ).toMatchObject({ ok: false, error: { code: "NodeBusy" } });
    } finally {
      leaveManual();
    }
    expect(existsSync(engine.marker)).toBe(false);

    expect(await control(running, { action: "unload", force: true })).toMatchObject({
      data: { code: "BAD_REQUEST" },
    });
    await checkContention(running);
    expect(existsSync(engine.marker)).toBe(false);

    expect(await control(running, { action: "load", node: "other-node" })).toMatchObject({
      ok: false,
      reason: "NotServingNode",
    });
    expect(await control(running, { action: "load", dryRun: false })).toMatchObject({
      ok: false,
      reason: "ConfirmationRequired",
    });
    const preview = await control(running, { action: "load" });
    expect(preview).toMatchObject({ ok: true, outcome: "preview", action: "load" });
    expect(existsSync(engine.marker)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(plain);

    saveWorkload({ ...manifest, spec: { ...manifest.spec, enabled: false } }, workloadsDir);
    expect(
      await operatorCall(running, "operatorRunTool", {
        name: tool,
        dryRun: false,
        arguments: { ...argumentsFor, confirm: true },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "WorkloadDisabled" },
      result: { ok: false, reason: "WorkloadDisabled" },
    });
    expect(await control(running, { action: "load", dryRun: false, confirm: true })).toMatchObject({
      ok: false,
      reason: "WorkloadDisabled",
    });
    expect(existsSync(engine.marker)).toBe(false);
    saveWorkload(manifest, workloadsDir);

    expect(await control(running, { action: "load", dryRun: false, confirm: true })).toMatchObject({
      ok: true,
      outcome: "completed",
      action: "load",
    });
    expect(existsSync(engine.marker)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(plain);
    const sidecar = join(temp.runtimeDir, "workloads", workload, "llama-server.state");
    const published = readFileSync(sidecar, "utf8");
    const state = JSON.parse(published) as Record<string, unknown>;
    writeFileSync(sidecar, JSON.stringify({ ...state, publicationPending: true }));
    try {
      expect(
        await operatorCall(running, "operatorRunTool", {
          name: profileTool,
          arguments: profileArguments,
        }),
      ).toMatchObject({ ok: false, error: { code: "UnknownState" } });
    } finally {
      writeFileSync(sidecar, published);
    }
    expect(
      await operatorCall(running, "operatorRunTool", {
        name: profileTool,
        arguments: profileArguments,
      }),
    ).toMatchObject({ ok: true, result: { ok: true, dryRun: true, node } });
    const appliedProfile = await operatorCall(running, "operatorRunTool", {
      name: profileTool,
      dryRun: false,
      arguments: { ...profileArguments, confirm: true },
    });
    expect(appliedProfile).toMatchObject({
      ok: true,
      result: { ok: true, dryRun: false, outcome: "noop" },
    });
    expect(
      (appliedProfile as { result: { operationId: unknown } }).result.operationId,
    ).toBeString();
    const registry = getResidencyLeaseRegistry();
    if (registry === null) throw new Error("fixture registry unavailable");
    const lease = registry.acquire(workload);
    if (!lease.ok) throw new Error("fixture lease unavailable");
    try {
      expect(
        await control(running, { action: "unload", dryRun: false, confirm: true }),
      ).toMatchObject({
        ok: false,
        reason: "LeasesActive",
      });
      expect(await control(running, { action: "unload", drainTimeoutMs: 10 })).toMatchObject({
        ok: true,
        outcome: "preview",
      });
      expect(registry.snapshot(workload).phase).toBe("open");
      expect(
        await control(running, {
          action: "unload",
          drainTimeoutMs: 10,
          dryRun: false,
          confirm: true,
        }),
      ).toMatchObject({ ok: false, reason: "LeasesActive", activeCount: 1 });
      expect(registry.snapshot(workload).phase).toBe("open");
      expect((await fetch(`http://127.0.0.1:${String(engine.port)}`)).ok).toBe(true);
    } finally {
      lease.lease.release();
    }
    saveWorkload(
      {
        ...manifest,
        metadata: {
          ...manifest.metadata,
          annotations: {
            ...manifest.metadata.annotations,
            "llamactl.io/residency-protected": "true",
          },
        },
      },
      workloadsDir,
    );
    expect(
      await control(running, { action: "unload", dryRun: false, confirm: true }),
    ).toMatchObject({
      ok: false,
      reason: "WorkloadProtected",
    });
    saveWorkload(manifest, workloadsDir);

    expect(await control(running, { action: "unload" })).toMatchObject({
      ok: true,
      outcome: "preview",
      action: "unload",
    });
    expect((await fetch(`http://127.0.0.1:${String(engine.port)}`)).ok).toBe(true);

    const operations = new Database(storePath, { readwrite: true, create: false });
    try {
      operations.run("ALTER TABLE residency_states RENAME TO unavailable_lifecycle");
      expect(
        await control(running, { action: "unload", dryRun: false, confirm: true }),
      ).toMatchObject({ ok: false, reason: "TransitionUnavailable" });
      expect((await fetch(`http://127.0.0.1:${String(engine.port)}`)).ok).toBe(true);
      operations.run("ALTER TABLE unavailable_lifecycle RENAME TO residency_states");
    } finally {
      operations.close();
    }

    const delayed = registry.acquire(workload);
    if (!delayed.ok) throw new Error("fixture final lease unavailable");
    const retiring = control(running, {
      action: "unload",
      drainTimeoutMs: 2000,
      dryRun: false,
      confirm: true,
    });
    try {
      const start = performance.now();
      while (registry.snapshot(workload).phase !== "draining" && performance.now() - start < 1000) {
        await Bun.sleep(5);
      }
      expect(registry.snapshot(workload).phase).toBe("draining");
      expect(registry.acquire(workload)).toMatchObject({ ok: false, reason: "Draining" });
      expect((await fetch(`http://127.0.0.1:${String(engine.port)}`)).ok).toBe(true);
    } finally {
      delayed.lease.release();
    }
    expect(await retiring).toMatchObject({ ok: true, outcome: "completed", action: "unload" });
    expect(registry.snapshot(workload).phase).toBe("unloaded");
    expect(readFileSync(file, "utf8")).toBe(plain);

    const events = await router.createCaller({}).serverStart(modelRunStartInvocation(manifest));
    let terminal: unknown;
    for await (const event of events) if (event.type === "done") terminal = event.result;
    expect(terminal).toMatchObject({ ok: false, error: "ManagedOwnerRequired" });
  } finally {
    try {
      await running?.stop();
      expect(await reapFakeProcesses({ scratch: temp.devStorage })).toEqual([]);
    } finally {
      restore();
      temp.cleanup();
    }
  }
}, 15_000);
