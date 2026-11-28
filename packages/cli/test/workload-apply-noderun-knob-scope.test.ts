import type { NodeClient } from "@llamactl/remote";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetWorkloadTestSeams,
  __setWorkloadTestSeams,
  runApply,
} from "../src/commands/workload.js";
import { EMPTY_GLOBALS, setGlobals } from "../src/dispatcher.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

let tmp = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-apply-noderun-knob-scope-"));
  process.env["DEV_STORAGE"] = join(tmp, "dev");
  process.env["LLAMACTL_CONFIG"] = join(tmp, "no-such-kubeconfig.yaml");
  process.env["LLAMACTL_WORKLOADS_DIR"] = join(tmp, "workloads");
  process.env["LLAMACTL_INFRA_PACKAGES_DIR"] = join(tmp, "packages");
  process.env["LOCAL_AI_RUNTIME_DIR"] = join(tmp, "runtime");
  mkdirSync(process.env["LLAMACTL_WORKLOADS_DIR"], { recursive: true });
  mkdirSync(process.env["LLAMACTL_INFRA_PACKAGES_DIR"], { recursive: true });
  mkdirSync(process.env["LOCAL_AI_RUNTIME_DIR"], { recursive: true });
  setGlobals(EMPTY_GLOBALS);
});

afterEach(() => {
  __resetWorkloadTestSeams();
  setGlobals(EMPTY_GLOBALS);
  process.env = { ...originalEnv };
  rmSync(tmp, { recursive: true, force: true });
});

function withCapturedIo<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const stdoutOrig = process.stdout.write.bind(process.stdout);
  const stderrOrig = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };

  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  return fn()
    .then((result) => ({ result, stdout, stderr }))
    .finally(() => {
      process.stdout.write = stdoutOrig;
      process.stderr.write = stderrOrig;
    });
}

interface InfraListRow {
  pkg: string;
  versions: string[];
  active: string | null;
}

interface NodeRpcHandlers {
  infraListQuery: () => Promise<InfraListRow[]>;
  nodeFactsQuery: () => Promise<unknown>;
  infraInstallMutate: () => Promise<unknown>;
  infraActivateMutate: () => Promise<unknown>;
  infraUninstallMutate: () => Promise<unknown>;
}

function procedure(calls: { query?: () => Promise<unknown>; mutate?: () => Promise<unknown> }): {
  (): void;
  query?: () => Promise<unknown>;
  mutate?: () => Promise<unknown>;
} {
  return Object.assign((): void => undefined, calls);
}

function makeNodeClient(handlers: NodeRpcHandlers): NodeClient {
  const client = {
    infraList: procedure({ query: handlers.infraListQuery }),
    nodeFacts: procedure({ query: handlers.nodeFactsQuery }),
    infraInstall: procedure({ mutate: handlers.infraInstallMutate }),
    infraActivate: procedure({ mutate: handlers.infraActivateMutate }),
    infraUninstall: procedure({ mutate: handlers.infraUninstallMutate }),
  };
  expect(typeof client.infraList).toBe("function");
  return client as unknown as NodeClient;
}

interface SeamState {
  infraListCalls: number;
  nodeClientRequested: boolean;
  requestedNames: string[];
}

function seamNodeClient(): SeamState {
  const state: SeamState = {
    infraListCalls: 0,
    nodeClientRequested: false,
    requestedNames: [],
  };
  __setWorkloadTestSeams({
    nodeQueryTimeoutMs: 1000,
    getNodeClientByName: (name) => {
      state.nodeClientRequested = true;
      state.requestedNames.push(name);
      return makeNodeClient({
        infraListQuery: () => {
          state.infraListCalls += 1;
          return Promise.resolve([]);
        },
        nodeFactsQuery: () => Promise.reject(new Error("nodeFacts must not be queried")),
        infraInstallMutate: () => Promise.reject(new Error("infraInstall must not be called")),
        infraActivateMutate: () => Promise.reject(new Error("infraActivate must not be called")),
        infraUninstallMutate: () => Promise.reject(new Error("infraUninstall must not be called")),
      });
    },
  });
  return state;
}

