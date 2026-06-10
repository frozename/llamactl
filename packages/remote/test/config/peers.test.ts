import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig, upsertCluster, upsertNode } from "../../src/config/kubeconfig.js";
import { LOCAL_NODE_NAME, freshConfig } from "../../src/config/schema.js";
import { listPeers } from "../../src/config/peers.js";

let tmp: string;
let prevConfigEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-peers-"));
  prevConfigEnv = process.env.LLAMACTL_CONFIG;
  process.env.LLAMACTL_CONFIG = join(tmp, "config");
});

afterEach(() => {
  if (prevConfigEnv === undefined) {
    delete process.env.LLAMACTL_CONFIG;
  } else {
    process.env.LLAMACTL_CONFIG = prevConfigEnv;
  }
  rmSync(tmp, { recursive: true, force: true });
});

test("listPeers returns [] when kubeconfig is missing", () => {
  const peers = listPeers();
  expect(peers).toEqual([]);
});

test("listPeers reads peers from current context", () => {
  let cfg = freshConfig();
  cfg = upsertNode(cfg, "home", { name: "remote-a", endpoint: "https://remote-a.example:7843" });
  cfg = upsertNode(cfg, "home", { name: "remote-b", endpoint: "https://remote-b.example:7843" });
  cfg = upsertCluster(cfg, {
    name: "other",
    nodes: [{ name: "other-peer", endpoint: "https://other.example:7843" }],
  });
  const baseContext = cfg.contexts[0];
  if (!baseContext) throw new Error("missing base context");
  cfg = {
    ...cfg,
    currentContext: "default",
    contexts: [
      { ...baseContext, name: baseContext.name, cluster: "other", user: baseContext.user },
    ],
  };
  saveConfig(cfg, process.env.LLAMACTL_CONFIG);
  const peers = listPeers();
  expect(peers).toHaveLength(1);
  expect(peers[0]).toMatchObject({ id: "other-peer", endpoint: "https://other.example:7843" });
});

test("listPeers excludes the local node and inproc peers", () => {
  let cfg = freshConfig();
  cfg = upsertNode(cfg, "home", {
    name: LOCAL_NODE_NAME,
    endpoint: "https://local-dup.example:7843",
  });
  cfg = upsertNode(cfg, "home", {
    name: "remote-node",
    endpoint: "https://remote-node.example:7843",
  });
  saveConfig(cfg, process.env.LLAMACTL_CONFIG);
  const peers = listPeers();
  expect(peers.some((peer) => peer.id === "remote-node")).toBe(true);
  expect(peers.some((peer) => peer.id === LOCAL_NODE_NAME)).toBe(false);
});

test("listPeers resolves tokenRef for configured user token", () => {
  const tokenPath = join(tmp, "peer-token");
  writeFileSync(tokenPath, "  token-from-file  \n", "utf8");
  let cfg = freshConfig();
  cfg.users[0] = { name: "me", tokenRef: tokenPath };
  cfg = upsertNode(cfg, "home", {
    name: "remote-node",
    endpoint: "https://remote-node.example:7843",
  });
  saveConfig(cfg, process.env.LLAMACTL_CONFIG);
  const peers = listPeers();
  expect(peers[0]!.token).toBe("token-from-file");
  expect(peers[0]!.tokenRef).toBe(tokenPath);
});

test("listPeers excludes non-https endpoints", () => {
  let cfg = freshConfig();
  cfg = upsertNode(cfg, "home", {
    name: "https-peer",
    endpoint: "https://peer-https.example:7843",
  });
  cfg = upsertNode(cfg, "home", { name: "http-peer", endpoint: "http://peer-http.example:7843" });
  cfg = upsertNode(cfg, "home", { name: "bad-peer", endpoint: "not-a-url" });
  saveConfig(cfg, process.env.LLAMACTL_CONFIG);
  const peers = listPeers();
  expect(peers.map((peer) => peer.id).sort()).toEqual(["https-peer"]);
});

test("listPeers honors explicit currentNodeName override", () => {
  let cfg = freshConfig();
  cfg = upsertNode(cfg, "home", { name: "my-self", endpoint: "https://my-self.example:7843" });
  cfg = upsertNode(cfg, "home", {
    name: "remote-node",
    endpoint: "https://remote-node.example:7843",
  });
  saveConfig(cfg, process.env.LLAMACTL_CONFIG);
  expect(
    listPeers({ currentNodeName: "my-self" })
      .map((peer) => peer.id)
      .sort(),
  ).toEqual(["remote-node"]);
});

test("readSchedulerLease reads holder from journal and does not call loadConfig fallback", async () => {
  const journalPath = join(tmp, "journal.jsonl");
  writeFileSync(
    journalPath,
    [
      JSON.stringify({
        kind: "fleet-lease-election",
        ts: "2026-05-26T00:00:00.000Z",
        node: "node-a",
        holder: "node-a",
      }),
      JSON.stringify({
        kind: "fleet-lease-election",
        ts: "2026-05-26T00:00:01.000Z",
        node: "node-b",
        holder: "node-b",
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const loadConfigSpy = mock(() => {
    throw new Error("loadConfig should not be called");
  });

  mock.module("../../src/config/kubeconfig.js", () => ({
    currentContext: () => {
      throw new Error("currentContext should not be called");
    },
    loadConfig: loadConfigSpy,
    resolveToken: () => undefined,
    saveConfig,
    upsertCluster,
    upsertNode,
  }));

  const peers = await import(`../../src/config/peers.js?f11-${Date.now()}`);
  const lease = peers.readSchedulerLease(journalPath);
  expect(lease).toEqual({ holder: "node-b" });
  expect(loadConfigSpy).not.toHaveBeenCalled();
});
