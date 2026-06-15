import type { ResolvedEnv } from "@llamactl/core";

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ResolveWorkloadDeps,
  resolveWorkloadName,
} from "../src/commands/_workload-resolve.js";

const tempEnv = (): { runtimeDir: string; resolved: ResolvedEnv; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "workload-resolve-"));
  return {
    runtimeDir: dir,
    resolved: { LOCAL_AI_RUNTIME_DIR: dir } as ResolvedEnv,
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let current: ReturnType<typeof tempEnv> | null = null;

afterEach(() => {
  current?.cleanup();
  current = null;
});

// Pin the local branch so these cases stay hermetic regardless of the
// machine's ambient kubeconfig (a dev box whose current context points at
// a remote node would otherwise take the remote path).
const localDeps: ResolveWorkloadDeps = { isLocalDispatch: () => true };

/**
 * Force the remote/explicit-node branch with a stubbed control-plane
 * manifest store. Each entry is `{ name, node }` (the only fields the
 * resolver reads); the store is shaped like the real
 * `listAnyWorkloadsForAdmission()` output.
 */
const remoteDeps = (
  targetNode: string,
  manifests: { name: string; node: string }[],
): ResolveWorkloadDeps => ({
  isLocalDispatch: () => false,
  resolveEffectiveNodeName: () => targetNode,
  listWorkloads: (() =>
    manifests.map((m) => ({
      metadata: { name: m.name },
      spec: { node: m.node },
    }))) as unknown as ResolveWorkloadDeps["listWorkloads"],
});

describe("resolveWorkloadName (local path)", () => {
  test("falls back to known workload dirs after stop removes pidfiles", () => {
    current = tempEnv();
    const { runtimeDir, resolved } = current;
    mkdirSync(join(runtimeDir, "workloads", "solo"), { recursive: true });
    expect(resolveWorkloadName(undefined, resolved, undefined, localDeps)).toBe("solo");
  });

  test("synthesizes when no workloads exist and requested", () => {
    current = tempEnv();
    const { resolved } = current;
    expect(
      resolveWorkloadName(undefined, resolved, { synthesizeIfEmpty: true }, localDeps),
    ).toMatch(/^imperative-\d+$/);
  });

  test("reports multiple known workloads without pidfiles", () => {
    current = tempEnv();
    const { runtimeDir, resolved } = current;
    mkdirSync(join(runtimeDir, "workloads", "a"), { recursive: true });
    mkdirSync(join(runtimeDir, "workloads", "b"), { recursive: true });
    expect(() => resolveWorkloadName(undefined, resolved, undefined, localDeps)).toThrow(
      "multiple workloads on this node (a, b); pass --name <workload>",
    );
  });

  test("keeps live workload precedence when pidfiles are present", () => {
    current = tempEnv();
    const { runtimeDir, resolved } = current;
    const a = join(runtimeDir, "workloads", "a");
    const b = join(runtimeDir, "workloads", "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "llama-server.pid"), "123\n");
    expect(resolveWorkloadName(undefined, resolved, undefined, localDeps)).toBe("a");
  });
});

describe("resolveWorkloadName (remote / explicit-node path)", () => {
  const resolved = { LOCAL_AI_RUNTIME_DIR: "/does/not/matter" } as ResolvedEnv;

  test("an explicit name short-circuits without listing the store", () => {
    let listed = false;
    const deps: ResolveWorkloadDeps = {
      isLocalDispatch: () => false,
      resolveEffectiveNodeName: () => "gpu1",
      listWorkloads: () => {
        listed = true;
        return [];
      },
    };
    expect(resolveWorkloadName("pinned", resolved, undefined, deps)).toBe("pinned");
    expect(listed).toBe(false);
  });

  test("scopes resolution to the target node, ignoring workloads on other nodes", () => {
    // The silent-wrong-node bug: with one workload on gpu1 and others on
    // gpu2, `--node gpu1 server stop` must resolve gpu1's workload — not
    // auto-pick or ambiguously error across the whole store.
    const deps = remoteDeps("gpu1", [
      { name: "judge", node: "gpu1" },
      { name: "draft-a", node: "gpu2" },
      { name: "draft-b", node: "gpu2" },
    ]);
    expect(resolveWorkloadName(undefined, resolved, undefined, deps)).toBe("judge");
  });

  test("server start synthesizes rather than adopting the node's single workload", () => {
    // `server start --node gpu1` (synthesizeIfEmpty) means "create" — it
    // must NOT adopt and overwrite gpu1's existing `judge` manifest.
    const deps = remoteDeps("gpu1", [{ name: "judge", node: "gpu1" }]);
    expect(resolveWorkloadName(undefined, resolved, { synthesizeIfEmpty: true }, deps)).toMatch(
      /^imperative-\d+$/,
    );
  });

  test("errors when the target node has multiple workloads", () => {
    const deps = remoteDeps("gpu1", [
      { name: "a", node: "gpu1" },
      { name: "b", node: "gpu1" },
      { name: "elsewhere", node: "gpu2" },
    ]);
    expect(() => resolveWorkloadName(undefined, resolved, undefined, deps)).toThrow(
      "multiple workloads on this node (a, b); pass --name <workload>",
    );
  });

  test("synthesizes when the target node has no workloads and asked", () => {
    const deps = remoteDeps("gpu1", [{ name: "elsewhere", node: "gpu2" }]);
    expect(resolveWorkloadName(undefined, resolved, { synthesizeIfEmpty: true }, deps)).toMatch(
      /^imperative-\d+$/,
    );
  });

  test("errors when the target node has no workloads and synthesize is off", () => {
    const deps = remoteDeps("gpu1", [{ name: "elsewhere", node: "gpu2" }]);
    expect(() => resolveWorkloadName(undefined, resolved, undefined, deps)).toThrow(
      "no workloads assigned to node gpu1; pass --name <workload>",
    );
  });

  test("resolves a ModelHost workload on the target node via the admission lister", () => {
    // Parity with the local path (which detects modelhost.pid): a ModelHost
    // assigned to the target node must be resolvable on the remote path too.
    // Exercises the REAL listAnyWorkloadsForAdmission (not injected) so the
    // ModelHost->ModelRun projection is covered end-to-end.
    current = tempEnv();
    const manifestsDir = join(current.runtimeDir, "manifests");
    mkdirSync(manifestsDir, { recursive: true });
    writeFileSync(
      join(manifestsDir, "mlx-host.yaml"),
      [
        "apiVersion: llamactl/v1",
        "kind: ModelHost",
        "metadata:",
        "  name: mlx-host",
        "spec:",
        "  enabled: true",
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
        "",
      ].join("\n"),
    );
    const prev = process.env.LLAMACTL_WORKLOADS_DIR;
    process.env.LLAMACTL_WORKLOADS_DIR = manifestsDir;
    try {
      const name = resolveWorkloadName(undefined, resolved, undefined, {
        isLocalDispatch: () => false,
        resolveEffectiveNodeName: () => "gpu1",
        // listWorkloads intentionally NOT injected — use the real lister.
      });
      expect(name).toBe("mlx-host");
    } finally {
      if (prev === undefined) delete process.env.LLAMACTL_WORKLOADS_DIR;
      else process.env.LLAMACTL_WORKLOADS_DIR = prev;
    }
  });
});
