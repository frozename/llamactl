import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import type { ModelRun } from "../src/workload/schema.js";

import { type ApplyEvent, applyManifest, type WorkloadClient } from "../src/workload/apply.js";

let workloadsDir: string;
let envWorkloadsDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-amopt-wld-"));
  // A separate empty dir that defaultWorkloadsDir() will resolve to,
  // ensuring conflict manifests we write to workloadsDir stay invisible
  // until the fix threads workloadsDir through to applyOne.
  envWorkloadsDir = mkdtempSync(join(tmpdir(), "llamactl-amopt-env-"));
  for (const k of ["LLAMACTL_WORKLOADS_DIR", "DEV_STORAGE"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.LLAMACTL_WORKLOADS_DIR = envWorkloadsDir;
  Reflect.deleteProperty(process.env, "DEV_STORAGE");
});

afterEach(() => {
  rmSync(workloadsDir, { recursive: true, force: true });
  rmSync(envWorkloadsDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

function makeOkClient(): WorkloadClient {
  return {
    serverStatus: {
      async query(): ReturnType<WorkloadClient["serverStatus"]["query"]> {
        await Promise.resolve();
        return {
          state: "down",
          rel: null,
          extraArgs: [],
          pid: null,
          host: null,
          port: null,
          binary: null,
          endpoint: "",
        };
      },
    },
    serverStop: {
      async mutate(): Promise<unknown> {
        await Promise.resolve();
        return {};
      },
    },
    serverStart: {
      subscribe(_input, callbacks): { unsubscribe(): undefined } {
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 42, endpoint: "http://127.0.0.1:8080" },
          });
          callbacks.onComplete();
        });
        return {
          unsubscribe(): undefined {
            return undefined;
          },
        };
      },
    },
    modelHostStart: {
      subscribe(_input, callbacks): { unsubscribe(): undefined } {
        queueMicrotask(() => {
          callbacks.onData({ type: "done", result: { ok: true } });
          callbacks.onComplete();
        });
        return {
          unsubscribe(): undefined {
            return undefined;
          },
        };
      },
    },
    modelHostStop: {
      async mutate(): Promise<unknown> {
        await Promise.resolve();
        return {};
      },
    },
    modelHostStatus: {
      async query(): Promise<{ state: string; pid: null }> {
        await Promise.resolve();
        return { state: "Stopped", pid: null };
      },
    },
    rpcServerStart: {
      subscribe(_input, callbacks): { unsubscribe(): undefined } {
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 99, endpoint: "127.0.0.1:50052" },
          });
          callbacks.onComplete();
        });
        return {
          unsubscribe(): undefined {
            return undefined;
          },
        };
      },
    },
    rpcServerStop: {
      async mutate(): Promise<unknown> {
        await Promise.resolve();
        return {};
      },
    },
    rpcServerDoctor: {
      async query(): Promise<{ ok: true; path: string; llamaCppBin: string }> {
        await Promise.resolve();
        return { ok: true, path: "/fake/rpc-server", llamaCppBin: "/fake/bin" };
      },
    },
  };
}

function makeModelRun(overrides: Partial<ModelRun["spec"]> = {}, name = "test-model"): ModelRun {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name, labels: {}, annotations: {} },
    spec: {
      node: "local",
      enabled: true,
      gateway: false,
      allowExternalBind: false,
      target: { kind: "rel", value: "tiny.gguf" },
      extraArgs: [],
      workers: [],
      restartPolicy: "Always",
      timeoutSeconds: 30,
      ...overrides,
    },
  };
}

function writeManifest(dir: string, m: ModelRun): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(join(dir, `${m.metadata.name}.yaml`), stringifyYaml(m), "utf8");
}

describe("applyManifest options forwarding (D6-apply-node-budget)", () => {
  test("getNodeBudgetGiB: over-budget ModelRun is rejected", async () => {
    const outcome = await applyManifest({
      manifest: makeModelRun({ resources: { expectedMemoryGiB: 20 } }),
      getClient: () => makeOkClient(),
      workloadsDir, // empty — sole contributor is the 20 GiB incoming manifest
      getNodeBudgetGiB: () => 10,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatch(/budget|BudgetExceeded/i);
    }
  });

  test("getNodeBudgetGiB: within-budget ModelRun is admitted", async () => {
    const outcome = await applyManifest({
      manifest: makeModelRun({ resources: { expectedMemoryGiB: 5 } }),
      getClient: () => makeOkClient(),
      workloadsDir,
      getNodeBudgetGiB: () => 10,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.kind).toBe("ModelRun");
    }
  });

  test("workloadsDir: port collision in supplied workloadsDir is detected", async () => {
    // Write a conflict manifest into workloadsDir (not envWorkloadsDir).
    // Without the fix, applyOne reads envWorkloadsDir (empty) and misses the collision.
    writeManifest(
      workloadsDir,
      makeModelRun({ node: "local", endpoint: { host: "127.0.0.1", port: 8181 } }, "other-model"),
    );
    const outcome = await applyManifest({
      manifest: makeModelRun({ node: "local", endpoint: { host: "127.0.0.1", port: 8181 } }),
      getClient: () => makeOkClient(),
      workloadsDir,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("port collision");
    }
  });

  test("resolveNodeIdentity: aliased-node port collision is detected", async () => {
    // Conflict manifest lives on "node-a"; incoming targets "node-b".
    // resolveNodeIdentity maps both to the same physical endpoint, so
    // the collision should be caught — but only once the fix threads
    // resolveNodeIdentity through to applyOne/checkPortCollision.
    writeManifest(
      workloadsDir,
      makeModelRun({ node: "node-a", endpoint: { host: "127.0.0.1", port: 8282 } }, "other-model"),
    );
    const sharedIdentity = "http://shared-agent:9999";
    const outcome = await applyManifest({
      manifest: makeModelRun(
        { node: "node-b", endpoint: { host: "127.0.0.1", port: 8282 } },
        "test-model",
      ),
      getClient: () => makeOkClient(),
      workloadsDir,
      resolveNodeIdentity: () => sharedIdentity,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("port collision");
    }
  });

  test("onEvent: start/started events from ModelRun apply are forwarded", async () => {
    const events: ApplyEvent[] = [];
    const outcome = await applyManifest({
      manifest: makeModelRun(),
      getClient: () => makeOkClient(),
      workloadsDir,
      onEvent: (e) => events.push(e),
    });
    expect(outcome.ok).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "start" || e.type === "started")).toBe(true);
  });
});
