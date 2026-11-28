import type { ManagedCapacitySample } from "@llamactl/core/resources/managed-capacity";

import { server } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import {
  managedRuntimeRefusesMutation,
  withManagedRuntimeMutation,
} from "@llamactl/core/residency/managed-runtime";
import { workloadRuntimeDir } from "@llamactl/core/workloadRuntime";
import {
  measuredCalibrationStorePath,
  recordMeasuredMemoryCalibration,
} from "@llamactl/fleet-supervisor/measured-memory";
import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InferenceHolds, InferenceHoldState } from "../../src/residency/inference-holds.js";

import { openAdmissionStore } from "../../src/residency/admission-store.js";
import { openLocalAdmissionRuntime } from "../../src/residency/process-generation.js";
import {
  managedAdmissionStorePath,
  type ManagedCapacityAudit,
  openNodeManagedAdmission,
} from "../../src/residency/target-admission-policy.js";
import { router } from "../../src/router.js";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import { pinModelHostStartup } from "../../src/server/modelhost.js";
import { modelRunStartInvocation } from "../../src/workload/apply.js";
import { parseModelHost, saveModelHost } from "../../src/workload/modelhost-store.js";
import { parseNodeRun, saveNodeRun } from "../../src/workload/noderun-store.js";
import { parseWorkload, saveWorkload } from "../../src/workload/store.js";

const target = "fixture-owner";
const alias = "fixture-alias";

