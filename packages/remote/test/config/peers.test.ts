import * as kubeconfigActual from "@llamactl/core/config/kubeconfig";
import { saveConfig, upsertCluster, upsertNode } from "@llamactl/core/config/kubeconfig";
import { listPeers } from "@llamactl/core/config/peers";
import { freshConfig, LOCAL_NODE_NAME } from "@llamactl/core/config/schema";
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

// Snapshot the real exports at load time. mock.module retroactively
// patches live bindings, so once the throwing mock below registers, the
// namespace object itself reflects the mock — a plain-object copy taken
// now keeps the real functions reachable for restoration.
const kubeconfigReal = { ...kubeconfigActual };

// The throwing kubeconfig mock below leaks across test FILES when the
// whole suite runs in one bun process (mock.module is process-global);
// re-register the real module so later files see real behavior.
afterAll(() => {
  void mock.module("@llamactl/core/config/kubeconfig", () => kubeconfigReal);
});

let tmp: string;
let prevConfigEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-peers-"));
  prevConfigEnv = process.env["LLAMACTL_CONFIG"];
  process.env["LLAMACTL_CONFIG"] = join(tmp, "config");
});

afterEach(() => {
  if (prevConfigEnv === undefined) {
    delete process.env["LLAMACTL_CONFIG"];
  } else {
    process.env["LLAMACTL_CONFIG"] = prevConfigEnv;
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
  saveConfig(cfg, process.env["LLAMACTL_CONFIG"]);
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
  saveConfig(cfg, process.env["LLAMACTL_CONFIG"]);
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
  saveConfig(cfg, process.env["LLAMACTL_CONFIG"]);
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
  saveConfig(cfg, process.env["LLAMACTL_CONFIG"]);
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
  saveConfig(cfg, process.env["LLAMACTL_CONFIG"]);
  expect(
    listPeers({ currentNodeName: "my-self" })
      .map((peer) => peer.id)
      .sort(),
  ).toEqual(["remote-node"]);
});
