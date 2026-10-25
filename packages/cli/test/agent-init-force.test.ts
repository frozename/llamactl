import { agentConfig } from "@llamactl/remote";
import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { backupAgentState, parseInitFlags, runAgent } from "../src/commands/agent.js";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../src/safe-fs.js";
import { parseJsonRecord } from "./helpers.js";

const dirs: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;
let stdoutBuf = "";
let stderrBuf = "";

function capture(): void {
  stdoutBuf = "";
  stderrBuf = "";
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): true => {
    stdoutBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): true => {
    stderrBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
}

function restore(): void {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
}

async function seedInit(dir: string): Promise<Record<string, unknown>> {
  const code = await runAgent([
    "init",
    `--dir=${dir}`,
    "--host=127.0.0.1",
    "--port=7843",
    "--json",
  ]);
  expect(code).toBe(0);
  return parseJsonRecord(stdoutBuf.trim());
}

function backupEntries(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("agent-backup-"));
}

describe("agent init --force (#209)", () => {
  test("refuses an existing agent.yaml without --force", async () => {
    const dir = freshDir("agent-init-force-refuse-");
    capture();
    let code = 0;
    try {
      await seedInit(dir);
    } finally {
      restore();
    }
    const seed = {
      yaml: readFileSync(join(dir, "agent.yaml")),
      crt: readFileSync(join(dir, "agent.crt")),
      key: readFileSync(join(dir, "agent.key")),
    };
    capture();
    try {
      code = await runAgent(["init", `--dir=${dir}`, "--host=127.0.0.1", "--port=7843"]);
      expect(code).toBe(1);
      expect(stderrBuf).toContain("already exists");
      expect(stderrBuf).toContain("--force");
    } finally {
      restore();
    }
    expect(readFileSync(join(dir, "agent.yaml"))).toEqual(seed.yaml);
    expect(readFileSync(join(dir, "agent.crt"))).toEqual(seed.crt);
    expect(readFileSync(join(dir, "agent.key"))).toEqual(seed.key);
    expect(backupEntries(dir)).toEqual([]);
  });

  test("--force moves agent.yaml, cert and key into one backup and re-inits", async () => {
    const dir = freshDir("agent-init-force-move-");
    let seedRecord: Record<string, unknown> = {};
    capture();
    try {
      seedRecord = await seedInit(dir);
    } finally {
      restore();
    }
    const seed = {
      yaml: readFileSync(join(dir, "agent.yaml")),
      crt: readFileSync(join(dir, "agent.crt")),
      key: readFileSync(join(dir, "agent.key")),
    };
    const seedTokenHash = agentConfig.loadAgentConfig(join(dir, "agent.yaml")).tokenHash;
    capture();
    try {
      const code = await runAgent([
        "init",
        `--dir=${dir}`,
        "--host=127.0.0.1",
        "--port=7843",
        "--force",
        "--json",
      ]);
      expect(code).toBe(0);

      const entries = backupEntries(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatch(/^agent-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/);
      const backupDir = join(dir, entries[0]!);
      expect(readdirSync(backupDir).sort()).toEqual(["agent.crt", "agent.key", "agent.yaml"]);
      expect(readFileSync(join(backupDir, "agent.yaml"))).toEqual(seed.yaml);
      expect(readFileSync(join(backupDir, "agent.crt"))).toEqual(seed.crt);
      expect(readFileSync(join(backupDir, "agent.key"))).toEqual(seed.key);

      const backupTokenHash = agentConfig.loadAgentConfig(join(backupDir, "agent.yaml")).tokenHash;
      expect(backupTokenHash).toBe(seedTokenHash);
      const newTokenHash = agentConfig.loadAgentConfig(join(dir, "agent.yaml")).tokenHash;
      expect(newTokenHash).not.toBe(seedTokenHash);

      const record = parseJsonRecord(stdoutBuf.trim());
      expect(record.fingerprint).not.toBe(seedRecord.fingerprint);
      expect(Object.keys(record).sort()).toEqual([
        "bindHost",
        "blob",
        "configPath",
        "fingerprint",
        "nodeName",
        "port",
      ]);
      expect(stderrBuf).toContain("backed up");
      expect(stderrBuf).toContain(backupDir);
    } finally {
      restore();
    }
  });

  test("backed-up key and config keep mode 0600", async () => {
    const dir = freshDir("agent-init-force-modes-");
    capture();
    try {
      await seedInit(dir);
      const code = await runAgent([
        "init",
        `--dir=${dir}`,
        "--host=127.0.0.1",
        "--port=7843",
        "--force",
        "--json",
      ]);
      expect(code).toBe(0);
      const backupDir = join(dir, backupEntries(dir)[0]!);
      for (const name of ["agent.key", "agent.yaml"]) {
        expect(statSync(join(backupDir, name)).mode & 0o777).toBe(0o600);
      }
    } finally {
      restore();
    }
  });

  test("--force on a fresh dir behaves like plain init", async () => {
    const dir = freshDir("agent-init-force-fresh-");
    capture();
    try {
      const code = await runAgent([
        "init",
        `--dir=${dir}`,
        "--host=127.0.0.1",
        "--port=7843",
        "--force",
        "--json",
      ]);
      expect(code).toBe(0);
      expect(statSync(join(dir, "agent.yaml")).isFile()).toBe(true);
      expect(backupEntries(dir)).toEqual([]);
    } finally {
      restore();
    }
  });

  test("two forced re-inits leave two distinct backups", async () => {
    const dir = freshDir("agent-init-force-twice-");
    capture();
    try {
      await seedInit(dir);
      expect(
        await runAgent(["init", `--dir=${dir}`, "--host=127.0.0.1", "--port=7843", "--force"]),
      ).toBe(0);
      expect(
        await runAgent(["init", `--dir=${dir}`, "--host=127.0.0.1", "--port=7843", "--force"]),
      ).toBe(0);
      const entries = backupEntries(dir);
      expect(entries).toHaveLength(2);
      expect(new Set(entries).size).toBe(2);
    } finally {
      restore();
    }
  });

  test("human --force output re-adds the node with --force", async () => {
    const dir = freshDir("agent-init-force-human-");
    capture();
    try {
      await seedInit(dir);
      const code = await runAgent([
        "init",
        `--dir=${dir}`,
        "--host=127.0.0.1",
        "--port=7843",
        "--force",
      ]);
      expect(code).toBe(0);
      expect(stdoutBuf).toMatch(/llamactl node add \S+ --bootstrap \S+ --force\n/);
    } finally {
      restore();
    }
  });

  test("plain human init does not append --force", async () => {
    const dir = freshDir("agent-init-force-plain-");
    capture();
    try {
      const code = await runAgent(["init", `--dir=${dir}`, "--host=127.0.0.1", "--port=7843"]);
      expect(code).toBe(0);
      expect(stdoutBuf).not.toMatch(/ --force\n/);
    } finally {
      restore();
    }
  });

  test("--force backs up an unparseable agent.yaml", async () => {
    const dir = freshDir("agent-init-force-unparse-");
    writeFileSync(join(dir, "agent.yaml"), "not: [valid yaml");
    capture();
    try {
      const code = await runAgent([
        "init",
        `--dir=${dir}`,
        "--host=127.0.0.1",
        "--port=7843",
        "--force",
        "--json",
      ]);
      expect(code).toBe(0);
      const backupDir = join(dir, backupEntries(dir)[0]!);
      expect(readFileSync(join(backupDir, "agent.yaml"), "utf8")).toBe("not: [valid yaml");
    } finally {
      restore();
    }
  });
});

describe("parseInitFlags --force", () => {
  test("defaults false, set true by the flag", () => {
    const withForce = parseInitFlags(["--force"]);
    if ("error" in withForce) throw new Error(withForce.error);
    expect(withForce.force).toBe(true);
    const without = parseInitFlags([]);
    if ("error" in without) throw new Error(without.error);
    expect(without.force).toBe(false);
  });
});

describe("backupAgentState", () => {
  test("names the dir from the given time", () => {
    const dir = freshDir("agent-init-force-state-");
    writeFileSync(join(dir, "agent.yaml"), "yaml-body");
    writeFileSync(join(dir, "agent.crt"), "crt-body");
    writeFileSync(join(dir, "agent.key"), "key-body");
    const { backupDir, moved } = backupAgentState(dir, new Date("2026-10-25T03:05:27.123Z"));
    expect(basename(backupDir).startsWith("agent-backup-2026-10-25T03-05-27-123Z-")).toBe(true);
    expect(moved).toEqual(["agent.yaml", "agent.crt", "agent.key"]);
    expect(existsSync(join(dir, "agent.yaml"))).toBe(false);
    expect(existsSync(join(dir, "agent.crt"))).toBe(false);
    expect(existsSync(join(dir, "agent.key"))).toBe(false);
    expect(readFileSync(join(backupDir, "agent.yaml"), "utf8")).toBe("yaml-body");
  });
});
