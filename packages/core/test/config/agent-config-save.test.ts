import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AgentConfig,
  loadAgentConfig,
  saveAgentConfig,
} from "../../src/config/agent-config.js";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../../src/safe-fs.js";

/**
 * #222: agent.yaml holds a credential hash, so a save must never leave
 * the file readable under the umask mid-write or let a concurrent reader
 * see a half-written file: write a 0600 tmp in the same dir, rename it.
 */

const CONFIG: AgentConfig = {
  apiVersion: "llamactl/v1",
  kind: "AgentConfig",
  nodeName: "worker-1",
  bindHost: "127.0.0.1",
  port: 7843,
  certPath: "/etc/llamactl/agent.crt",
  keyPath: "/etc/llamactl/agent.key",
  tokenHash: "a".repeat(64),
  fingerprint: `sha256:${"b".repeat(64)}`,
};

let tmp = "";
let cfgPath = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-agent-save-"));
  cfgPath = join(tmp, "agent.yaml");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("saveAgentConfig", () => {
  test("over an existing 0644 file: new inode, mode 0600, no leftover tmp", () => {
    writeFileSync(cfgPath, "stale\n");
    chmodSync(cfgPath, 0o644);
    const inoBefore = statSync(cfgPath).ino;

    saveAgentConfig(CONFIG, cfgPath);

    const stat = statSync(cfgPath);
    expect(stat.ino).not.toBe(inoBefore);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(readdirSync(tmp).sort()).toEqual(["agent.yaml"]);
  });

  test("a fresh save creates the file at 0600 and round-trips", () => {
    saveAgentConfig(CONFIG, cfgPath);

    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    expect(loadAgentConfig(cfgPath)).toEqual(CONFIG);
  });

  test("a failed write leaves the target untouched and no tmp behind", () => {
    saveAgentConfig(CONFIG, cfgPath);
    const before = readFileSync(cfgPath);
    const inoBefore = statSync(cfgPath).ino;
    chmodSync(tmp, 0o500);
    try {
      expect(() => {
        saveAgentConfig({ ...CONFIG, tokenHash: "c".repeat(64) }, cfgPath);
      }).toThrow();
    } finally {
      chmodSync(tmp, 0o700);
    }

    expect(readFileSync(cfgPath)).toEqual(before);
    expect(statSync(cfgPath).ino).toBe(inoBefore);
    expect(readdirSync(tmp).sort()).toEqual(["agent.yaml"]);
  });
});
