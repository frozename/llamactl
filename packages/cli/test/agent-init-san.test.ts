import { afterAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseInitFlags, resolveInitSans, runAgent } from "../src/commands/agent.js";
import { mkdtempSync, readFileSync, rmSync } from "../src/safe-fs.js";

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

function certSans(dir: string): string {
  return new X509Certificate(readFileSync(join(dir, "agent.crt"), "utf8")).subjectAltName ?? "";
}

describe("parseInitFlags --san", () => {
  test("repeated --san flags accumulate", () => {
    const parsed = parseInitFlags(["--san=192.168.68.139", "--san=z13.local"]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.sans).toEqual(["192.168.68.139", "z13.local"]);
  });

  test("comma lists and whitespace across repeated flags", () => {
    const parsed = parseInitFlags(["--san=a,b", "--san= c ,, "]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.sans).toEqual(["a", "b", "c"]);
  });
});

describe("resolveInitSans", () => {
  test("--host always comes first and is always covered", () => {
    expect(resolveInitSans({ host: "10.0.0.5", bindHost: "0.0.0.0", sans: ["z13.local"] })).toEqual(
      ["10.0.0.5", "z13.local"],
    );
  });

  test("dedupes", () => {
    expect(resolveInitSans({ host: "h", bindHost: "b", sans: ["h", "x", "x"] })).toEqual([
      "h",
      "x",
    ]);
  });

  test("default without --san is host + bind, deduped", () => {
    expect(resolveInitSans({ host: "127.0.0.1", bindHost: "127.0.0.1", sans: [] })).toEqual([
      "127.0.0.1",
    ]);
  });
});

describe("agent init san end to end", () => {
  test("repeated --san with --json covers host and both SANs (#208 repro)", async () => {
    const dir = freshDir("init-san-json-");
    capture();
    try {
      const code = await runAgent([
        "init",
        `--dir=${dir}`,
        "--host=192.168.68.139",
        "--bind=0.0.0.0",
        "--port=7843",
        "--name=probe",
        "--san=192.168.68.139",
        "--san=z13.local",
        "--json",
      ]);
      expect(code).toBe(0);
      const san = certSans(dir);
      expect(san).toContain("IP Address:192.168.68.139");
      expect(san).toContain("DNS:z13.local");
      expect(stderrBuf).toContain("sans   192.168.68.139,z13.local");
      const record = JSON.parse(stdoutBuf.trim().split("\n").pop()!) as Record<string, unknown>;
      expect(Object.keys(record).sort()).toEqual([
        "bindHost",
        "blob",
        "configPath",
        "fingerprint",
        "nodeName",
        "port",
      ]);
    } finally {
      restore();
    }
  });

  test("host is covered even when only an extra --san is given", async () => {
    const dir = freshDir("init-san-human-");
    capture();
    try {
      const code = await runAgent(["init", `--dir=${dir}`, "--host=10.0.0.5", "--san=z13.local"]);
      expect(code).toBe(0);
      const san = certSans(dir);
      expect(san).toContain("IP Address:10.0.0.5");
      expect(san).toContain("DNS:z13.local");
      expect(stdoutBuf).toContain("sans   10.0.0.5,z13.local");
    } finally {
      restore();
    }
  });
});
