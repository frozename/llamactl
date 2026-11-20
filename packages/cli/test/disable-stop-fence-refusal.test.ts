// Part of #522: `llamactl disable` must surface a node stop-fence refusal
// as exit 1 with the refusal detail, for both ModelRun (serverStop) and
// ModelHost (modelHostStop). At the pinned base, stopDisabledWorkload
// ignores the serverStop outcome so the ModelRun cases fail by assertion;
// the ModelHost guard already passes because disableModelHost maps
// refusedStopReason today.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { WorkloadClient } from "../../remote/src/workload/apply.js";
import type { ModelHostManifest } from "../../remote/src/workload/modelhost-schema.js";
import type { ModelRun } from "../../remote/src/workload/schema.js";

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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-disable-stop-fence-"));
  workloadsDir = join(tmp, "workloads");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function modelRunYaml(enabled: boolean): string {
  return [
    "apiVersion: llamactl/v1",
    "kind: ModelRun",
    "metadata:",
    "  name: chat-a",
    "spec:",
    "  node: gpu1",
    `  enabled: ${enabled ? "true" : "false"}`,
    "  target:",
    "    kind: rel",
    "    value: fake-org/fake.gguf",
    "  restartPolicy: Always",
    "",
  ].join("\n");
}

// Same shape as enable-disable.test.ts's makeModelHostManifest, but on a
// non-local node so validateModelHostAdmission skips engine.validateSpec
// (the /tmp/omlx existsSync) and the disable branch runs everywhere.
function modelHostYaml(enabled: boolean): string {
  return [
    "apiVersion: llamactl/v1",
    "kind: ModelHost",
    "metadata:",
    "  name: mlx-host",
    "spec:",
    `  enabled: ${enabled ? "true" : "false"}`,
    "  node: gpu1",
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

interface StopCall {
  workload: string;
  graceSeconds?: number;
}

function makeClient(opts: { serverStopOutcome?: unknown; modelHostStopOutcome?: unknown }): {
  client: WorkloadClient;
  serverStops: StopCall[];
  modelHostStops: StopCall[];
} {
  const serverStops: StopCall[] = [];
  const modelHostStops: StopCall[] = [];
  const client = {
    serverStatus: {
      query: () =>
        Promise.resolve({
          state: "up",
          rel: "fake-org/fake.gguf",
          extraArgs: [] as string[],
          pid: 4242,
          host: "127.0.0.1",
          port: 8080,
          binary: null,
          endpoint: "http://127.0.0.1:8080",
        }),
    },
    serverStop: {
      mutate: (input: StopCall) => {
        serverStops.push(input);
        return Promise.resolve(opts.serverStopOutcome);
      },
    },
    modelHostStop: {
      mutate: (input: StopCall) => {
        modelHostStops.push(input);
        return Promise.resolve(opts.modelHostStopOutcome);
      },
    },
  } as unknown as WorkloadClient;
  return { client, serverStops, modelHostStops };
}

function deps(client: WorkloadClient): SetEnabledDeps {
  return {
    loadWorkloadByName: (name: string) => loadWorkloadByName(name, workloadsDir),
    saveWorkload: (manifest: ModelRun) => saveWorkload(manifest, workloadsDir),
    loadModelHostByName: (name: string) => loadModelHostByName(name, workloadsDir),
    saveModelHost: (manifest: ModelHostManifest) => saveModelHost(manifest, workloadsDir),
    loadConfig: () => ({ currentContext: "default", contexts: [], clusters: [], users: [] }),
    resolveNode: (_cfg: unknown, node: string) => ({ node: { endpoint: `https://${node}` } }),
    getNodeClientByName: () => client,
    listNodeRuns: () => [],
  } as unknown as SetEnabledDeps;
}

describe("#522 llamactl disable stop-fence refusal", () => {
  // Kills: applyOne's new error never reaching the CLI — the disable must
  // exit 1 with the refusal detail while spec.enabled:false stays stored.
  test("f: ModelRun disable refused SessionsActive exits 1 and keeps enabled false", async () => {
    saveWorkload(parseWorkload(modelRunYaml(true)), workloadsDir);
    const { client, serverStops } = makeClient({
      serverStopOutcome: {
        stopped: false,
        pid: null,
        killed: false,
        refused: { reason: "SessionsActive", active: ["s1"] },
      },
    });

    const result = await setWorkloadEnabledWithDeps("chat-a", false, deps(client));

    expect(result.code).toBe(1);
    expect(result.message).toBe("disable: serverStop refused: SessionsActive: s1\n");
    const stored = parseYaml(readFileSync(join(workloadsDir, "chat-a.yaml"), "utf8")) as ModelRun;
    expect(stored.spec.enabled).toBe(false);
    expect(serverStops).toEqual([{ workload: "chat-a", graceSeconds: 5 }]);
  });

  // Kills: an unconditional id-list suffix — SessionsUnknown carries no
  // active ids, so the message must not end in ": ".
  test("g: ModelRun disable refused SessionsUnknown exits 1 without an id suffix", async () => {
    saveWorkload(parseWorkload(modelRunYaml(true)), workloadsDir);
    const { client } = makeClient({
      serverStopOutcome: {
        stopped: false,
        pid: null,
        killed: false,
        refused: { reason: "SessionsUnknown", active: [] },
      },
    });

    const result = await setWorkloadEnabledWithDeps("chat-a", false, deps(client));

    expect(result.code).toBe(1);
    expect(result.message).toBe("disable: serverStop refused: SessionsUnknown\n");
  });

  // Guard: pins the existing ModelHost behaviour — disableModelHost already
  // maps a refused modelHostStop to exit 1; the fix must not regress it.
  test("h: ModelHost disable refused SessionsActive exits 1 via modelHostStop", async () => {
    saveModelHost(parseModelHost(modelHostYaml(true)), workloadsDir);
    const { client, modelHostStops } = makeClient({
      modelHostStopOutcome: { ok: false, pid: null, error: "SessionsActive: s1" },
    });

    const result = await setWorkloadEnabledWithDeps("mlx-host", false, deps(client));

    expect(result.code).toBe(1);
    expect(result.message).toBe("disable: modelHostStop refused: SessionsActive: s1\n");
    expect(modelHostStops).toEqual([{ workload: "mlx-host" }]);
    const stored = parseYaml(
      readFileSync(join(workloadsDir, "mlx-host.yaml"), "utf8"),
    ) as ModelHostManifest;
    expect(stored.spec.enabled).toBe(false);
  });
});