test("a mounted owner still checks its lease to mutate after the marker disappears", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-owner-marker-"));
  const marker = join(runtimeDir, "managed-residency-v1");
  writeFileSync(marker, "fixture-owned");
  try {
    withManagedRuntimeMutation(
      runtimeDir,
      () => existsSync(marker),
      () => {
        expect(managedRuntimeRefusesMutation(runtimeDir)).toBe(false);
        rmSync(marker);
        expect(managedRuntimeRefusesMutation(runtimeDir)).toBe(true);
      },
    );
    expect(managedRuntimeRefusesMutation(runtimeDir)).toBe(false);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("the target authorizes an exact enabled manifest and rejects forged plans", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-admission-policy-"));
  const workloads = join(dir, "workloads");
  const runtimeDir = join(dir, "runtime");
  const old = process.env["LOCAL_AI_RUNTIME_DIR"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  mkdirSync(workloads, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  const manifest = parseModelHost(`
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: fixture-ml
spec:
  engine: llamacpp
  node: ${alias}
  binary: /usr/bin/false
  endpoint:
    host: 127.0.0.1
    port: 19095
  hostedModels:
    - rel: trusted.gguf
  resources:
    expectedMemoryGiB: 16
`);
  saveModelHost(manifest, workloads);
  saveNodeRun(
    parseNodeRun(`
apiVersion: llamactl/v1
kind: NodeRun
metadata:
  name: ${target}
spec:
  node: ${target}
  budget:
    memoryGiB: 24
`),
    workloads,
  );

  const pinned = pinModelHostStartup(manifest);
  const policy = await openNodeManagedAdmission({
    nodeName: target,
    aliases: [alias],
    workloadsDir: workloads,
  });
  const ready = mock(() =>
    Promise.resolve({ ran: false as const, detail: "fixture did not start an engine" }),
  );
  const signal = new AbortController().signal;
  const request = {
    kind: "ModelHost" as const,
    runtimeKey: manifest.metadata.name,
    launch: { manifest },
    effectiveSpecDigest: pinned.effectiveSpecDigest,
    effectiveLaunch: pinned.effectiveLaunch,
  };
  try {
    expect(
      await policy.admission.run({ ...request, effectiveSpecDigest: "forged" }, signal, ready),
    ).toEqual({ ran: false, detail: "ManagedSpecUnknown" });
    expect(ready).not.toHaveBeenCalled();
    expect(policy.authority.snapshot()).toEqual([]);
    await policy.admission.run(request, signal, ready);
    expect(ready).toHaveBeenCalledTimes(1);

    const unaccounted = join(runtimeDir, "workloads", "legacy-resident");
    mkdirSync(unaccounted, { recursive: true });
    writeFileSync(join(unaccounted, "llama-server.pid"), String(process.pid));
    expect(await policy.admission.run(request, signal, ready)).toEqual({
      ran: false,
      detail: "ManagedRuntimeInventoryUnknown",
    });
    rmSync(unaccounted, { recursive: true, force: true });
    expect(ready).toHaveBeenCalledTimes(1);

    saveModelHost({ ...manifest, spec: { ...manifest.spec, enabled: false } }, workloads);
    const disabled = pinModelHostStartup({
      ...manifest,
      spec: { ...manifest.spec, enabled: false },
    });
    expect(
      await policy.admission.run(
        { ...request, effectiveSpecDigest: disabled.effectiveSpecDigest },
        signal,
        ready,
      ),
    ).toEqual({ ran: false, detail: "ManagedSpecUnknown" });
    expect(ready).toHaveBeenCalledTimes(1);
  } finally {
    policy.authority.close();
    if (old === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
    else process.env["LOCAL_AI_RUNTIME_DIR"] = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ModelRun uses the target budget, which outranks fresh capacity and rejects unverified fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-node-budget-"));
  const runtimeDir = join(dir, "runtime");
  const modelsDir = join(dir, "models");
  const env = {
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMA_CPP_MODELS: modelsDir,
    LLAMA_CPP_USE_TUNED_ARGS: "false",
    DEV_STORAGE: dir,
  };
  const before = new Map(Object.keys(env).map((name) => [name, process.env[name]] as const));
  Object.assign(process.env, env);
  mkdirSync(modelsDir);
  writeFileSync(join(modelsDir, "exact.gguf"), "GGUF-fixture");
  const manifest = parseWorkload(`
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: fixture-run
spec:
  node: ${alias}
  target: { kind: rel, value: exact.gguf }
  binary: /usr/bin/false
  resources: { expectedMemoryGiB: 26 }
`);
  saveWorkload(manifest, dir);
  const nowMs = 100_000;
  let sample = { nodeName: "foreign", memBytes: 64 * 1024 ** 3, observedAtMs: nowMs };
  const policy = await openNodeManagedAdmission({
    nodeName: target,
    aliases: [alias],
    workloadsDir: dir,
    nowMs: () => nowMs,
    verifiedCapacity: () => sample,
  });
  try {
    const { workload, ...launch } = modelRunStartInvocation(manifest);
    const prepared = server.prepareManagedServerStart({ ...launch, key: { name: workload } });
    if ("result" in prepared) throw new Error(prepared.result.error);
    const request = {
      kind: "ModelRun" as const,
      runtimeKey: workload,
      effectiveSpecDigest: prepared.effectiveSpecDigest,
      effectiveLaunch: prepared.launch,
      launch,
    };
    const signal = new AbortController().signal;
    const compiledKey = policy.admission.readCalibration?.(workload)?.key;
    expect(compiledKey?.managedLaunchDigest).toMatch(/^[0-9a-f]{64}$/);
    if (compiledKey === undefined) throw new Error("missing fixture key");
    const changedRun = structuredClone(manifest);
    changedRun.spec.extraArgs.push("--ctx-size", "32768");
    saveWorkload(changedRun, dir);
    expect(policy.admission.readCalibration?.(workload)?.key).not.toEqual(compiledKey);
    saveWorkload(manifest, dir);
    const refusal = { ran: false as const, detail: "fixture did not start" };
    const callback = mock(() => Promise.resolve(refusal));
    for (const unverified of [
      sample,
      { ...sample, nodeName: target, observedAtMs: nowMs - 30_001 },
      { ...sample, nodeName: alias, observedAtMs: nowMs + 1 },
    ]) {
      sample = unverified;
      const result = await policy.admission.run(request, signal, callback);
      expect(result.ran).toBe(false);
      if (!result.ran) expect(result.detail).toMatch(/^BudgetUnknown:/);
    }
    expect(callback).not.toHaveBeenCalled();
    sample = { ...sample, nodeName: alias, observedAtMs: nowMs };
    expect(await policy.admission.run(request, signal, callback)).toEqual(refusal);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(
      recordMeasuredMemoryCalibration(
        {
          key: compiledKey,
          samples: [
            {
              status: "ok",
              source: "fixture",
              observedAtMs: nowMs,
              processBytes: 60 * 1024 ** 3,
              processDeviceBytes: 0,
              sharedDeviceBytes: null,
            },
          ],
          options: { minSamples: 1, overheadFraction: 0 },
        },
        measuredCalibrationStorePath(),
      ).ok,
    ).toBe(true);
    const calibrated = await policy.admission.run(request, signal, callback);
    expect(calibrated.ran).toBe(false);
    if (!calibrated.ran) expect(calibrated.detail).toContain("BudgetExceeded");
    expect(callback).toHaveBeenCalledTimes(1);

    saveNodeRun(
      parseNodeRun(`
apiVersion: llamactl/v1
kind: NodeRun
metadata:
  name: ${target}
spec:
  node: ${target}
  budget: { memoryGiB: 24 }
`),
      dir,
    );
    const result = await policy.admission.run(request, signal, callback);
    expect(result.ran).toBe(false);
    if (!result.ran) expect(result.detail).toMatch(/^BudgetExceeded:/);
    expect(callback).toHaveBeenCalledTimes(1);
  } finally {
    policy.authority.close();
    for (const [name, value] of before) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const GiB = 1024 ** 3;
const now = 100_000;
const node = "physical-fixture";
const workload = "replacement";

function modelHostFixture(dir: string): ReturnType<typeof parseModelHost> {
  const manifest = parseModelHost(`
apiVersion: llamactl/v1
kind: ModelHost
metadata: { name: ${workload} }
spec:
  node: ${node}
  engine: llamacpp
  binary: /usr/bin/false
  endpoint: { host: "127.0.0.1", port: 19095 }
  hostedModels: [{ rel: exact.gguf }]
  resources: { expectedMemoryGiB: 16 }
`);
  saveModelHost(manifest, dir);
  return manifest;
}

function localCapacity(availableGiB: number): ManagedCapacitySample {
  return {
    source: "linux-procfs",
    observedAtMs: now,
    physicalBytes: 64 * GiB,
    availableBytes: availableGiB * GiB,
    scope: { kind: "host-physical" },
    pressure: "normal",
    swapUsedBytes: 0,
  };
}

async function withCapacityOwner(
  readCapacity: () => ManagedCapacitySample,
  run: (
    policy: Awaited<ReturnType<typeof openNodeManagedAdmission>>,
    request: {
      kind: "ModelHost";
      runtimeKey: string;
      effectiveSpecDigest: string;
      effectiveLaunch: Readonly<Record<string, unknown>>;
      launch: { manifest: ReturnType<typeof parseModelHost> };
    },
    runtimeDir: string,
  ) => Promise<void>,
  onCapacityAudit?: (entry: ManagedCapacityAudit) => void,
  inferenceHolds?: InferenceHolds,
  validateParkedCredit?: Parameters<typeof openNodeManagedAdmission>[0]["validateParkedCredit"],
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-physical-owner-"));
  const runtimeDir = join(dir, "runtime");
  const original = process.env["LOCAL_AI_RUNTIME_DIR"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  let policy: Awaited<ReturnType<typeof openNodeManagedAdmission>> | undefined;
  try {
    const manifest = modelHostFixture(dir);
    const pinned = pinModelHostStartup(manifest);
    policy = await openNodeManagedAdmission({
      nodeName: node,
      workloadsDir: dir,
      readCapacity,
      ...(onCapacityAudit === undefined ? {} : { onCapacityAudit }),
      ...(inferenceHolds === undefined ? {} : { inferenceHolds }),
      validateParkedCredit,
      nowMs: () => now,
    });
    await run(
      policy,
      {
        kind: "ModelHost",
        runtimeKey: workload,
        effectiveSpecDigest: pinned.effectiveSpecDigest,
        effectiveLaunch: pinned.effectiveLaunch,
        launch: { manifest },
      },
      runtimeDir,
    );
  } finally {
    policy?.authority.close();
    if (original === undefined) Reflect.deleteProperty(process.env, "LOCAL_AI_RUNTIME_DIR");
    else process.env["LOCAL_AI_RUNTIME_DIR"] = original;
    rmSync(dir, { recursive: true, force: true });
  }
}

test.each(["endpoint", "engine argument"])(
  "managed ModelHost rejects an external %s before any reservation or start",
  async (source) => {
    await withCapacityOwner(
      () => localCapacity(56),
      async ({ admission, authority }, request, runtimeDir) => {
        const manifest = request.launch.manifest;
        const exposed = {
          ...manifest,
          spec: {
            ...manifest.spec,
            allowExternalBind: true,
            ...(source === "endpoint"
              ? { endpoint: { ...manifest.spec.endpoint, host: "0.0.0.0" } }
              : { extraArgs: ["--host=0.0.0.0"] }),
          },
        };
        const pinned = pinModelHostStartup(exposed);
        saveModelHost(exposed, join(runtimeDir, ".."));
        const launch = mock(() =>
          Promise.resolve({ ran: false as const, detail: "reached launch" }),
        );
        expect(
          await admission.run(
            {
              ...request,
              effectiveSpecDigest: pinned.effectiveSpecDigest,
              effectiveLaunch: pinned.effectiveLaunch,
              launch: { manifest: exposed },
            },
            new AbortController().signal,
            launch,
          ),
        ).toEqual({ ran: false, detail: "ManagedExternalBindUnavailable" });
        expect(launch).not.toHaveBeenCalled();
        expect(authority.snapshot()).toEqual([]);
        expect(
          admission.preflightProfile?.({ victims: [], retained: [], replacements: [workload] }),
        ).toBeDefined();
      },
    );
  },
);

test.each(["endpoint", "engine argument"])(
  "managed ModelRun rejects an external %s before any reservation or start",
  async (source) => {
    await withCapacityOwner(
      () => localCapacity(56),
      async ({ admission, authority }, _request, runtimeDir) => {
        const directory = join(runtimeDir, "..");
        const models = join(directory, "models");
        const previous = process.env["LLAMA_CPP_MODELS"];
        process.env["LLAMA_CPP_MODELS"] = models;
        try {
          mkdirSync(models);
          writeFileSync(join(models, "exact.gguf"), "GGUF-fixture");
          const manifest = parseWorkload(`
apiVersion: llamactl/v1
kind: ModelRun
metadata: { name: external-model-run }
spec:
  node: ${node}
  target: { kind: rel, value: exact.gguf }
  binary: /usr/bin/false
  allowExternalBind: true
  ${source === "endpoint" ? 'endpoint: { host: "0.0.0.0" }' : 'extraArgs: ["--host", "0.0.0.0"]'}
  resources: { expectedMemoryGiB: 16 }
`);
          saveWorkload(manifest, directory);
          const { workload: runtimeKey, ...launch } = modelRunStartInvocation(manifest);
          const prepared = server.prepareManagedServerStart({
            ...launch,
            key: { name: runtimeKey },
          });
          if ("result" in prepared) throw new Error(prepared.result.error);
          const start = mock(() =>
            Promise.resolve({ ran: false as const, detail: "reached launch" }),
          );
          expect(
            await admission.run(
              {
                kind: "ModelRun",
                runtimeKey,
                effectiveSpecDigest: prepared.effectiveSpecDigest,
                effectiveLaunch: prepared.launch,
                launch,
              },
              new AbortController().signal,
              start,
            ),
          ).toEqual({ ran: false, detail: "ManagedExternalBindUnavailable" });
          expect(start).not.toHaveBeenCalled();
          expect(authority.snapshot()).toEqual([]);
        } finally {
          if (previous === undefined) Reflect.deleteProperty(process.env, "LLAMA_CPP_MODELS");
          else process.env["LLAMA_CPP_MODELS"] = previous;
        }
      },
    );
  },
);

test("profile preflight uses the ledger ceiling, while launch uses fresh headroom and abandons a refused claim", async () => {
  let available = 56;
  let reads = 0;
  await withCapacityOwner(
    () => localCapacity(reads++ === 0 ? 56 : available),
    async ({ admission, authority }, request) => {
      const preflight = admission.preflightProfile;
      if (preflight === undefined) throw new Error("the owner must expose profile preflight");
      available = 16;
      expect(preflight({ victims: [], retained: [], replacements: [workload] })).toBeUndefined();
      expect(preflight({ victims: [], retained: ["unverified"], replacements: [workload] })).toBe(
        "ManagedRetainedUnverified: unverified",
      );
      expect(
        preflight({ victims: ["unverified"], retained: [], replacements: [workload] }),
      ).toMatch(/^ManagedVictimUnverified/);

      // The first reading allows a ledger reservation. Its later launch must still refuse.
      reads = 0;
      available = 24;
      const called = mock(() =>
        Promise.resolve({ ran: false as const, detail: "fixture engine stopped" }),
      );
      const signal = new AbortController().signal;
      expect(await admission.run(request, signal, called)).toEqual({
        ran: false,
        detail: "ManagedCapacity: InsufficientHeadroom",
      });
      expect(called).not.toHaveBeenCalled();
      expect(authority.snapshot()).toEqual([]);

      available = 56;
      expect(await admission.run(request, signal, called)).toEqual({
        ran: false,
        detail: "fixture engine stopped",
      });
      expect(called).toHaveBeenCalledTimes(1);
    },
  );
});

test("a cgroup reclaim threshold refuses a new owner launch without reducing the ledger ceiling", async () => {
  let headroom = 0;
  const audit: ManagedCapacityAudit[] = [];
  await withCapacityOwner(
    () => ({
      ...localCapacity(56),
      scope: { kind: "cgroup-v2", limitBytes: null, availableBytes: headroom * GiB },
    }),
    async ({ admission, authority }, request) => {
      expect(
        admission.preflightProfile?.({ victims: [], retained: [], replacements: [workload] }),
      ).toBeUndefined();
      expect(admission.readStatus?.().budgetGiB).toBe(48);
      expect(audit).toContainEqual({
        nodeName: node,
        phase: "profile-preflight",
        ledgerCeilingGiB: 48,
        launchHeadroomGiB: 0,
      });
      const launch = mock(() => Promise.resolve({ ran: false as const, detail: "reached launch" }));
      expect(await admission.run(request, new AbortController().signal, launch)).toEqual({
        ran: false,
        detail: "ManagedCapacity: InsufficientHeadroom",
      });
      expect(launch).not.toHaveBeenCalled();
      expect(authority.snapshot()).toEqual([]);

      headroom = 18;
      expect(await admission.run(request, new AbortController().signal, launch)).toEqual({
        ran: false,
        detail: "reached launch",
      });
      expect(launch).toHaveBeenCalledTimes(1);
    },
    (entry): void => {
      audit.push(entry);
    },
  );
});

test("a granted launch rechecks at the engine boundary and an unstarted refusal releases its claim", async () => {
  let available = 56;
  await withCapacityOwner(
    () => localCapacity(available),
    async ({ admission, authority }, request, runtimeDir) => {
      writeFileSync(join(runtimeDir, "managed-residency-v1"), node + "\n");
      let spawns = 0;
      const result = await admission.run(request, new AbortController().signal, async () => {
        await Promise.resolve();
        available = 24;
        const blocked = managedRuntimeRefusesMutation(runtimeDir);
        if (!blocked) spawns++;
        return { ran: true, result: { ok: false, pid: null } };
      });
      expect(result).toEqual({ ran: false, detail: "ManagedCapacity: InsufficientHeadroom" });
      expect(spawns).toBe(0);
      expect(authority.snapshot()).toEqual([]);
    },
  );
});

test("unsettled and unverified resident claims still charge fresh launch headroom", async () => {
  let available = 56;
  await withCapacityOwner(
    () => localCapacity(available),
    async ({ admission, authority }, request) => {
      const claim = authority.admit({
        kind: "ModelHost",
        runtimeKey: "unverified-resident",
        specDigest: "test",
        allocationGiB: 10,
      });
      if (claim.kind !== "admitted") throw new Error("fixture claim failed");
      expect(authority.completeReady(claim.claimId, claim.fenceToken)).toBe(true);
      available = 36; // 20 GiB headroom. The 10 GiB unresolved liability plus 16 GiB request does not fit.
      const callback = mock(() =>
        Promise.resolve({ ran: false as const, detail: "fixture engine stopped" }),
      );
      expect(await admission.run(request, new AbortController().signal, callback)).toEqual({
        ran: false,
        detail: "ManagedCapacity: InsufficientHeadroom",
      });
      expect(callback).not.toHaveBeenCalled();
      expect(authority.snapshot()).toMatchObject([{ claimId: claim.claimId }]);
    },
  );
});

test("a verified victim release changes the ledger while another sample still controls launch", async () => {
  let available = 56;
  let hold: InferenceHoldState = "clear";
  const audit: ManagedCapacityAudit[] = [];
  await withCapacityOwner(
    () => localCapacity(available),
    async ({ admission, authority }, request, runtimeDir) => {
      // This fixture process has an observable generation and performs no inference or allocation.
      const child = spawn(process.execPath, ["-e", "await Bun.stdin.text()"], {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
      });
      const exited = new Promise((resolve) => child.once("exit", resolve));
      let witness: Awaited<ReturnType<typeof openLocalAdmissionRuntime>> | undefined;
      try {
        witness = await openLocalAdmissionRuntime({
          storePath: join(runtimeDir, "fixture-witness.sqlite"),
          budgetGiB: () => 48,
          readPidFile: () => undefined,
        });
        const pid = child.pid;
        if (pid === undefined) throw new Error("fixture victim did not start");
        const generation = witness.capture(pid);
        if (generation === undefined) throw new Error("fixture victim is not observable");
        const victim = "verified-victim";
        const victimDir = workloadRuntimeDir(resolveEnv(), { name: victim });
        mkdirSync(victimDir, { recursive: true });
        writeFileSync(join(victimDir, "llama-server.pid"), String(pid));
        const claim = authority.admit({
          kind: "ModelRun",
          runtimeKey: victim,
          specDigest: "fixture",
          allocationGiB: 16,
        });
        if (claim.kind !== "admitted") throw new Error("fixture victim reservation refused");
        expect(authority.recordGeneration(claim.claimId, claim.fenceToken, generation)).toBe(true);
        expect(authority.completeReady(claim.claimId, claim.fenceToken)).toBe(true);

        const launch = mock(() =>
          Promise.resolve({ ran: false as const, detail: "fixture reached launch" }),
        );
        const signal = new AbortController().signal;
        // The live victim is already represented in the availability sample.
        available = 36;
        expect(await admission.run(request, signal, launch)).toEqual({
          ran: false,
          detail: "fixture reached launch",
        });
        expect(launch).toHaveBeenCalledTimes(1);
        expect(audit).toContainEqual({
          nodeName: node,
          phase: "launch",
          ledgerCeilingGiB: 48,
          launchHeadroomGiB: 20,
          ledgerHeldGiB: 32,
          requiredHeadroomGiB: 16,
        });

        available = 16;
        expect(
          admission.preflightProfile?.({
            victims: [victim],
            retained: [],
            replacements: [workload],
          }),
        ).toBeUndefined();
        expect(audit).toContainEqual({
          nodeName: node,
          phase: "profile-preflight",
          ledgerCeilingGiB: 48,
          launchHeadroomGiB: 0,
        });
        const stop = admission.prepareStopRelease?.(victim, "ModelRun");
        if (stop === undefined) throw new Error("fixture receipt missing");
        expect(stop.verifyGeneration(pid)).toBe("alive");
        hold = "prior";
        expect(stop.verifyGeneration(pid)).toBe("unknown");
        expect(admission.prepareStopRelease?.(victim, "ModelRun")).toBeUndefined();
        expect(
          admission.preflightProfile?.({
            victims: [victim],
            retained: [],
            replacements: [workload],
          }),
        ).toBe(`ManagedInferenceUnresolved: ${victim}`);
        expect(admission.readStatus?.().claims).toMatchObject([
          { workload: victim, inferenceHold: "prior" },
        ]);
        hold = "clear";
        child.stdin.end();
        await exited;
        expect(stop.release(pid)).toEqual({ kind: "released", claimId: claim.claimId });

        // Verified exit alone never creates more available memory.
        expect(await admission.run(request, signal, launch)).toEqual({
          ran: false,
          detail: "ManagedCapacity: InsufficientHeadroom",
        });
        expect(launch).toHaveBeenCalledTimes(1);
        expect(authority.snapshot()).toEqual([]);

        available = 40;
        expect(await admission.run(request, signal, launch)).toEqual({
          ran: false,
          detail: "fixture reached launch",
        });
        expect(launch).toHaveBeenCalledTimes(2);
      } finally {
        child.kill();
        await exited;
        witness?.authority.close();
      }
    },
    (entry): void => {
      audit.push(entry);
    },
    { state: (name) => (name === "verified-victim" ? hold : "clear"), begin: () => undefined },
  );
});

test("the owner charges exact calibrated inputs at apply, profile, and launch and ignores stale evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-calibrated-owner-"));
  const old = {
    LOCAL_AI_RUNTIME_DIR: process.env["LOCAL_AI_RUNTIME_DIR"],
    LLAMACTL_MODELS_DIR: process.env["LLAMACTL_MODELS_DIR"],
    LLAMA_CPP_MODELS: process.env["LLAMA_CPP_MODELS"],
    DEV_STORAGE: process.env["DEV_STORAGE"],
  };
  process.env["LOCAL_AI_RUNTIME_DIR"] = join(dir, "runtime");
  process.env["LLAMACTL_MODELS_DIR"] = dir;
  process.env["LLAMA_CPP_MODELS"] = dir;
  process.env["DEV_STORAGE"] = dir;
  let policy: Awaited<ReturnType<typeof openNodeManagedAdmission>> | undefined;
  let clock = Date.now() - 120_000;
  let changeAtSpawn = false;
  try {
    const manifest = modelHostFixture(dir);
    manifest.spec.binary = join(dir, "fixture-engine");
    manifest.spec.extraArgs = ["-c", "8192", "--mtp-head", join(dir, "head.gguf")];
    saveModelHost(manifest, dir);
    copyFileSync("/usr/bin/false", join(dir, "fixture-engine"));
    for (const file of ["exact.gguf", "head.gguf"]) {
      writeFileSync(join(dir, file), file);
    }
    policy = await openNodeManagedAdmission({
      nodeName: node,
      workloadsDir: dir,
      nowMs: () => clock,
      readCapacity: () => ({ ...localCapacity(51), observedAtMs: clock }),
      onCapacityAudit(entry) {
        if (changeAtSpawn && entry.phase === "spawn") {
          writeFileSync(join(dir, "head.gguf"), "changed during final capacity sample");
          changeAtSpawn = false;
        }
      },
    });
    const lookup = policy.admission.readCalibration;
    const before = lookup?.(workload);
    expect(before).toMatchObject({ declaredGiB: 16, allocationGiB: 16, measured: false });
    if (before === undefined) throw new Error("missing fixture key");
    const initialKey = before.key;
    const caller = router.createCaller({ managedLaunchAdmission: policy.admission });
    expect(await caller.residencyCalibrationKey({ node, workload })).toEqual(before);
    expect(
      await caller.operatorRunTool({
        name: "llamactl.residency.calibration-key",
        arguments: { node, workload },
      }),
    ).toMatchObject({ ok: true, result: before });
    const unowned = await caller
      .residencyCalibrationKey({ node: "wrong-node", workload })
      .catch((error: unknown) => error);
    expect(unowned).toHaveProperty("message", "ManagedOwnerRequired");
    const record = recordMeasuredMemoryCalibration;
    expect(
      record(
        {
          key: before.key,
          samples: [
            {
              status: "ok",
              source: "fixture",
              observedAtMs: clock,
              processBytes: 50 * GiB,
              processDeviceBytes: 0,
              sharedDeviceBytes: null,
            },
          ],
          options: { minSamples: 1, overheadFraction: 0 },
        },
        measuredCalibrationStorePath(),
      ).ok,
    ).toBe(true);
    expect(lookup?.(workload)).toMatchObject({
      declaredGiB: 16,
      allocationGiB: 50,
      measured: true,
    });
    const smallerDeclaration = structuredClone(manifest);
    smallerDeclaration.spec.resources = { expectedMemoryGiB: 12 };
    saveModelHost(smallerDeclaration, dir);
    expect(lookup?.(workload)).toMatchObject({
      key: before.key,
      declaredGiB: 12,
      allocationGiB: 50,
      measured: true,
    });
    saveModelHost(manifest, dir);
    const apply = await policy.admission
      .withDesiredManifest?.(manifest, () => Promise.resolve("applied"))
      .catch((error: unknown) => error);
    expect(apply).toBeInstanceOf(Error);
    expect((apply as Error).message).toContain("Budget");
    expect(
      policy.admission.preflightProfile?.({ victims: [], replacements: [workload], retained: [] }),
    ).toContain("Budget");
    const pinned = pinModelHostStartup(manifest);
    const start = mock(() => Promise.resolve({ ran: false as const, detail: "fixture turn" }));
    const request = {
      kind: "ModelHost" as const,
      runtimeKey: workload,
      launch: { manifest },
      effectiveSpecDigest: pinned.effectiveSpecDigest,
      effectiveLaunch: pinned.effectiveLaunch,
    };
    const signal = new AbortController().signal;
    const denied = await policy.admission.run(request, signal, start);
    expect(denied.ran).toBe(false);
    if (!denied.ran) expect(denied.detail).toContain("Budget");
    expect(start).not.toHaveBeenCalled();
    const writer = new Database(measuredCalibrationStorePath());
    writer.run("BEGIN EXCLUSIVE");
    try {
      const blocked = await policy.admission.run(request, signal, start);
      expect(blocked).toEqual({ ran: false, detail: "ManagedCalibrationStoreUnavailable" });
      expect(start).not.toHaveBeenCalled();
      expect(
        policy.admission.preflightProfile?.({
          victims: [],
          replacements: [workload],
          retained: [],
        }),
      ).toContain("ManagedCalibrationStoreUnavailable");
      const blockedApply = await policy.admission
        .withDesiredManifest?.(manifest, () => Promise.resolve("applied"))
        .catch((error: unknown) => error);
      expect(blockedApply).toHaveProperty("message", "ManagedCalibrationStoreUnavailable");
    } finally {
      writer.run("ROLLBACK");
      writer.close();
    }
    clock += 25 * 60 * 60 * 1000;
    expect(lookup?.(workload)).toMatchObject({ allocationGiB: 16, measured: false });
    expect(await policy.admission.run(request, signal, start)).toEqual({
      ran: false,
      detail: "fixture turn",
    });
    expect(start).toHaveBeenCalledTimes(1);
    function recordFloor(calibrationKey: typeof initialKey): void {
      clock = Date.now();
      expect(
        record(
          {
            key: calibrationKey,
            samples: [
              {
                status: "ok",
                source: "fixture",
                observedAtMs: clock,
                processBytes: 20 * GiB,
                processDeviceBytes: 0,
                sharedDeviceBytes: null,
              },
            ],
            options: { minSamples: 1, overheadFraction: 0 },
          },
          measuredCalibrationStorePath(),
        ).ok,
      ).toBe(true);
    }
    recordFloor(initialKey);
    const result = await policy.admission.run(request, signal, (_ready, checkSpawn) => {
      writeFileSync(join(dir, "head.gguf"), "changed head generation");
      const changed = lookup?.(workload);
      expect(changed?.key).not.toEqual(initialKey);
      if (changed === undefined) throw new Error("missing changed generation");
      recordFloor(changed.key);
      expect(lookup?.(workload)?.allocationGiB).toBe(20);
      return Promise.resolve({
        ran: false as const,
        detail: checkSpawn?.() ?? "fixture did not spawn",
      });
    });
    expect(result).toEqual({ ran: false, detail: "ManagedSpecChanged" });
    expect(policy.authority.snapshot()).toEqual([]);
    const dispatched = mock(() => undefined);
    const swappedDuringSampling = await policy.admission.run(
      request,
      signal,
      (_ready, checkSpawn) => {
        changeAtSpawn = true;
        const refusal = checkSpawn?.();
        if (refusal === undefined) dispatched();
        return Promise.resolve({ ran: false as const, detail: refusal ?? "unverified dispatch" });
      },
    );
    expect(swappedDuringSampling).toEqual({ ran: false, detail: "ManagedSpecChanged" });
    expect(dispatched).not.toHaveBeenCalled();
    expect(policy.authority.snapshot()).toEqual([]);
  } finally {
    policy?.authority.close();
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unverified parked memory credit fences new allocations until the full charge returns", async () => {
  let provenFence: string | undefined;
  await withCapacityOwner(
    () => localCapacity(56),
    async (policy, request, runtimeDir) => {
      const { admission, authority } = policy;
      const resident = authority.admit({
        runtimeKey: "prior-native-model",
        specDigest: "native-fixture",
        kind: "ModelHost",
        allocationGiB: 8,
      });
      if (resident.kind !== "admitted") throw new Error("fixture claim refused");
      expect(authority.completeReady(resident.claimId, resident.fenceToken)).toBe(true);
      const db = openAdmissionStore({
        path: managedAdmissionStorePath(runtimeDir),
        requireExisting: true,
      });
      try {
        const row = db.snapshot()[0];
        if (row === undefined) throw new Error("fixture claim missing");
        const starting = db.transitionNative(row, { kind: "begin-park" });
        if (starting === undefined) throw new Error("fixture park intent refused");
        const parked = db.transitionNative(starting, { kind: "park", residualGiB: 2 });
        if (parked === undefined) throw new Error("fixture park refused");
        expect(parked.allocationGiB).toBe(2);
        expect(policy.verifyActivation()).toBeUndefined();
        const signal = new AbortController().signal;
        const start = mock(() =>
          Promise.resolve({ ran: false as const, detail: "fixture entered launch" }),
        );

        expect(await admission.run(request, signal, start)).toEqual({
          ran: false,
          detail: "ManagedNativeCreditUnverified",
        });
        expect(start).not.toHaveBeenCalled();
        const apply = mock(() => Promise.resolve("fixture entered apply"));
        const rejected = await admission
          .withDesiredManifest?.(request.launch.manifest, apply)
          .catch((error: unknown) => error);
        expect(rejected).toEqual(new Error("ManagedNativeCreditUnverified"));
        expect(apply).not.toHaveBeenCalled();
        expect(admission.preflightProfile?.({ victims: [], retained: [], replacements: [] })).toBe(
          "ManagedNativeCreditUnverified",
        );

        expect(
          authority.admit({
            runtimeKey: "bypass-attempt",
            specDigest: "fixture",
            kind: "ModelHost",
            allocationGiB: 1,
          }),
        ).toMatchObject({ kind: "refuse", reason: "ManagedNativeCreditUnverified" });

        provenFence = parked.fenceToken;
        expect(await admission.run(request, signal, start)).toEqual({
          ran: false,
          detail: "fixture entered launch",
        });
        provenFence = undefined;
        expect(await admission.run(request, signal, start)).toEqual({
          ran: false,
          detail: "ManagedNativeCreditUnverified",
        });

        expect(db.transitionNative(parked, { kind: "uncertain" })).toMatchObject({
          state: "uncertain",
          allocationGiB: 8,
        });
        expect(await admission.run(request, signal, start)).toEqual({
          ran: false,
          detail: "fixture entered launch",
        });
        expect(start).toHaveBeenCalledTimes(2);
      } finally {
        db.close();
      }
    },
    undefined,
    undefined,
    (claim) => claim.fenceToken === provenFence,
  );
});
