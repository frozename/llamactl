import { readControllerHostHistory } from "@llamactl/core/engines/conditions";
import { computeModelHostSpecHash } from "@llamactl/core/engines/state";
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkloadClient } from "../../src/workload/apply.js";

import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { type ModelHostManifest, specForHash } from "../../src/workload/modelhost-schema.js";
import { saveModelHost } from "../../src/workload/modelhost-store.js";
import { type ReconcileNodeReport, reconcileOnce } from "../../src/workload/reconciler.js";

const STALE_HASH = "stale-hash";

// The fix adds `observed` to the report of a sleeping host; the base report
// type predates the field, so expectations are checked against this widened
// shape. Runtime equality is unaffected.
type SleepAwareReport = ReconcileNodeReport & { observed?: string };

type SleepFlag = "sleeping" | "sleep-pending";

type ScriptedHostStatus = {
  state: string;
  pid?: number | null;
  specHash?: string;
  sleep?: SleepFlag;
};

function makeHostManifest(name: string, enabled = true): ModelHostManifest {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name },
    spec: {
      engine: "llamacpp",
      node: "mac-mini",
      enabled,
      binary: "/usr/bin/true",
      endpoint: { host: "127.0.0.1", port: 18094 },
      hostedModels: [{ rel: `${name}.gguf` }],
      extraArgs: [],
      restartPolicy: "Always",
      timeoutSeconds: 60,
    },
  };
}

function desiredHashByName(manifests: readonly ModelHostManifest[]): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const manifest of manifests) {
    hashes.set(manifest.metadata.name, computeModelHostSpecHash(specForHash(manifest.spec)));
  }
  return hashes;
}

