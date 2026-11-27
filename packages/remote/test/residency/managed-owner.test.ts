import type { ManagedCapacitySample } from "@llamactl/core/resources/managed-capacity";

import { rpcServer, server } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ManagedCapacityAudit } from "../../src/residency/target-admission-policy.js";

import { runDirectResidencyStart } from "../../src/residency/direct-lifecycle.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import { startModelHost, stopModelHost } from "../../src/server/modelhost.js";
import { type RunningAgent, startAgentServer } from "../../src/server/serve.js";
import {
  type ManagedAgentDependencies,
  startManagedAgentServer,
} from "../../src/server/start-managed-agent.js";
import { parseNodeRun, saveNodeRun } from "../../src/workload/noderun-store.js";

const GiB = 1024 ** 3;
const capacityFixture: ManagedCapacitySample = {
  source: "linux-procfs",
  observedAtMs: 100_000,
  physicalBytes: 64 * GiB,
  availableBytes: 56 * GiB,
  scope: { kind: "host-physical" },
  pressure: "normal",
  swapUsedBytes: 0,
};

test("an owner marker blocks unmanaged engine lifecycle on the same runtime root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-managed-owner-"));
  const runtimeDir = join(dir, "runtime");
  const env = { LOCAL_AI_RUNTIME_DIR: runtimeDir, DEV_STORAGE: dir };
  const resolved = resolveEnv(env);
  const key = { name: "fixture" };
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "managed-residency-v1"), "fixture-node\n");

  try {
    expect(await server.startServer({ key, target: "absent", resolved, env })).toMatchObject({
      ok: false,
      error: "ManagedOwnerRequired",
    });
    expect(await server.stopServer({ key, resolved })).toMatchObject({ stopped: false });
    expect(await startModelHost({ key, runtimeDir, env })).toMatchObject({
      ok: false,
      error: "ManagedOwnerRequired",
    });
    expect(await stopModelHost({ key, runtimeDir, env })).toMatchObject({
      ok: false,
      error: "ManagedOwnerRequired",
    });
    expect(await rpcServer.startRpcServer({ port: 0, resolved, env })).toMatchObject({
      ok: false,
      error: "ManagedRpcServerUnavailable",
    });
    expect(await rpcServer.stopRpcServer({ resolved })).toMatchObject({ stopped: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "agent activation requires a local budget and retains ownership across a clean restart",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-managed-agent-"));
    const runtimeDir = join(dir, "runtime");
    const workloadsDir = join(dir, "workloads");
    const env = {
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: runtimeDir,
      LLAMACTL_WORKLOADS_DIR: workloadsDir,
      LLAMACTL_RESIDENCY_STORE: join(dir, "operations.sqlite"),
    };
    const previous = Object.keys(env).map((key) => [key, process.env[key]] as const);
    Object.assign(process.env, env);
    const bearer = "managed-agent-fixture";
    const opts = {
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: createHash("sha256").update(bearer).digest("hex"),
    };
    const name = "managed-fixture";
    let running: RunningAgent | undefined;
    let sample: ManagedCapacitySample | undefined;
    const audit: ManagedCapacityAudit[] = [];
    const deps: ManagedAgentDependencies = {
      readCapacity: () => sample,
      nowMs: () => capacityFixture.observedAtMs,
      onCapacityAudit: (entry): void => {
        audit.push(entry);
      },
    };
    try {
      const unknown = await startManagedAgentServer(opts, name, deps).catch(
        (error: unknown) => error,
      );
      expect(unknown).toEqual(new Error("ManagedCapacity: CapacityUnknown"));
      expect(existsSync(join(runtimeDir, "managed-residency-v1"))).toBe(false);
      saveNodeRun(
        parseNodeRun(`
apiVersion: llamactl/v1
kind: NodeRun
metadata: { name: ${name} }
spec:
  node: ${name}
  budget: { memoryGiB: 24 }
`),
        workloadsDir,
      );
      sample = capacityFixture;
      running = await startManagedAgentServer(opts, name, deps);
      expect(audit).toContainEqual({
        nodeName: name,
        phase: "bootstrap",
        ledgerCeilingGiB: 24,
        launchHeadroomGiB: 40,
      });
      const double = await startManagedAgentServer(opts, name, deps).catch(
        (error: unknown) => error,
      );
      expect(double).toEqual(new Error("ManagedAgentAlreadyActive"));
      expect(() => startAgentServer(opts)).toThrow("ManagedOwnerRequired");

      const unknownTarget = await fetch(`${running.url}/v1/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "fixture" }),
        signal: AbortSignal.timeout(3000),
      });
      expect(unknownTarget.status).toBe(503);
      expect(await unknownTarget.json()).toMatchObject({
        error: { code: "managed_execution_target_unconfigured" },
      });

      const stop = await fetch(`${running.url}/trpc/serverStop`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ workload: "fixture" }),
        signal: AbortSignal.timeout(3000),
      });
      expect(stop.status).toBe(200);
      expect(await stop.json()).toMatchObject({
        result: { data: { stopped: false, managedRefusal: "ManagedStopIntentRequired" } },
      });

      await running.stop();
      running = undefined;
      const ledger = join(runtimeDir, "residency-admission.db");
      renameSync(ledger, ledger + ".saved");
      const lostLedger = await startManagedAgentServer(opts, name, deps).catch(
        (error: unknown) => error,
      );
      expect(lostLedger).toEqual(new Error("ManagedAdmissionJournalMismatch"));
      expect(existsSync(ledger)).toBe(false);
      renameSync(ledger + ".saved", ledger);
      const wrong = await startManagedAgentServer(opts, "foreign", deps).catch(
        (error: unknown) => error,
      );
      expect(wrong).toEqual(new Error("ManagedNodeIdentityMismatch"));
      expect(() => startAgentServer(opts)).toThrow("ManagedOwnerRequired");

      const operations = env.LLAMACTL_RESIDENCY_STORE;
      renameSync(operations, operations + ".saved");
      writeFileSync(operations, readFileSync(operations + ".saved"));
      const replaced = await startManagedAgentServer(opts, name, deps).catch(
        (error: unknown) => error,
      );
      expect(replaced).toEqual(new Error("ManagedTransitionJournalMismatch"));
      renameSync(operations + ".saved", operations);
      running = await startManagedAgentServer(opts, name, deps);
      expect(running.port).toBeGreaterThan(0);
    } finally {
      await running?.stop();
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "managed boot refuses an oversized explicit budget and unknown local pressure or swap",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-managed-capacity-boot-"));
    const workloadsDir = join(dir, "workloads");
    const runtimeDir = join(dir, "runtime");
    const env = {
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: runtimeDir,
      LLAMACTL_WORKLOADS_DIR: workloadsDir,
      LLAMACTL_RESIDENCY_STORE: join(dir, "operations.sqlite"),
    };
    const previous = Object.keys(env).map((key) => [key, process.env[key]] as const);
    Object.assign(process.env, env);
    const opts = {
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: createHash("sha256").update("fixture").digest("hex"),
    };
    let running: RunningAgent | undefined;
    const cases: { budget: number; sample: ManagedCapacitySample; refusal: string }[] = [
      { budget: 52, sample: capacityFixture, refusal: "ConfiguredBudgetExceedsCapacity" },
      {
        budget: 24,
        sample: {
          ...capacityFixture,
          scope: { kind: "cgroup-v2", limitBytes: 12 * GiB, availableBytes: 10 * GiB },
        },
        refusal: "ConfiguredBudgetExceedsCapacity",
      },
      {
        budget: 24,
        sample: { ...capacityFixture, observedAtMs: capacityFixture.observedAtMs - 30_001 },
        refusal: "StaleCapacity",
      },
      { budget: 24, sample: { ...capacityFixture, pressure: null }, refusal: "PressureUnknown" },
      { budget: 24, sample: { ...capacityFixture, swapUsedBytes: null }, refusal: "SwapUnknown" },
    ];
    try {
      for (const { budget, sample, refusal } of cases) {
        saveNodeRun(
          parseNodeRun(`
apiVersion: llamactl/v1
kind: NodeRun
metadata: { name: fixture }
spec: { node: fixture, budget: { memoryGiB: ${String(budget)} } }
`),
          workloadsDir,
        );
        const outcome = await startManagedAgentServer(opts, "fixture", {
          readCapacity: () => sample,
          nowMs: () => capacityFixture.observedAtMs,
          onCapacityAudit: () => undefined,
        }).then(
          (agent) => {
            running = agent;
            return "booted";
          },
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        expect(outcome).toBe(`ManagedCapacity: ${refusal}`);
        expect(existsSync(join(runtimeDir, "managed-residency-v1"))).toBe(false);
      }
    } finally {
      await running?.stop();
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("a managed launch refuses when the transition journal disappears", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-managed-journal-"));
  const previous = process.env["LOCAL_AI_RUNTIME_DIR"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = dir;
  writeFileSync(join(dir, "managed-residency-v1"), "fixture-node\n");
  let calls = 0;
  try {
    const outcome = await runDirectResidencyStart(
      "fixture",
      () => {
        calls += 1;
        return { ok: true };
      },
      {
        storePath: join(dir, "missing.sqlite"),
        group: undefined,
        isProvenDown: () => false,
        isRunning: () => false,
        log: () => undefined,
      },
    );
    expect(outcome.ran).toBe(false);
    if (!outcome.ran) expect(outcome.detail).toContain("store unavailable");
    expect(calls).toBe(0);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "LOCAL_AI_RUNTIME_DIR");
    else process.env["LOCAL_AI_RUNTIME_DIR"] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
