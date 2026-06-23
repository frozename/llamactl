import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveConfig } from "../src/config/kubeconfig.js";
import { listPeers } from "../src/config/peers.js";
import { type Config, LOCAL_NODE_NAME } from "../src/config/schema.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

/**
 * Defect 3 — phantom 'local' self-peer. listPeers excludes a node by
 * currentNodeName and by LOCAL_NODE_ENDPOINT, but NOT by the reserved name
 * LOCAL_NODE_NAME ('local'). When a cluster carries a node literally named
 * 'local' whose endpoint is a real https URL (NOT the inproc loopback) and the
 * current node has a DIFFERENT name, the old filter lets 'local' through as a
 * remote peer — so the migration controller / openaiProxy treat it as a routable
 * destination. listPeers must never return the reserved 'local' node.
 */
describe("listPeers excludes the reserved 'local' node (Defect 3)", () => {
  let tmp = "";
  let cfgPath = "";
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "llamactl-peers-local-"));
    cfgPath = join(tmp, "config");
    process.env = { ...originalEnv, LLAMACTL_CONFIG: cfgPath };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it("drops a 'local'-named node with a non-loopback https endpoint while keeping a real peer", () => {
    const config: Config = {
      apiVersion: "llamactl/v1",
      kind: "Config",
      currentContext: "default",
      contexts: [{ name: "default", cluster: "home", user: "me", defaultNode: "m4pro" }],
      clusters: [
        {
          name: "home",
          nodes: [
            // Reserved name 'local' but a REAL https endpoint (not inproc://local),
            // so the endpoint filter does not catch it.
            { name: LOCAL_NODE_NAME, endpoint: "https://local.example.com:7843", kind: "agent" },
            // A legitimately-named peer that must survive.
            { name: "m2mini", endpoint: "https://m2mini.local:7843", kind: "agent" },
          ],
        },
      ],
      users: [{ name: "me", token: "tok" }],
    };
    saveConfig(config, cfgPath);

    // Current node is NEITHER 'local' NOR 'm2mini'.
    const peers = listPeers({ currentNodeName: "m4pro" });
    const ids = peers.map((peer) => peer.id);

    expect(ids).not.toContain(LOCAL_NODE_NAME);
    expect(ids).toContain("m2mini");
  });
});
