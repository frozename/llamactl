import { computeModelHostSpecHash } from "@llamactl/core/engines/state";
import { expect, test } from "bun:test";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";

import type { WorkloadClient } from "./apply.js";

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "../safe-fs.js";
import { type ModelHostManifest, specForHash } from "./modelhost-schema.js";
import { saveModelHost } from "./modelhost-store.js";
import { reconcileOnce } from "./reconciler.js";
import { saveWorkload, workloadPath } from "./store.js";

function makeManifest(name: string, extraArgs: string[] = []): ModelHostManifest {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name },
    spec: {
      engine: "omlx",
      node: "mac-mini",
      enabled: true,
      binary: "/usr/bin/true",
      endpoint: { host: "127.0.0.1", port: 18094 },
      hostedModels: [{ rel: `${name}.gguf` }],
      extraArgs,
      restartPolicy: "Always",
      timeoutSeconds: 60,
    },
  };
}

function makeRunManifest(name: string, port = 8181): Parameters<typeof saveWorkload>[0] {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name, labels: {}, annotations: {} },
    spec: {
      node: "mac-mini",
      enabled: true,
      target: { kind: "rel", value: `${name}.gguf` },
      extraArgs: [],
      workers: [],
      restartPolicy: "Always",
      gateway: false,
      allowExternalBind: false,
      timeoutSeconds: 60,
      endpoint: { host: "127.0.0.1", port },
      resources: { expectedMemoryGiB: 8 },
    },
  };
}

function makeSizedRunManifest(
  name: string,
  expectedMemoryGiB: number,
  port = 8181,
  node = "mac-mini",
): Parameters<typeof saveWorkload>[0] {
  const manifest = makeRunManifest(name, port);
  manifest.spec.node = node;
  manifest.spec.resources = { expectedMemoryGiB };
  return manifest;
}

function writeHighBudgetNodeRun(dir: string): void {
  writeFileSync(
    join(dir, "mac-mini.yaml"),
    [
      "apiVersion: llamactl/v1",
      "kind: NodeRun",
      "metadata:",
      "  name: mac-mini",
      "spec:",
      "  node: mac-mini",
      "  budget:",
      "    memoryGiB: 1024",
      "  infra: []",
    ].join("\n"),
  );
}

function writeBudgetlessNodeRun(dir: string): void {
  writeFileSync(
    join(dir, "mac-mini.yaml"),
    [
      "apiVersion: llamactl/v1",
      "kind: NodeRun",
      "metadata:",
      "  name: mac-mini",
      "spec:",
      "  node: mac-mini",
      "  infra: []",
    ].join("\n"),
  );
}

function makeSlowStoppedClient(delayMs: number): WorkloadClient {
  return {
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
    serverStart: {
      subscribe: (_input, callbacks): { unsubscribe: () => void } => {
        setTimeout(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 12345, endpoint: "http://127.0.0.1:18094" },
          });
          callbacks.onComplete();
        }, delayMs);
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStatus: {
      query: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ state: "Stopped", pid: null });
          }, delayMs);
        }),
    },
    modelHostStop: { mutate: () => Promise.resolve({ stopped: true }) },
    modelHostStart: {
      subscribe: (_input, callbacks): { unsubscribe: () => void } => {
        setTimeout(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 12345, state: "Running" },
          });
          callbacks.onComplete();
        }, delayMs);
        return { unsubscribe: () => undefined };
      },
    },
    rpcServerStart: {
      subscribe: (): { unsubscribe: () => void } => {
        return { unsubscribe: () => undefined };
      },
    },
    rpcServerStop: { mutate: () => Promise.resolve({ stopped: true }) },
    rpcServerDoctor: { query: () => Promise.resolve({ ok: true, path: "", llamaCppBin: "" }) },
  };
}

function makeClientThatDeletesManifestDuringStart(
  workloadsDir: string,
  name: string,
): WorkloadClient {
  const base = makeSlowStoppedClient(0);
  const manifestPath = workloadPath(name, workloadsDir);
  return {
    ...base,
    serverStart: {
      subscribe: (_input, callbacks): { unsubscribe: () => void } => {
        rmSync(manifestPath, { force: true });
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 12345, endpoint: "http://127.0.0.1:8181" },
          });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
  };
}

