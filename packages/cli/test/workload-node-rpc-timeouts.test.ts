import { saveConfig, upsertCluster, upsertNode } from "@llamactl/core/config/kubeconfig";
import { type Config, freshConfig } from "@llamactl/core/config/schema";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetWorkloadTestSeams,
  __setWorkloadTestSeams,
  nodeQueryTimeoutMsFor,
  withNodeQueryDeadline,
} from "../src/commands/workload.js";
import { EMPTY_GLOBALS, setGlobals } from "../src/dispatcher.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

const DEFAULT_QUERY_MS = 10_000;

let tmp = "";
let cfgPath = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-workload-rpc-to-"));
  cfgPath = join(tmp, "kubeconfig.yaml");
});

afterEach(() => {
  __resetWorkloadTestSeams();
  setGlobals(EMPTY_GLOBALS);
  rmSync(tmp, { recursive: true, force: true });
});

function writeCfg(cfg: Config): void {
  saveConfig(cfg, cfgPath);
  setGlobals({ ...EMPTY_GLOBALS, configPath: cfgPath });
}

test("a node's rpcTimeouts.queryMs bounds its CLI queries (#221)", () => {
  let cfg = freshConfig();
  cfg = upsertNode(cfg, "home", {
    name: "gpu1",
    endpoint: "https://gpu1.lan:7843",
    rpcTimeouts: { queryMs: 250 },
  });
  cfg = upsertNode(cfg, "home", { name: "gpu2", endpoint: "https://gpu2.lan:7843" });
  writeCfg(cfg);

  expect(nodeQueryTimeoutMsFor("gpu1")).toBe(250);
  expect(nodeQueryTimeoutMsFor("gpu2")).toBe(DEFAULT_QUERY_MS);
  expect(nodeQueryTimeoutMsFor("ghost")).toBe(DEFAULT_QUERY_MS);
});

test("--context resolves the node's queryMs through the selected context (#221)", () => {
  let cfg = freshConfig();
  cfg = upsertNode(cfg, "home", {
    name: "gpu1",
    endpoint: "https://gpu1.lan:7843",
    rpcTimeouts: { queryMs: 250 },
  });
  cfg = upsertCluster(cfg, {
    name: "away",
    nodes: [{ name: "gpu1", endpoint: "https://gpu1.lab:7843", rpcTimeouts: { queryMs: 40 } }],
  });
  cfg = {
    ...cfg,
    contexts: [...cfg.contexts, { name: "alt", cluster: "away", user: "me", defaultNode: "gpu1" }],
  };
  writeCfg(cfg);

  expect(nodeQueryTimeoutMsFor("gpu1")).toBe(250);
  setGlobals({ ...EMPTY_GLOBALS, configPath: cfgPath, contextName: "alt" });
  expect(nodeQueryTimeoutMsFor("gpu1")).toBe(40);
});

test("an unreadable kubeconfig falls back to the CLI default (#221)", () => {
  setGlobals({ ...EMPTY_GLOBALS, configPath: join(tmp, "missing.yaml") });
  expect(nodeQueryTimeoutMsFor("gpu1")).toBe(DEFAULT_QUERY_MS);
});

test("withNodeQueryDeadline races a hung query against the node's queryMs (#221)", async () => {
  let cfg = freshConfig();
  cfg = upsertNode(cfg, "home", {
    name: "gpu1",
    endpoint: "https://gpu1.lan:7843",
    rpcTimeouts: { queryMs: 25 },
  });
  writeCfg(cfg);

  const hung = new Promise<never>(() => undefined);
  const outcome = await Promise.race([
    withNodeQueryDeadline("gpu1", () => hung).then(
      (): string => "settled",
      (err: unknown): string => (err instanceof Error ? err.message : String(err)),
    ),
    new Promise<string>((resolve) => {
      setTimeout(() => {
        resolve("stalled");
      }, 2000);
    }),
  ]);
  expect(outcome).toBe("node 'gpu1' did not answer within 25 ms");
});

test("the test seam still wins over kubeconfig resolution (#221)", () => {
  let cfg = freshConfig();
  cfg = upsertNode(cfg, "home", {
    name: "gpu1",
    endpoint: "https://gpu1.lan:7843",
    rpcTimeouts: { queryMs: 250 },
  });
  writeCfg(cfg);
  __setWorkloadTestSeams({ nodeQueryTimeoutMs: 1 });
  expect(nodeQueryTimeoutMsFor("gpu1")).toBe(1);
});
