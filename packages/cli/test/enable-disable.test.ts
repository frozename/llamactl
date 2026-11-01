import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { ModelHostManifest } from "../../remote/src/workload/modelhost-schema.js";
import type { ModelRun } from "../../remote/src/workload/schema.js";

import {
  type ApplyManifestOutcome,
  applyOne,
  applyOneModelHost,
  type ApplyResult,
  type WorkloadClient,
} from "../../remote/src/workload/apply.js";
import {
  loadModelHostByName,
  parseModelHost,
  saveModelHost,
} from "../../remote/src/workload/modelhost-store.js";
import {
  loadWorkloadByName,
  parseWorkload,
  saveWorkload,
} from "../../remote/src/workload/store.js";
import { type SetEnabledDeps, setWorkloadEnabledWithDeps } from "../src/commands/setEnabled.js";
import { mkdtempSync, readFileSync, rmSync } from "../src/safe-fs.js";

let tmp = "";
let workloadsDir = "";
let applyCalls = 0;

function makeManifest(enabled = true): ModelRun {
  return parseWorkload(
    [
      "apiVersion: llamactl/v1",
      "kind: ModelRun",
      "metadata:",
      "  name: gemma-qa",
      "spec:",
      "  node: gpu1",
      `  enabled: ${enabled ? "true" : "false"}`,
      "  target:",
      "    kind: rel",
      "    value: fake-org/fake-model.gguf",
      "  restartPolicy: Always",
      "",
    ].join("\n"),
  );
}