function makeRunClient(
  state: Map<string, { rel: string; args: string[] }>,
  slowWorkload?: string,
): WorkloadClient {
  return {
    serverStatus: {
      query: ({ workload }): ReturnType<WorkloadClient["serverStatus"]["query"]> => {
        const s = state.get(workload);
        return Promise.resolve(
          s
            ? {
                state: "up",
                pid: 1,
                rel: s.rel,
                extraArgs: s.args,
                host: "127.0.0.1",
                port: 8181,
                binary: null,
                endpoint: "http://127.0.0.1:8181",
              }
            : {
                state: "down",
                pid: null,
                rel: null,
                extraArgs: [],
                host: null,
                port: null,
                binary: null,
                endpoint: "http://127.0.0.1:8181",
              },
        );
      },
    },
    serverStop: {
      mutate: ({ workload }): Promise<{ stopped: boolean }> => {
        state.delete(workload);
        return Promise.resolve({ stopped: true });
      },
    },
    serverStart: {
      subscribe: ({ workload, target, extraArgs }, callbacks): { unsubscribe: () => void } => {
        state.set(workload, { rel: target, args: extraArgs ?? [] });
        const emit = (): void => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 100, endpoint: "http://127.0.0.1:8181" },
          });
          callbacks.onComplete();
        };
        if (workload === slowWorkload) {
          setTimeout(emit, 50);
        } else {
          queueMicrotask(emit);
        }
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStart: {
      subscribe: (): { unsubscribe: () => void } => {
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStop: { mutate: () => Promise.resolve({ stopped: true }) },
    modelHostStatus: { query: () => Promise.resolve({ state: "Stopped", pid: null }) },
    rpcServerStart: {
      subscribe: (): { unsubscribe: () => void } => {
        return { unsubscribe: () => undefined };
      },
    },
    rpcServerStop: { mutate: () => Promise.resolve({ stopped: true }) },
    rpcServerDoctor: { query: () => Promise.resolve({ ok: true, path: "", llamaCppBin: "" }) },
  };
}