function writeNodeRunManifest(options: {
  name: string;
  node: string;
  knobLines?: string[];
}): string {
  const manifestPath = join(tmp, `${options.name}.yaml`);
  writeFileSync(
    manifestPath,
    `${[
      "apiVersion: llamactl/v1",
      "kind: NodeRun",
      "metadata:",
      `  name: ${options.name}`,
      "spec:",
      `  node: ${options.node}`,
      "  infra: []",
      ...(options.knobLines ?? []).map((line) => `  ${line}`),
    ].join("\n")}\n`,
    "utf8",
  );
  return manifestPath;
}

function savedManifestPath(name: string): string {
  return join(process.env["LLAMACTL_WORKLOADS_DIR"]!, `${name}.yaml`);
}

test("A1: apply rejects a residency policy when the NodeRun name differs from its node", async () => {
  const seam = seamNodeClient();
  const manifestPath = writeNodeRunManifest({
    name: "gpu1-infra",
    node: "gpu1",
    knobLines: ["residency:", "  minResidencySeconds: 300"],
  });

  const { result, stderr } = await withCapturedIo(() => runApply(["-f", manifestPath]));

  expect(result).toBe(1);
  expect(stderr).toContain("apply: NodeRun manifest rejected: ");
  expect(stderr).toContain("metadata.name 'gpu1-infra' differs from spec.node 'gpu1'");
  expect(seam.infraListCalls).toBe(0);
  expect(seam.nodeClientRequested).toBe(false);
  expect(existsSync(savedManifestPath("gpu1-infra"))).toBe(false);
});

test("A2: apply rejects a budget when the NodeRun name differs from its node", async () => {
  const seam = seamNodeClient();
  const manifestPath = writeNodeRunManifest({
    name: "gpu1-infra",
    node: "gpu1",
    knobLines: ["budget:", "  memoryGiB: 24"],
  });

  const { result, stderr } = await withCapturedIo(() => runApply(["-f", manifestPath]));

  expect(result).toBe(1);
  expect(stderr).toContain("apply: NodeRun manifest rejected: ");
  expect(stderr).toContain("spec.budget");
  expect(seam.infraListCalls).toBe(0);
  expect(seam.nodeClientRequested).toBe(false);
  expect(existsSync(savedManifestPath("gpu1-infra"))).toBe(false);
});

test("A3: a rejected mismatched NodeRun emits no JSON success payload", async () => {
  const seam = seamNodeClient();
  const manifestPath = writeNodeRunManifest({
    name: "gpu1-infra",
    node: "gpu1",
    knobLines: ["residency:", "  minResidencySeconds: 300"],
  });

  const { result, stdout, stderr } = await withCapturedIo(() =>
    runApply(["-f", manifestPath, "--json"]),
  );

  expect(result).toBe(1);
  expect(stderr).toContain("apply: NodeRun manifest rejected: ");
  expect(stdout).toBe("");
  expect(seam.infraListCalls).toBe(0);
  expect(seam.nodeClientRequested).toBe(false);
  expect(existsSync(savedManifestPath("gpu1-infra"))).toBe(false);
});

test("A4: an infra-only NodeRun may use a name different from its node", async () => {
  const seam = seamNodeClient();
  const manifestPath = writeNodeRunManifest({ name: "gpu1-infra", node: "gpu1" });

  const { result } = await withCapturedIo(() => runApply(["-f", manifestPath]));

  expect(result).toBe(0);
  expect(existsSync(savedManifestPath("gpu1-infra"))).toBe(true);
  expect(seam.infraListCalls).toBe(2);
  expect(seam.nodeClientRequested).toBe(true);
});

test("A5: a NodeRun named for its node may carry residency", async () => {
  const seam = seamNodeClient();
  const manifestPath = writeNodeRunManifest({
    name: "gpu1",
    node: "gpu1",
    knobLines: ["residency:", "  minResidencySeconds: 300"],
  });

  const { result } = await withCapturedIo(() => runApply(["-f", manifestPath]));

  expect(result).toBe(0);
  expect(existsSync(savedManifestPath("gpu1"))).toBe(true);
  expect(seam.nodeClientRequested).toBe(true);
  expect(seam.requestedNames).toEqual(["gpu1"]);
});