function makeModelHostManifest(enabled = true): string {
  return [
    "apiVersion: llamactl/v1",
    "kind: ModelHost",
    "metadata:",
    "  name: mlx-host",
    "spec:",
    `  enabled: ${enabled ? "true" : "false"}`,
    "  node: local",
    "  engine: omlx",
    "  binary: /tmp/omlx",
    "  endpoint:",
    "    host: 127.0.0.1",
    "    port: 8094",
    "  hostedModels:",
    "    - rel: mlx-community/Qwen3-8B-MLX-4bit",
    "  resources:",
    "    expectedMemoryGiB: 12",
    "  extraArgs: []",
    "  timeoutSeconds: 60",
    "",
  ].join("\n");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-enable-disable-"));
  workloadsDir = join(tmp, "workloads");
  applyCalls = 0;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function deps(): SetEnabledDeps {
  return {
    loadWorkloadByName: (name: string) => {
      return parseYaml(readFileSync(join(workloadsDir, `${name}.yaml`), "utf8")) as ModelRun;
    },
    saveWorkload: (manifest: ModelRun) => saveWorkload(manifest, workloadsDir),
    loadModelHostByName: (name: string) => {
      return parseModelHost(readFileSync(join(workloadsDir, `${name}.yaml`), "utf8"));
    },
    saveModelHost: (manifest: ModelHostManifest) => saveModelHost(manifest, workloadsDir),
    loadConfig: () => ({ currentContext: "default", contexts: [], clusters: [], users: [] }),
    resolveNode: (_cfg: unknown, node: string) => ({ node: { endpoint: `https://${node}` } }),
    getNodeClientByName: () => ({}),
    // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
    applyOne: async (manifest: ModelRun) => {
      applyCalls++;
      return {
        action: manifest.spec.enabled ? "started" : "stopped",
        statusSection: {
          phase: manifest.spec.enabled ? "Running" : "Stopped",
          endpoint: manifest.spec.enabled ? "http://127.0.0.1:8080" : null,
          serverPid: manifest.spec.enabled ? 1234 : null,
          lastTransitionTime: "2026-05-13T00:00:00.000Z",
          conditions: [],
        },
        error: null,
      };
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
    applyOneModelHost: async (manifest: ModelHostManifest): Promise<ApplyManifestOutcome> => {
      applyCalls++;
      return {
        ok: true,
        kind: "ModelHost",
        manifest,
        pid: manifest.spec.enabled ? 1234 : null,
        endpoint: "http://127.0.0.1:8094",
      };
    },
  } as unknown as SetEnabledDeps;
}

interface RecordedApplyOpts {
  getNodeBudgetGiB?: (nodeName: string) => unknown;
  resolveNodeIdentity?: (nodeName: string) => string | null;
}

function nodeRunFixture(name: string, memoryGiB?: number): unknown {
  return {
    apiVersion: "llamactl/v1",
    kind: "NodeRun",
    metadata: { name, labels: {} },
    spec: {
      node: name,
      infra: [],
      ...(memoryGiB !== undefined ? { budget: { memoryGiB } } : {}),
    },
  };
}

describe("llamactl enable/disable", () => {
  test("enable passes the NodeRun budget lookup to a ModelHost apply", async () => {
    await Bun.write(join(workloadsDir, "mlx-host.yaml"), makeModelHostManifest(false));
    const seen: { opts?: RecordedApplyOpts | undefined } = {};
    const result = await setWorkloadEnabledWithDeps("mlx-host", true, {
      ...deps(),
      listNodeRuns: () => [nodeRunFixture("z13", 12), nodeRunFixture("gpu2")],
      applyOneModelHost: (
        manifest: ModelHostManifest,
        _g: unknown,
        _e: unknown,
        opts?: RecordedApplyOpts,
      ): Promise<ApplyManifestOutcome> => {
        applyCalls++;
        seen.opts = opts;
        return Promise.resolve({
          ok: true,
          kind: "ModelHost",
          manifest,
          pid: 1234,
          endpoint: "http://127.0.0.1:8094",
        });
      },
    } as unknown as SetEnabledDeps);

    expect(result.code).toBe(0);
    expect(applyCalls).toBe(1);
    expect(seen.opts?.getNodeBudgetGiB?.("z13")).toBe(12);
    expect(seen.opts?.getNodeBudgetGiB?.("gpu2")).toBeUndefined();
    expect(seen.opts?.getNodeBudgetGiB?.("other")).toBeUndefined();
  });

  test("enable passes the NodeRun budget lookup to a ModelRun apply", async () => {
    saveWorkload(makeManifest(false), workloadsDir);
    const seen: { opts?: RecordedApplyOpts | undefined } = {};
    let listCalls = 0;
    const result = await setWorkloadEnabledWithDeps("gemma-qa", true, {
      ...deps(),
      listNodeRuns: () => {
        listCalls++;
        return [nodeRunFixture("z13", 12), nodeRunFixture("gpu2")];
      },
      applyOne: (_m: unknown, _g: unknown, _e: unknown, _d: unknown, opts?: RecordedApplyOpts) => {
        applyCalls++;
        seen.opts = opts;
        return Promise.resolve({
          action: "started",
          statusSection: {
            phase: "Running",
            endpoint: null,
            serverPid: null,
            lastTransitionTime: "2026-05-13T00:00:00.000Z",
            conditions: [],
          },
          error: null,
        });
      },
    } as unknown as SetEnabledDeps);

    expect(result.code).toBe(0);
    expect(applyCalls).toBe(1);
    expect(listCalls).toBe(0);
    expect(seen.opts?.resolveNodeIdentity?.("gpu1")).toBe("https://gpu1");
    expect(seen.opts?.getNodeBudgetGiB?.("z13")).toBe(12);
    expect(seen.opts?.getNodeBudgetGiB?.("gpu2")).toBeUndefined();
    expect(listCalls).toBe(2);
  });

  test("disable routes a ModelHost through its own manifest path", async () => {
    await Bun.write(join(workloadsDir, "mlx-host.yaml"), makeModelHostManifest(true));

    const result = await setWorkloadEnabledWithDeps("mlx-host", false, deps());

    expect(result.code).toBe(0);
    expect(result.message).toBe("disabled modelhost/mlx-host\n");
    expect(applyCalls).toBe(1);
  });

  test("disable flips spec.enabled false and re-applies", async () => {
    saveWorkload(makeManifest(true), workloadsDir);

    const result = await setWorkloadEnabledWithDeps("gemma-qa", false, deps());

    expect(result.code).toBe(0);
    expect(result.message).toBe("disabled modelrun/gemma-qa\n");
    expect(applyCalls).toBe(1);

    const saved = parseYaml(readFileSync(join(workloadsDir, "gemma-qa.yaml"), "utf8")) as ModelRun;
    expect(saved.spec.enabled).toBe(false);
  });

  test("enable flips spec.enabled true and re-applies", async () => {
    saveWorkload(makeManifest(false), workloadsDir);

    const result = await setWorkloadEnabledWithDeps("gemma-qa", true, deps());

    expect(result.code).toBe(0);
    expect(result.message).toBe("enabled modelrun/gemma-qa\n");
    expect(applyCalls).toBe(1);

    const saved = parseYaml(readFileSync(join(workloadsDir, "gemma-qa.yaml"), "utf8")) as ModelRun;
    expect(saved.spec.enabled).toBe(true);
  });

  test("unknown workload returns not found", async () => {
    const result = await setWorkloadEnabledWithDeps("ghost", true, deps());

    expect(result.code).toBe(1);
    expect(result.message).toContain("workload not found: ghost");
    expect(applyCalls).toBe(0);
  });
});

for (const kind of ["ModelRun", "ModelHost"] as const) {
  test(`${kind} admission refusal leaves disabled desired manifest byte-for-byte unchanged`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "enable-admission-audit-"));
    const workloadsDir = join(directory, "workloads");
    const name = "refused-enable";
    const calls: string[] = [];
    const forbidden = (operation: string): never => {
      calls.push(operation);
      throw new Error(`unexpected runtime mutation: ${operation}`);
    };
    const client = {
      serverStatus: {
        query: () => {
          calls.push("serverStatus");
          return Promise.resolve({
            state: "down",
            rel: null,
            extraArgs: [],
            pid: null,
            host: null,
            port: null,
            binary: null,
            endpoint: "http://127.0.0.1:18095",
          });
        },
      },
      serverStart: { subscribe: () => forbidden("serverStart") },
      serverStop: { mutate: () => forbidden("serverStop") },
      modelHostStart: { subscribe: () => forbidden("modelHostStart") },
      modelHostStop: { mutate: () => forbidden("modelHostStop") },
      modelHostStatus: { query: () => forbidden("modelHostStatus") },
    } as unknown as WorkloadClient;
    const common = `apiVersion: llamactl/v1\nkind: ${kind}\nmetadata:\n  name: ${name}\nspec:\n  node: inert-audit-node\n  enabled: false\n  resources:\n    expectedMemoryGiB: 2\n`;
    try {
      if (kind === "ModelRun") {
        saveWorkload(
          parseWorkload(common + "  target:\n    kind: rel\n    value: inert.gguf\n"),
          workloadsDir,
        );
      } else {
        saveModelHost(
          parseModelHost(
            common +
              "  engine: omlx\n  binary: /inert/nonexistent-omlx\n  endpoint:\n    host: 127.0.0.1\n    port: 18095\n  hostedModels:\n    - rel: inert-model\n",
          ),
          workloadsDir,
        );
      }
      const path = join(workloadsDir, `${name}.yaml`);
      const before = readFileSync(path, "utf8");
      const refusalDeps: SetEnabledDeps = {
        ...deps(),
        loadWorkloadByName: (n: string) => loadWorkloadByName(n, workloadsDir),
        saveWorkload: (m: Parameters<typeof saveWorkload>[0]) => saveWorkload(m, workloadsDir),
        loadModelHostByName: (n: string) => loadModelHostByName(n, workloadsDir),
        saveModelHost: (m: Parameters<typeof saveModelHost>[0]) => saveModelHost(m, workloadsDir),
        getNodeClientByName: () =>
          client as unknown as ReturnType<NonNullable<SetEnabledDeps["getNodeClientByName"]>>,
        listNodeRuns: () => [
          {
            apiVersion: "llamactl/v1",
            kind: "NodeRun",
            metadata: { name: "inert-audit-node", labels: {} },
            spec: { node: "inert-audit-node", infra: [], budget: { memoryGiB: 1 } },
          },
        ],
        applyOne: (manifest, getClient, onEvent, gatewayDispatch, opts) =>
          applyOne(manifest, getClient, onEvent, gatewayDispatch, { ...opts, workloadsDir }),
        applyOneModelHost: (manifest, getClient, onEvent, opts) =>
          applyOneModelHost(manifest, getClient, onEvent, {
            ...opts,
            workloadsDir,
            env: { DEV_STORAGE: directory, HOME: directory },
          }),
      };
      const result = await setWorkloadEnabledWithDeps(name, true, refusalDeps);
      expect(result.code).toBe(1);
      expect(result.message).toContain("Budget is 1.0 GiB");
      expect(calls).toEqual(kind === "ModelRun" ? ["serverStatus"] : []);
      const after = readFileSync(path, "utf8");
      expect(after).toBe(before);
      const saved =
        kind === "ModelRun"
          ? loadWorkloadByName(name, workloadsDir)
          : loadModelHostByName(name, workloadsDir);
      expect(saved.spec.enabled).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

function saveFixture(kind: "ModelRun" | "ModelHost", enabled: boolean): string {
  const manifest =
    kind === "ModelRun" ? makeManifest(enabled) : parseModelHost(makeModelHostManifest(enabled));
  if (manifest.kind === "ModelRun") saveWorkload(manifest, workloadsDir);
  else saveModelHost(manifest, workloadsDir);
  return manifest.metadata.name;
}

function recordingDeps(events: string[]): SetEnabledDeps {
  return {
    ...deps(),
    saveWorkload: (manifest): string => {
      events.push("save");
      return saveWorkload(manifest, workloadsDir);
    },
    saveModelHost: (manifest): string => {
      events.push("save");
      return saveModelHost(manifest, workloadsDir);
    },
  };
}

for (const kind of ["ModelRun", "ModelHost"] as const) {
  test(`${kind} successful enable saves once after apply resolves`, async () => {
    const name = saveFixture(kind, false);
    const path = join(workloadsDir, `${name}.yaml`);
    const before = readFileSync(path, "utf8");
    const events: string[] = [];
    const commandDeps = recordingDeps(events);
    const applyRun = commandDeps.applyOne!;
    const applyHost = commandDeps.applyOneModelHost!;
    const beforeApply = (): void => {
      events.push("apply");
      expect(readFileSync(path, "utf8")).toBe(before);
    };
    commandDeps.applyOne = async (...args): Promise<ApplyResult> => {
      beforeApply();
      const outcome = await applyRun(...args);
      events.push("applied");
      return outcome;
    };
    commandDeps.applyOneModelHost = async (...args): Promise<ApplyManifestOutcome> => {
      beforeApply();
      const outcome = await applyHost(...args);
      events.push("applied");
      return outcome;
    };

    const result = await setWorkloadEnabledWithDeps(name, true, commandDeps);

    expect(result.code).toBe(0);
    expect(events).toEqual(["apply", "applied", "save"]);
    expect((parseYaml(readFileSync(path, "utf8")) as ModelRun).spec.enabled).toBe(true);
  });

  for (const failure of ["returned", "thrown"] as const) {
    test(`${kind} ${failure} enable failure preserves disabled bytes without saving`, async () => {
      const name = saveFixture(kind, false);
      const path = join(workloadsDir, `${name}.yaml`);
      const before = readFileSync(path, "utf8");
      const events: string[] = [];
      const commandDeps = recordingDeps(events);
      const applyRun = commandDeps.applyOne!;
      const applyHost = commandDeps.applyOneModelHost!;
      const beforeApply = (): void => {
        events.push("apply");
        expect(readFileSync(path, "utf8")).toBe(before);
      };
      commandDeps.applyOne = async (...args): Promise<ApplyResult> => {
        beforeApply();
        const outcome = await applyRun(...args);
        if (failure === "thrown") throw new Error("start failed");
        return { ...outcome, error: "start failed" };
      };
      commandDeps.applyOneModelHost = async (...args): Promise<ApplyManifestOutcome> => {
        beforeApply();
        await applyHost(...args);
        if (failure === "thrown") throw new Error("start failed");
        return { ok: false, error: "start failed" };
      };

      const pending = setWorkloadEnabledWithDeps(name, true, commandDeps);
      if (failure === "thrown") {
        const error = await pending.catch((caught: unknown): unknown => caught);
        expect(error).toBeInstanceOf(Error);
        expect(error).toHaveProperty("message", "start failed");
      } else {
        const result = await pending;
        expect(result.code).toBe(1);
        expect(result.message).toContain("start failed");
      }
      expect(events).toEqual(["apply"]);
      expect(readFileSync(path, "utf8")).toBe(before);
    });

    test(`${kind} ${failure} disable failure retains false intent saved before apply`, async () => {
      const name = saveFixture(kind, true);
      const path = join(workloadsDir, `${name}.yaml`);
      const events: string[] = [];
      const commandDeps = recordingDeps(events);
      const applyRun = commandDeps.applyOne!;
      const applyHost = commandDeps.applyOneModelHost!;
      const beforeApply = (): void => {
        events.push("apply");
        expect((parseYaml(readFileSync(path, "utf8")) as ModelRun).spec.enabled).toBe(false);
      };
      commandDeps.applyOne = async (...args): Promise<ApplyResult> => {
        beforeApply();
        const outcome = await applyRun(...args);
        if (failure === "thrown") throw new Error("stop failed");
        return { ...outcome, error: "stop failed" };
      };
      commandDeps.applyOneModelHost = async (...args): Promise<ApplyManifestOutcome> => {
        beforeApply();
        await applyHost(...args);
        if (failure === "thrown") throw new Error("stop failed");
        return { ok: false, error: "stop failed" };
      };

      const pending = setWorkloadEnabledWithDeps(name, false, commandDeps);
      if (failure === "thrown") {
        const error = await pending.catch((caught: unknown): unknown => caught);
        expect(error).toBeInstanceOf(Error);
        expect(error).toHaveProperty("message", "stop failed");
      } else {
        const result = await pending;
        expect(result.code).toBe(1);
        expect(result.message).toContain("stop failed");
      }
      expect(events).toEqual(["save", "apply"]);
      expect((parseYaml(readFileSync(path, "utf8")) as ModelRun).spec.enabled).toBe(false);
    });
  }
}