test("reconcile uses remote modelHostStatus.specHash to avoid restarts and detect drift on remote node", async () => {
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-"));
  const name = "remote-host";
  const manifest = makeManifest(name);
  saveModelHost(manifest, workloadsDir);

  const remoteState = {
    hash: computeModelHostSpecHash(specForHash(manifest.spec)),
    pid: 12345,
    starts: 0,
  };

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
      query: () =>
        Promise.resolve({ state: "Running", pid: remoteState.pid, specHash: remoteState.hash }),
    },
    modelHostStop: { mutate: () => Promise.resolve({ stopped: true }) },
    modelHostStart: {
      subscribe: (_input, callbacks): { unsubscribe: () => void } => {
        remoteState.starts += 1;
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: remoteState.pid, state: "Running" },
          });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    rpcServerStart: {
      subscribe: (): { unsubscribe: () => void } => {
        return { unsubscribe: () => undefined };
      },
    },
    rpcServerStop: { mutate: () => Promise.resolve({ stopped: true }) },
    rpcServerDoctor: { query: () => Promise.resolve({ ok: true, path: "", llamaCppBin: "" }) },
  };

  const getClient = (): WorkloadClient => client;

  try {
    const first = await reconcileOnce({ workloadsDir, getClient });
    expect(first.errors).toBe(0);
    expect(first.reports).toEqual([
      { kind: "ModelHost", name, node: "mac-mini", action: "unchanged" },
    ]);
    expect(remoteState.starts).toBe(0);

    const drifted = makeManifest(name, ["--new-flag"]);
    saveModelHost(drifted, workloadsDir);
    const second = await reconcileOnce({ workloadsDir, getClient });
    expect(second.errors).toBe(0);
    expect(second.reports).toEqual([
      { kind: "ModelHost", name, node: "mac-mini", action: "restarted" },
    ]);
    expect(remoteState.starts).toBe(1);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("reconcile skips deleted manifests without resurrecting them", async () => {
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-"));
  writeHighBudgetNodeRun(workloadsDir);
  const blocker = "aaa-blocker";
  const name = "zzz-deleted-host";
  saveWorkload(makeRunManifest(blocker, 8182), workloadsDir);
  saveWorkload(makeRunManifest(name), workloadsDir);

  const getClient = (): WorkloadClient => makeRunClient(new Map(), blocker);
  const path = workloadPath(name, workloadsDir);

  try {
    const firstRead = readFileSync(path, "utf8");
    expect(firstRead.length).toBeGreaterThan(0);
    const reconcile = reconcileOnce({ workloadsDir, getClient });
    rmSync(path);

    const result = await reconcile;
    expect(result.errors).toBe(0);
    expect(result.reports).toEqual([
      { kind: "ModelRun", name: blocker, node: "mac-mini", action: "started" },
      { kind: "ModelRun", name, node: "mac-mini", action: "skipped-deleted" },
    ]);
    expect(existsSync(path)).toBe(false);

    const second = await reconcileOnce({ workloadsDir, getClient });
    expect(second.errors).toBe(0);
    expect(second.reports).toEqual([
      { kind: "ModelRun", name: blocker, node: "mac-mini", action: "started" },
    ]);
    expect(existsSync(path)).toBe(false);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("reconcile restarts and persists when the manifest is still present", async () => {
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-"));
  const name = "live-host";
  saveModelHost(makeManifest(name), workloadsDir);

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
    modelHostStatus: { query: () => Promise.resolve({ state: "Stopped", pid: null }) },
    modelHostStop: { mutate: () => Promise.resolve({ stopped: true }) },
    modelHostStart: {
      subscribe: (_input, callbacks): { unsubscribe: () => void } => {
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 12345, state: "Running" },
          });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    rpcServerStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    rpcServerStop: { mutate: () => Promise.resolve({ stopped: true }) },
    rpcServerDoctor: { query: () => Promise.resolve({ ok: true, path: "", llamaCppBin: "" }) },
  };

  try {
    const result = await reconcileOnce({ workloadsDir, getClient: () => client });
    expect(result.errors).toBe(0);
    expect(result.reports).toEqual([
      { kind: "ModelHost", name, node: "mac-mini", action: "started" },
    ]);
    expect(existsSync(workloadPath(name, workloadsDir))).toBe(true);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("reconcile preserves renamed manifests without resurrecting the old name", async () => {
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-"));
  writeHighBudgetNodeRun(workloadsDir);
  const blocker = "aaa-blocker";
  const name = "zzz-rename-host";
  const renamed = "zzz-rename-host-new";
  saveWorkload(makeRunManifest(blocker, 8182), workloadsDir);
  saveWorkload(makeRunManifest(name), workloadsDir);

  const getClient = (): WorkloadClient => makeRunClient(new Map(), blocker);
  const originalPath = workloadPath(name, workloadsDir);
  const renamedPath = workloadPath(renamed, workloadsDir);

  try {
    const reconcile = reconcileOnce({ workloadsDir, getClient });
    renameSync(originalPath, renamedPath);
    writeFileSync(renamedPath, JSON.stringify(makeRunManifest(renamed), null, 2));

    const result = await reconcile;
    expect(result.errors).toBe(0);
    expect(result.reports).toEqual([
      { kind: "ModelRun", name: blocker, node: "mac-mini", action: "started" },
      { kind: "ModelRun", name, node: "mac-mini", action: "skipped-deleted" },
    ]);
    expect(existsSync(originalPath)).toBe(false);
    expect(existsSync(renamedPath)).toBe(true);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("reconcile admits a remote ModelHost from the node's reported memory without a NodeRun", async () => {
  const hostGiB = totalmem() / 1024 ** 3;
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-nodemem-"));
  const name = "nodemem-host";
  const manifest = makeManifest(name);
  saveModelHost(
    { ...manifest, spec: { ...manifest.spec, resources: { expectedMemoryGiB: 2 * hostGiB } } },
    workloadsDir,
  );
  const nodeFactsCalls = { count: 0 };
  const client: WorkloadClient = {
    ...makeSlowStoppedClient(0),
    nodeFacts: {
      query: () => {
        nodeFactsCalls.count += 1;
        return Promise.resolve({ memBytes: 4 * hostGiB * 1024 ** 3 });
      },
    },
  };

  try {
    const result = await reconcileOnce({ workloadsDir, getClient: () => client });
    expect(result.errors).toBe(0);
    expect(result.reports).toEqual([
      { kind: "ModelHost", name, node: "mac-mini", action: "started" },
    ]);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("reconcile keeps a NodeRun budget for ModelHost and never queries nodeFacts", async () => {
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-noderun-budget-"));
  writeHighBudgetNodeRun(workloadsDir);
  const name = "budgeted-host";
  const manifest = makeManifest(name);
  saveModelHost(
    { ...manifest, spec: { ...manifest.spec, resources: { expectedMemoryGiB: 8 } } },
    workloadsDir,
  );
  const nodeFactsCalls = { count: 0 };
  const client: WorkloadClient = {
    ...makeSlowStoppedClient(0),
    nodeFacts: {
      query: () => {
        nodeFactsCalls.count += 1;
        return Promise.resolve({ memBytes: 1 * 1024 ** 3 });
      },
    },
  };

  try {
    const result = await reconcileOnce({ workloadsDir, getClient: () => client });
    expect(result.errors).toBe(0);
    expect(nodeFactsCalls.count).toBe(0);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("reconcile sizes a budgetless NodeRun's ModelHost from the node's reported memory on a larger node", async () => {
  const hostGiB = totalmem() / 1024 ** 3;
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-nobudget-large-"));
  writeBudgetlessNodeRun(workloadsDir);
  const name = "nobudget-large-host";
  const manifest = makeManifest(name);
  saveModelHost(
    { ...manifest, spec: { ...manifest.spec, resources: { expectedMemoryGiB: 2 * hostGiB } } },
    workloadsDir,
  );
  const nodeFactsCalls = { count: 0 };
  const client: WorkloadClient = {
    ...makeSlowStoppedClient(0),
    nodeFacts: {
      query: () => {
        nodeFactsCalls.count += 1;
        return Promise.resolve({ memBytes: 4 * hostGiB * 1024 ** 3 });
      },
    },
  };

  try {
    const result = await reconcileOnce({ workloadsDir, getClient: () => client });
    expect(result.errors).toBe(0);
    expect(result.reports).toEqual([
      { kind: "ModelHost", name, node: "mac-mini", action: "started" },
    ]);
    expect(nodeFactsCalls.count).toBe(1);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("reconcile refuses a budgetless NodeRun's ModelHost past the node's reported memory on a smaller node", async () => {
  const hostGiB = totalmem() / 1024 ** 3;
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-nobudget-small-"));
  writeBudgetlessNodeRun(workloadsDir);
  const name = "nobudget-small-host";
  const manifest = makeManifest(name);
  saveModelHost(
    { ...manifest, spec: { ...manifest.spec, resources: { expectedMemoryGiB: hostGiB / 2 } } },
    workloadsDir,
  );
  const nodeFactsCalls = { count: 0 };
  const client: WorkloadClient = {
    ...makeSlowStoppedClient(0),
    nodeFacts: {
      query: () => {
        nodeFactsCalls.count += 1;
        return Promise.resolve({ memBytes: (hostGiB / 4) * 1024 ** 3 });
      },
    },
  };

  try {
    const result = await reconcileOnce({ workloadsDir, getClient: () => client });
    expect(result.errors).toBe(1);
    expect(result.reports.length).toBe(1);
    expect(result.reports[0]?.action).toBe("unchanged");
    expect(result.reports[0]?.error).toContain(`Budget is ${(hostGiB * 0.1875).toFixed(1)} GiB`);
    expect(nodeFactsCalls.count).toBe(1);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("reconcile admits a remote ModelRun from the node's reported memory without a NodeRun", async () => {
  const hostGiB = totalmem() / 1024 ** 3;
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-run-nodemem-"));
  const name = "run-nodemem";
  saveWorkload(makeSizedRunManifest(name, 2 * hostGiB), workloadsDir);
  const calls = { count: 0 };
  const client: WorkloadClient = {
    ...makeRunClient(new Map()),
    nodeFacts: {
      query: () => {
        calls.count += 1;
        return Promise.resolve({ memBytes: 4 * hostGiB * 1024 ** 3 });
      },
    },
  };

  try {
    const result = await reconcileOnce({ workloadsDir, getClient: () => client });
    expect(result.errors).toBe(0);
    expect(result.reports).toEqual([
      { kind: "ModelRun", name, node: "mac-mini", action: "started" },
    ]);
    expect(calls.count).toBe(1);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("reconcile refuses a remote ModelRun past a smaller node's reported memory", async () => {
  const hostGiB = totalmem() / 1024 ** 3;
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-run-small-"));
  const name = "run-small-node";
  saveWorkload(makeSizedRunManifest(name, hostGiB / 2), workloadsDir);
  const calls = { count: 0 };
  const client: WorkloadClient = {
    ...makeRunClient(new Map()),
    nodeFacts: {
      query: () => {
        calls.count += 1;
        return Promise.resolve({ memBytes: (hostGiB / 4) * 1024 ** 3 });
      },
    },
  };

  try {
    const result = await reconcileOnce({ workloadsDir, getClient: () => client });
    expect(result.errors).toBe(1);
    expect(result.reports[0]?.action).toBe("pending");
    expect(result.reports[0]?.error).toContain(`Budget is ${(hostGiB * 0.1875).toFixed(1)} GiB`);
    expect(calls.count).toBe(1);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("reconcile keeps a NodeRun budget for a ModelRun and never queries nodeFacts", async () => {
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-run-noderun-budget-"));
  writeHighBudgetNodeRun(workloadsDir);
  const name = "run-budgeted";
  saveWorkload(makeSizedRunManifest(name, 8), workloadsDir);
  const calls = { count: 0 };
  const client: WorkloadClient = {
    ...makeRunClient(new Map()),
    nodeFacts: {
      query: () => {
        calls.count += 1;
        return Promise.resolve({ memBytes: 1 * 1024 ** 3 });
      },
    },
  };

  try {
    const result = await reconcileOnce({ workloadsDir, getClient: () => client });
    expect(result.errors).toBe(0);
    expect(result.reports[0]?.action).toBe("started");
    expect(calls.count).toBe(0);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("reconcile queries nodeFacts once per node per pass for several remote ModelRuns", async () => {
  const hostGiB = totalmem() / 1024 ** 3;
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-run-multi-"));
  saveWorkload(makeSizedRunManifest("aaa-run", hostGiB / 4, 8181), workloadsDir);
  saveWorkload(makeSizedRunManifest("bbb-run", hostGiB / 4, 8182), workloadsDir);
  const calls = { count: 0 };
  const client: WorkloadClient = {
    ...makeRunClient(new Map()),
    nodeFacts: {
      query: () => {
        calls.count += 1;
        return Promise.resolve({ memBytes: 4 * hostGiB * 1024 ** 3 });
      },
    },
  };

  try {
    const result = await reconcileOnce({ workloadsDir, getClient: () => client });
    expect(result.errors).toBe(0);
    expect(result.reports.map((r) => r.action)).toEqual(["started", "started"]);
    expect(calls.count).toBe(1);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("reconcile falls back to the controller budget for a remote ModelRun when nodeFacts rejects", async () => {
  const hostGiB = totalmem() / 1024 ** 3;
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-run-reject-"));
  const name = "run-facts-reject";
  saveWorkload(makeSizedRunManifest(name, hostGiB / 2), workloadsDir);
  const client: WorkloadClient = {
    ...makeRunClient(new Map()),
    nodeFacts: {
      query: () => Promise.reject(new Error("unreachable")),
    },
  };

  try {
    const result = await reconcileOnce({ workloadsDir, getClient: () => client });
    expect(result.errors).toBe(0);
    expect(result.reports[0]?.action).toBe("started");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("reconcile never queries nodeFacts for a ModelRun on the local node", async () => {
  const hostGiB = totalmem() / 1024 ** 3;
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-run-local-"));
  const name = "run-local";
  saveWorkload(makeSizedRunManifest(name, hostGiB / 2, 8181, "local"), workloadsDir);
  const calls = { count: 0 };
  const client: WorkloadClient = {
    ...makeRunClient(new Map()),
    nodeFacts: {
      query: () => {
        calls.count += 1;
        return Promise.resolve({ memBytes: 4 * hostGiB * 1024 ** 3 });
      },
    },
  };

  try {
    const result = await reconcileOnce({ workloadsDir, getClient: () => client });
    expect(result.errors).toBe(0);
    expect(result.reports[0]?.node).toBe("local");
    expect(result.reports[0]?.action).toBe("started");
    expect(calls.count).toBe(0);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("reconcile reports skipped-deleted when a manifest is deleted mid-apply", async () => {
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-mid-delete-"));
  writeHighBudgetNodeRun(workloadsDir);
  const name = "mid-delete";
  saveWorkload(makeRunManifest(name), workloadsDir);

  try {
    const result = await reconcileOnce({
      workloadsDir,
      getClient: (): WorkloadClient => makeClientThatDeletesManifestDuringStart(workloadsDir, name),
    });

    expect(result.errors).toBe(0);
    expect(result.reports).toEqual([
      { kind: "ModelRun", name, node: "mac-mini", action: "skipped-deleted" },
    ]);
    expect(existsSync(workloadPath(name, workloadsDir))).toBe(false);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});
