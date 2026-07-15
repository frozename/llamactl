import { computeModelHostSpecHash } from "@llamactl/core/engines/state";
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
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
    expect(first.reports).toEqual([{ name, node: "mac-mini", action: "unchanged" }]);
    expect(remoteState.starts).toBe(0);

    const drifted = makeManifest(name, ["--new-flag"]);
    saveModelHost(drifted, workloadsDir);
    const second = await reconcileOnce({ workloadsDir, getClient });
    expect(second.errors).toBe(0);
    expect(second.reports).toEqual([{ name, node: "mac-mini", action: "restarted" }]);
    expect(remoteState.starts).toBe(1);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("reconcile skips deleted manifests without resurrecting them", async () => {
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-"));
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
      { name: blocker, node: "mac-mini", action: "started" },
      { name, node: "mac-mini", action: "skipped-deleted" },
    ]);
    expect(existsSync(path)).toBe(false);

    const second = await reconcileOnce({ workloadsDir, getClient });
    expect(second.errors).toBe(0);
    expect(second.reports).toEqual([{ name: blocker, node: "mac-mini", action: "started" }]);
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
    expect(result.reports).toEqual([{ name, node: "mac-mini", action: "started" }]);
    expect(existsSync(workloadPath(name, workloadsDir))).toBe(true);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("reconcile preserves renamed manifests without resurrecting the old name", async () => {
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-reconcile-"));
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
      { name: blocker, node: "mac-mini", action: "started" },
      { name, node: "mac-mini", action: "skipped-deleted" },
    ]);
    expect(existsSync(originalPath)).toBe(false);
    expect(existsSync(renamedPath)).toBe(true);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});
