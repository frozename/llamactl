import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { loadConfig, mutateConfig, upsertNode } from "../../src/config/kubeconfig.js";
import { freshConfig, NodeWorkerRpcSchema } from "../../src/config/schema.js";
import { mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

/**
 * #190: a kubeconfig node's workerRpc block is opaque to loading and
 * validated strictly for its owner only, so a typo in one node's block
 * never stops kubeconfig loading, and a re-save keeps the typo on disk
 * where the operator can find it.
 */

const TYPO_BLOCK = { serviceCredentialRef: "env:X", relayCredentialsRef: "env:Y" };
const VALID_BLOCK = { serviceCredentialRef: "env:X", relayCredentialRef: "env:Y" };

let tmp = "";
let cfgPath = "";

function writeWorkerNode(workerRpc: unknown): void {
  const cfg = upsertNode(freshConfig(), "home", {
    name: "w",
    endpoint: "https://w:7843",
    workerRpc,
  });
  writeFileSync(cfgPath, stringifyYaml(cfg));
}

function loadedBlock(): unknown {
  return loadConfig(cfgPath)
    .clusters.find((cluster) => cluster.name === "home")
    ?.nodes.find((node) => node.name === "w")?.workerRpc;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-kcfg-worker-rpc-"));
  cfgPath = join(tmp, "config");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("kubeconfig workerRpc block", () => {
  test("a misspelled key loads, and the block comes back as written", () => {
    writeWorkerNode(TYPO_BLOCK);
    expect(loadedBlock()).toEqual(TYPO_BLOCK);
  });

  test("a re-save keeps the misspelled key", () => {
    writeWorkerNode(TYPO_BLOCK);
    mutateConfig(cfgPath, (cfg) =>
      upsertNode(cfg, "home", { name: "other", endpoint: "https://other:7843" }),
    );
    expect(loadedBlock()).toEqual(TYPO_BLOCK);
  });

  test("the owner's reader refuses a misspelled key, naming it", () => {
    writeWorkerNode(TYPO_BLOCK);
    const parsed = NodeWorkerRpcSchema.safeParse(loadedBlock());
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message).join("\n")).toContain(
      "relayCredentialsRef",
    );
  });

  test("the owner's reader returns both known keys unchanged", () => {
    writeWorkerNode(VALID_BLOCK);
    expect(NodeWorkerRpcSchema.parse(loadedBlock())).toEqual(VALID_BLOCK);
  });
});
