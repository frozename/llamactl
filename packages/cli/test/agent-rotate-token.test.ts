import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgent } from "../src/commands/agent.js";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../src/safe-fs.js";
import { parseJsonRecord } from "./helpers.js";

let tmp = "";
const originalEnv = { ...process.env };

let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;
let stdoutBuf = "";
let stderrBuf = "";

function captureStdout(): void {
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

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rotate-token-"));
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

describe("agent rotate-token", () => {
  test("rotates tokenHash, preserves cert/key/fingerprint, emits a fresh bootstrap blob", async () => {
    captureStdout();
    let initRecord: { fingerprint: string; blob: string };
    let rotatedRecord: { fingerprint: string; blob: string };
    try {
      // 1. seed an agent via runInit so we have real cert + agent.yaml
      const code1 = await runAgent([
        "init",
        `--dir=${tmp}`,
        "--host=127.0.0.1",
        "--port=7843",
        "--json",
      ]);
      expect(code1).toBe(0);
      initRecord = JSON.parse(stdoutBuf.trim().split("\n").pop()!) as {
        fingerprint: string;
        blob: string;
      };
      stdoutBuf = "";

      // capture pre-rotation state
      const yamlBefore = readFileSync(join(tmp, "agent.yaml"), "utf8");
      const certStatBefore = statSync(join(tmp, "agent.crt"));
      const keyStatBefore = statSync(join(tmp, "agent.key"));

      // 2. rotate
      const code2 = await runAgent(["rotate-token", `--dir=${tmp}`, "--host=127.0.0.1", "--json"]);
      expect(code2).toBe(0);
      rotatedRecord = JSON.parse(stdoutBuf.trim().split("\n").pop()!) as {
        fingerprint: string;
        blob: string;
      };

      // 3. agent.yaml's tokenHash changed, but everything else stayed
      const yamlAfter = readFileSync(join(tmp, "agent.yaml"), "utf8");
      expect(yamlAfter).not.toBe(yamlBefore);
      const beforeHash = /tokenHash:\s*(\S+)/.exec(yamlBefore)?.[1];
      const afterHash = /tokenHash:\s*(\S+)/.exec(yamlAfter)?.[1];
      expect(beforeHash).toBeTruthy();
      expect(afterHash).toBeTruthy();
      expect(afterHash).not.toBe(beforeHash);

      // fingerprint preserved between init and rotate
      expect(rotatedRecord.fingerprint).toBe(initRecord.fingerprint);

      // cert + key files unchanged (mtime + content hash)
      const certStatAfter = statSync(join(tmp, "agent.crt"));
      const keyStatAfter = statSync(join(tmp, "agent.key"));
      expect(certStatAfter.mtimeMs).toBe(certStatBefore.mtimeMs);
      expect(keyStatAfter.mtimeMs).toBe(keyStatBefore.mtimeMs);

      // 4. blob decodes to a different token but the same fingerprint + cert
      const decode = (b: string): Record<string, unknown> =>
        parseJsonRecord(Buffer.from(b, "base64url").toString("utf8"));
      const initBlob = decode(initRecord.blob);
      const rotatedBlob = decode(rotatedRecord.blob);
      expect(rotatedBlob["token"]).not.toBe(initBlob["token"]);
      expect(rotatedBlob["fingerprint"]).toBe(initBlob["fingerprint"]);
      expect(rotatedBlob["certificate"]).toBe(initBlob["certificate"]);
    } finally {
      restore();
    }
  });

  test("errors with exit code 1 when agent.yaml is missing", async () => {
    captureStdout();
    try {
      const empty = mkdtempSync(join(tmpdir(), "rotate-token-empty-"));
      try {
        const code = await runAgent(["rotate-token", `--dir=${empty}`]);
        expect(code).toBe(1);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      restore();
    }
  });

  test("rejects unknown flags", async () => {
    captureStdout();
    try {
      const code = await runAgent(["rotate-token", "--unknown=1"]);
      expect(code).toBe(1);
    } finally {
      restore();
    }
  });

  test("--token-out writes the new token at mode 0600", async () => {
    const d = mkdtempSync(join(tmpdir(), "rotate-token-out-"));
    captureStdout();
    try {
      const code1 = await runAgent([
        "init",
        `--dir=${d}`,
        "--host=127.0.0.1",
        "--port=7843",
        "--json",
      ]);
      expect(code1).toBe(0);
      stdoutBuf = "";
      stderrBuf = "";

      const out = join(d, "tok");
      const code2 = await runAgent(["rotate-token", `--dir=${d}`, `--token-out=${out}`, "--json"]);
      expect(code2).toBe(0);

      const record = parseJsonRecord(stdoutBuf.trim().split("\n").pop()!);
      const blob = parseJsonRecord(
        Buffer.from(String(record["blob"]), "base64url").toString("utf8"),
      );
      expect(String(blob["token"])).toBe(readFileSync(out, "utf8").trim());
      expect(statSync(out).mode & 0o777).toBe(0o600);
    } finally {
      restore();
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("--token-out tightens an existing wider-mode file", async () => {
    const d = mkdtempSync(join(tmpdir(), "rotate-token-mode-"));
    captureStdout();
    try {
      const code1 = await runAgent([
        "init",
        `--dir=${d}`,
        "--host=127.0.0.1",
        "--port=7843",
        "--json",
      ]);
      expect(code1).toBe(0);
      stdoutBuf = "";
      stderrBuf = "";

      const out = join(d, "tok");
      writeFileSync(out, "old\n");
      chmodSync(out, 0o644);
      const code2 = await runAgent(["rotate-token", `--dir=${d}`, `--token-out=${out}`]);
      expect(code2).toBe(0);
      expect(statSync(out).mode & 0o777).toBe(0o600);
      expect(readFileSync(out, "utf8")).not.toBe("old\n");
    } finally {
      restore();
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("--token-out works in human mode and names the file", async () => {
    const d = mkdtempSync(join(tmpdir(), "rotate-token-human-"));
    captureStdout();
    try {
      const code1 = await runAgent([
        "init",
        `--dir=${d}`,
        "--host=127.0.0.1",
        "--port=7843",
        "--json",
      ]);
      expect(code1).toBe(0);
      stdoutBuf = "";
      stderrBuf = "";

      const out = join(d, "tok");
      const code2 = await runAgent(["rotate-token", `--dir=${d}`, `--token-out=${out}`]);
      expect(code2).toBe(0);
      expect(stdoutBuf).toContain(`token  ${out}`);
    } finally {
      restore();
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("human output warns that the old token is invalid", async () => {
    const d = mkdtempSync(join(tmpdir(), "rotate-token-warn-"));
    captureStdout();
    try {
      const code1 = await runAgent([
        "init",
        `--dir=${d}`,
        "--host=127.0.0.1",
        "--port=7843",
        "--json",
      ]);
      expect(code1).toBe(0);
      stdoutBuf = "";
      stderrBuf = "";

      const code2 = await runAgent(["rotate-token", `--dir=${d}`]);
      expect(code2).toBe(0);
      expect(stdoutBuf).toContain("previous token no longer authenticates");
    } finally {
      restore();
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("--json mode puts the warning on stderr, not stdout", async () => {
    const d = mkdtempSync(join(tmpdir(), "rotate-token-warn-json-"));
    captureStdout();
    try {
      const code1 = await runAgent([
        "init",
        `--dir=${d}`,
        "--host=127.0.0.1",
        "--port=7843",
        "--json",
      ]);
      expect(code1).toBe(0);
      stdoutBuf = "";
      stderrBuf = "";

      const code2 = await runAgent(["rotate-token", `--dir=${d}`, "--json"]);
      expect(code2).toBe(0);
      expect(stderrBuf).toContain("previous token no longer authenticates");
      const last = stdoutBuf.trim().split("\n").pop()!;
      parseJsonRecord(last);
      expect(last).not.toContain("previous token no longer authenticates");
    } finally {
      restore();
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("unwritable --token-out path leaves agent.yaml untouched", async () => {
    const d = mkdtempSync(join(tmpdir(), "rotate-token-failout-"));
    captureStdout();
    try {
      const code1 = await runAgent([
        "init",
        `--dir=${d}`,
        "--host=127.0.0.1",
        "--port=7843",
        "--json",
      ]);
      expect(code1).toBe(0);
      stdoutBuf = "";
      stderrBuf = "";

      const yamlPath = join(d, "agent.yaml");
      const yamlBefore = readFileSync(yamlPath, "utf8");
      const beforeHash = /tokenHash:\s*(\S+)/.exec(yamlBefore)?.[1];
      expect(beforeHash).toBeTruthy();

      const blocker = join(d, "blocker");
      writeFileSync(blocker, "not a directory\n");
      const out = join(blocker, "tok");

      const code2 = await runAgent(["rotate-token", `--dir=${d}`, `--token-out=${out}`]);
      expect(code2).toBe(1);
      expect(readFileSync(yamlPath, "utf8")).toBe(yamlBefore);
      expect(stderrBuf).toContain("failed to write token");
      expect(stderrBuf).toContain("Nothing was rotated");
    } finally {
      restore();
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("--token-out= with an empty value is rejected", async () => {
    const d = mkdtempSync(join(tmpdir(), "rotate-token-empty-out-"));
    captureStdout();
    try {
      const code1 = await runAgent([
        "init",
        `--dir=${d}`,
        "--host=127.0.0.1",
        "--port=7843",
        "--json",
      ]);
      expect(code1).toBe(0);
      stdoutBuf = "";
      stderrBuf = "";

      const code2 = await runAgent(["rotate-token", `--dir=${d}`, "--token-out="]);
      expect(code2).toBe(1);
      expect(stderrBuf).not.toContain("unknown flag");
    } finally {
      restore();
      rmSync(d, { recursive: true, force: true });
    }
  });
});