function makeSleepClient(
  statuses: Map<string, ScriptedHostStatus>,
  desiredHashes: Map<string, string>,
): {
  client: WorkloadClient;
  starts: Map<string, number>;
  stops: Map<string, number>;
} {
  const starts = new Map<string, number>();
  const stops = new Map<string, number>();
  let nextPid = 5000;
  const client: WorkloadClient = {
    serverStatus: {
      query: () =>
        Promise.resolve({
          state: "down",
          rel: null,
          extraArgs: [],
          pid: null,
          host: null,
          port: null,
          binary: null,
          endpoint: "",
        }),
    },
    serverStop: { mutate: () => Promise.resolve({ stopped: true }) },
    serverStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    modelHostStatus: {
      query: ({ workload }): Promise<ScriptedHostStatus> =>
        Promise.resolve(statuses.get(workload) ?? { state: "Stopped", pid: null }),
    },
    modelHostStop: {
      mutate: ({ workload }) => {
        stops.set(workload, (stops.get(workload) ?? 0) + 1);
        return Promise.resolve({ stopped: true });
      },
    },
    modelHostStart: {
      subscribe: ({ workload }, callbacks): { unsubscribe: () => void } => {
        starts.set(workload, (starts.get(workload) ?? 0) + 1);
        const pid = nextPid;
        nextPid += 1;
        const specHash = desiredHashes.get(workload);
        statuses.set(workload, {
          state: "Running",
          pid,
          ...(specHash === undefined ? {} : { specHash }),
        });
        queueMicrotask(() => {
          callbacks.onData({ type: "done", result: { ok: true, pid, state: "Running" } });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    rpcServerStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    rpcServerStop: { mutate: () => Promise.resolve({ stopped: true }) },
    rpcServerDoctor: { query: () => Promise.resolve({ ok: true, path: "", llamaCppBin: "" }) },
  };
  return { client, starts, stops };
}

// #283 sleep-aware — kills removing the sleeping decision from the ModelHost
// reconcile path, and honouring only "sleeping" but not "sleep-pending": a
// Running host whose status reports a sleep flag must be reported
// unchanged/observed "sleeping" on every pass, with no start or stop.
test("#283 sleep-aware S1: a sleeping host is left alone over several reconcile passes (no restart loop)", async () => {
  for (const sleep of ["sleeping", "sleep-pending"] as const) {
    const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-sleep-"));
    const name = "sleeping-host";
    const manifest = makeHostManifest(name);
    saveModelHost(manifest, workloadsDir);
    const statuses = new Map<string, ScriptedHostStatus>();
    statuses.set(name, { state: "Running", pid: 4242, specHash: STALE_HASH, sleep });
    const { client, starts, stops } = makeSleepClient(statuses, desiredHashByName([manifest]));
    try {
      for (let pass = 0; pass < 3; pass += 1) {
        const result = await reconcileOnce({ workloadsDir, getClient: () => client });
        expect(result.errors).toBe(0);
        expect(result.reports as SleepAwareReport[]).toEqual([
          {
            kind: "ModelHost",
            name,
            node: "mac-mini",
            action: "unchanged",
            observed: "sleeping",
          },
        ]);
      }
      expect(starts.get(name) ?? 0).toBe(0);
      expect(stops.get(name) ?? 0).toBe(0);
      // The sleeping pass records the controller-history outcome exactly as a
      // converged pass does: the record exists and marks the engine running.
      const history = readControllerHostHistory(workloadsDir, "mac-mini", name);
      expect(history).not.toBeNull();
      if (history === null) throw new Error("expected controller history for a sleeping host");
      expect(history.lastKnownRunning).toBe(true);
      expect(
        history.conditions.some(
          (condition) => condition.type === "ReconcileError" && condition.status === "True",
        ),
      ).toBe(false);
    } finally {
      rmSync(workloadsDir, { recursive: true, force: true });
    }
  }
});

// #283 sleep-aware — kills consulting `sleep` without requiring
// state === "Running" (a Stopped host carrying a stale flag must still be
// started) and without requiring spec.enabled (a disabled host must still be
// stopped): the flag shields only a live, enabled, Running host.
test("#283 sleep-aware S2: sleep-awareness never shields a genuinely down or disabled host", async () => {
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-sleep-gates-"));
  const nameA = "sleep-a-running";
  const nameB = "sleep-b-stopped";
  const nameC = "sleep-c-disabled";
  const manifests = [
    makeHostManifest(nameA),
    makeHostManifest(nameB),
    makeHostManifest(nameC, false),
  ];
  for (const manifest of manifests) saveModelHost(manifest, workloadsDir);
  const statuses = new Map<string, ScriptedHostStatus>();
  statuses.set(nameA, { state: "Running", pid: 1, specHash: STALE_HASH, sleep: "sleeping" });
  statuses.set(nameB, { state: "Stopped", pid: null, sleep: "sleeping" });
  statuses.set(nameC, { state: "Running", pid: 3, specHash: STALE_HASH, sleep: "sleeping" });
  const { client, starts, stops } = makeSleepClient(statuses, desiredHashByName(manifests));
  try {
    const result = await reconcileOnce({ workloadsDir, getClient: () => client });
    expect(result.errors).toBe(0);
    expect(result.reports as SleepAwareReport[]).toEqual([
      {
        kind: "ModelHost",
        name: nameA,
        node: "mac-mini",
        action: "unchanged",
        observed: "sleeping",
      },
      { kind: "ModelHost", name: nameB, node: "mac-mini", action: "started" },
      { kind: "ModelHost", name: nameC, node: "mac-mini", action: "restarted" },
    ]);
    expect(starts.get(nameA) ?? 0).toBe(0);
    expect(stops.get(nameA) ?? 0).toBe(0);
    expect(starts.get(nameB) ?? 0).toBe(1);
    expect(stops.get(nameB) ?? 0).toBe(0);
    expect(starts.get(nameC) ?? 0).toBe(0);
    expect(stops.get(nameC) ?? 0).toBe(1);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

// #283 sleep-aware — kills a sticky sleeping marker (sleep state cached or
// persisted across passes) and treating every Running host as sleeping: once
// the status stops reporting the flag, the stale specHash reconciles as a
// normal restart and the following pass converges unchanged.
test("#283 sleep-aware S3: a sleeping host that wakes reconciles normally", async () => {
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-sleep-wake-"));
  const name = "waking-host";
  const manifest = makeHostManifest(name);
  saveModelHost(manifest, workloadsDir);
  const statuses = new Map<string, ScriptedHostStatus>();
  statuses.set(name, { state: "Running", pid: 7, specHash: STALE_HASH, sleep: "sleeping" });
  const { client, starts, stops } = makeSleepClient(statuses, desiredHashByName([manifest]));
  const sleepingReport: SleepAwareReport = {
    kind: "ModelHost",
    name,
    node: "mac-mini",
    action: "unchanged",
    observed: "sleeping",
  };
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      const result = await reconcileOnce({ workloadsDir, getClient: () => client });
      expect(result.errors).toBe(0);
      expect(result.reports as SleepAwareReport[]).toEqual([sleepingReport]);
    }
    expect(starts.get(name) ?? 0).toBe(0);

    statuses.set(name, { state: "Running", pid: 7, specHash: STALE_HASH });

    const woke = await reconcileOnce({ workloadsDir, getClient: () => client });
    expect(woke.errors).toBe(0);
    expect(woke.reports as SleepAwareReport[]).toEqual([
      { kind: "ModelHost", name, node: "mac-mini", action: "restarted" },
    ]);
    expect(starts.get(name) ?? 0).toBe(1);

    const settled = await reconcileOnce({ workloadsDir, getClient: () => client });
    expect(settled.errors).toBe(0);
    expect(settled.reports as SleepAwareReport[]).toEqual([
      { kind: "ModelHost", name, node: "mac-mini", action: "unchanged" },
    ]);
    expect(starts.get(name) ?? 0).toBe(1);
    expect(stops.get(name) ?? 0).toBe(0);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

// #283 sleep-aware — kills dropping the controller-history outcome for a
// sleeping host (only "converged" recording it): a host whose previous pass
// left ReconcileError=True must have that condition cleared to Recovered by
// the next pass that finds it sleeping, with no start or stop.
test("#283 sleep-aware S4: a sleeping pass clears a prior ReconcileError to Recovered", async () => {
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-sleep-recover-"));
  const name = "recovering-sleeper";
  const manifest = makeHostManifest(name);
  saveModelHost(manifest, workloadsDir);
  const statuses = new Map<string, ScriptedHostStatus>();
  statuses.set(name, { state: "Running", pid: 31, specHash: STALE_HASH, sleep: "sleeping" });
  const { client, starts, stops } = makeSleepClient(statuses, desiredHashByName([manifest]));
  const failingClient: WorkloadClient = {
    ...client,
    modelHostStatus: {
      query: () => Promise.reject(new Error("status probe failed")),
    },
  };
  try {
    const failed = await reconcileOnce({ workloadsDir, getClient: () => failingClient });
    expect(failed.errors).toBe(1);
    const before = readControllerHostHistory(workloadsDir, "mac-mini", name);
    expect(before).not.toBeNull();
    if (before === null) throw new Error("expected controller history after a failed pass");
    const prior = before.conditions.find((condition) => condition.type === "ReconcileError");
    expect(prior?.status).toBe("True");

    const result = await reconcileOnce({ workloadsDir, getClient: () => client });
    expect(result.errors).toBe(0);
    expect(result.reports as SleepAwareReport[]).toEqual([
      {
        kind: "ModelHost",
        name,
        node: "mac-mini",
        action: "unchanged",
        observed: "sleeping",
      },
    ]);
    expect(starts.get(name) ?? 0).toBe(0);
    expect(stops.get(name) ?? 0).toBe(0);

    const after = readControllerHostHistory(workloadsDir, "mac-mini", name);
    expect(after).not.toBeNull();
    if (after === null) throw new Error("expected controller history after the sleeping pass");
    expect(after.lastKnownRunning).toBe(true);
    const cleared = after.conditions.find((condition) => condition.type === "ReconcileError");
    expect(cleared?.status).toBe("False");
    expect(cleared?.reason).toBe("Recovered");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});
