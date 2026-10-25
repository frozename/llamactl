import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AgentConfig,
  loadAgentConfig,
  saveAgentConfig,
} from "../../src/config/agent-config.js";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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

const plantedName = `.agent.yaml.tmp-${String(process.pid)}-planted`;

function stubRandomSuffix(...suffixes: string[]): Mock<() => number> {
  let call = 0;
  return spyOn(Math, "random").mockImplementation(() => {
    const suffix = suffixes[call % suffixes.length]!;
    call += 1;
    return { toString: () => `00${suffix}` } as unknown as number;
  });
}

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

  test("a regular file planted at the first temp path survives; the save retries", () => {
    const planted = join(tmp, plantedName);
    writeFileSync(planted, "planted content\n");
    const spy = stubRandomSuffix("planted", "second");
    try {
      saveAgentConfig(CONFIG, cfgPath);
    } finally {
      spy.mockRestore();
    }

    expect(existsSync(planted)).toBe(true);
    expect(readFileSync(planted, "utf8")).toBe("planted content\n");
    expect(loadAgentConfig(cfgPath)).toEqual(CONFIG);
    expect(readdirSync(tmp).sort()).toEqual([plantedName, "agent.yaml"]);
  });

  test("a symlink planted at the first temp path: link and target survive; the save retries", () => {
    const victim = join(tmp, "victim.txt");
    writeFileSync(victim, "victim content\n");
    const planted = join(tmp, plantedName);
    symlinkSync(victim, planted);
    const spy = stubRandomSuffix("planted", "second");
    try {
      saveAgentConfig(CONFIG, cfgPath);
    } finally {
      spy.mockRestore();
    }

    expect(readFileSync(victim, "utf8")).toBe("victim content\n");
    expect(lstatSync(planted).isSymbolicLink()).toBe(true);
    expect(readFileSync(planted, "utf8")).toBe("victim content\n");
    expect(loadAgentConfig(cfgPath)).toEqual(CONFIG);
    expect(readdirSync(tmp).sort()).toEqual([plantedName, "agent.yaml", "victim.txt"]);
  });

  test("every temp path collides: a clear error, agent.yaml and the planted entry untouched", () => {
    saveAgentConfig(CONFIG, cfgPath);
    const before = readFileSync(cfgPath, "utf8");
    const inoBefore = statSync(cfgPath).ino;
    const planted = join(tmp, plantedName);
    writeFileSync(planted, "planted content\n");
    const spy = stubRandomSuffix("planted");
    try {
      expect(() => {
        saveAgentConfig({ ...CONFIG, tokenHash: "c".repeat(64) }, cfgPath);
      }).toThrow(/collided/);
    } finally {
      spy.mockRestore();
    }

    expect(readFileSync(planted, "utf8")).toBe("planted content\n");
    expect(readFileSync(cfgPath, "utf8")).toBe(before);
    expect(statSync(cfgPath).ino).toBe(inoBefore);
    expect(readdirSync(tmp).sort()).toEqual([plantedName, "agent.yaml"]);
  });
});
