import { defaultConfigPath } from "@llamactl/core/config/kubeconfig";
import { workloadStore } from "@llamactl/remote";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SANDBOX_PREFIX, sandboxOperatorStorage } from "./storage-sandbox.js";

/**
 * The bun test preload for this package reroots operator state (DEV_STORAGE)
 * into a temporary directory so no test can write manifests, config or
 * journals into the operator's live $DEV_STORAGE. These tests pin what the
 * preload guarantees plus the helper's env-rewriting contract.
 */
describe("storage sandbox preload", () => {
  test("DEV_STORAGE points at a fresh sandbox under the system temp dir", () => {
    const root = process.env["DEV_STORAGE"];
    expect(root).toBeDefined();
    expect(dirname(root!)).toBe(tmpdir());
    expect(root!.startsWith(join(tmpdir(), SANDBOX_PREFIX))).toBe(true);
  });

  test("default operator-state paths resolve inside the sandbox", () => {
    const prefix = `${tmpdir()}/`;
    expect(workloadStore.defaultWorkloadsDir().startsWith(prefix)).toBe(true);
    expect(defaultConfigPath().startsWith(prefix)).toBe(true);
  });

  test("the composites dir resolves inside the sandbox", () => {
    const root = process.env["DEV_STORAGE"];
    expect(root).toBeDefined();
    expect(process.env["LLAMACTL_COMPOSITES_DIR"]).toBe(join(root!, "composites"));
  });
});

describe("sandboxOperatorStorage", () => {
  test("reroots DEV_STORAGE and the composites dir and strips the state-dir overrides", () => {
    const env: NodeJS.ProcessEnv = {
      DEV_STORAGE: "/live",
      LLAMACTL_COMPOSITES_DIR: "/live/composites",
      LLAMACTL_CONFIG: "/live/config",
      LLAMACTL_HOME: "/live/repo",
      LLAMACTL_WORKLOADS_DIR: "/live/wl",
      PATH: "/bin",
    };
    sandboxOperatorStorage(env, "/sandbox");
    expect(env["DEV_STORAGE"]).toBe("/sandbox");
    expect(env["LLAMACTL_COMPOSITES_DIR"]).toBe(join("/sandbox", "composites"));
    expect(env["LLAMACTL_HOME"]).toBe("/live/repo");
    expect("LLAMACTL_CONFIG" in env).toBe(false);
    expect("LLAMACTL_WORKLOADS_DIR" in env).toBe(false);
    expect(env["PATH"]).toBe("/bin");
    expect(workloadStore.defaultWorkloadsDir(env)).toBe(join("/sandbox", "workloads"));
    expect(defaultConfigPath(env)).toBe(join("/sandbox", "config"));
  });
});
