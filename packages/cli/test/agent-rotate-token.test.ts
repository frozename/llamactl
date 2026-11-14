import { agentConfig as agentConfigMod } from "@llamactl/remote";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { runAgent } from "../src/commands/agent.js";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../src/safe-fs.js";
import { isPlainRecord, parseJsonRecord, requireRecordField } from "./helpers.js";

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

interface BearerYamlEntry {
  name: string;
  tokenHash: string;
  createdAt: string;
  expiresAt?: string;
}

/** The bearerTokens block of an agent.yaml, parsed straight from disk. */
function bearerTokensYaml(yamlPath: string): BearerYamlEntry[] {
  const parsed: unknown = parseYaml(readFileSync(yamlPath, "utf8"));
  const block = isPlainRecord(parsed) ? parsed["bearerTokens"] : undefined;
  return Array.isArray(block) ? (block as BearerYamlEntry[]) : [];
}

describe("agent rotate-token --grace", () => {
  /** Init a fresh agent in dir, clear the buffers, return the primary tokenHash. */
  async function seed(dir: string): Promise<string> {
    const code = await runAgent(["init", `--dir=${dir}`, "--host=127.0.0.1", "--json"]);
    expect(code).toBe(0);
    stdoutBuf = "";
    stderrBuf = "";
    return agentConfigMod.loadAgentConfig(join(dir, "agent.yaml")).tokenHash;
  }

  test("--json records the old hash under a rotated-* name with a grace expiry", async () => {
    // Kills: recording the new hash instead of the old one, dropping the
    // append, a wrong grace arithmetic or unit, or leaving the --json
    // branch on the old 'no longer authenticates' warning.
    captureStdout();
    const d = mkdtempSync(join(tmpdir(), "rotate-grace-json-"));
    try {
      const h0 = await seed(d);
      const yamlPath = join(d, "agent.yaml");
      const before = Date.now();
      const code = await runAgent(["rotate-token", `--dir=${d}`, "--grace=2h", "--json"]);
      const after = Date.now();
      expect(code).toBe(0);
      expect(stderrBuf).not.toContain("unknown flag");

      expect(agentConfigMod.loadAgentConfig(yamlPath).tokenHash).not.toBe(h0);
      const entries = bearerTokensYaml(yamlPath);
      expect(entries).toHaveLength(1);
      const grace = entries[0];
      const graceName = grace?.name ?? "";
      expect(grace?.tokenHash).toBe(h0);
      expect(graceName).toMatch(/^rotated-\d+$/);
      const expiresAt = Date.parse(grace?.expiresAt ?? "");
      expect(Number.isFinite(expiresAt)).toBe(true);
      expect(expiresAt).toBeGreaterThanOrEqual(before + 7_200_000);
      expect(expiresAt).toBeLessThanOrEqual(after + 7_200_000);

      expect(stderrBuf).toContain("the previous token keeps authenticating until");
      expect(stderrBuf).toContain(graceName);
      expect(stderrBuf).not.toContain("the previous token no longer authenticates");
    } finally {
      restore();
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("human mode prints the grace note on stdout and keeps stderr clean", async () => {
    // Kills: swapping the note only on the --json branch, or moving
    // human-mode output to stderr.
    captureStdout();
    const d = mkdtempSync(join(tmpdir(), "rotate-grace-human-"));
    try {
      const h0 = await seed(d);
      const yamlPath = join(d, "agent.yaml");
      const code = await runAgent(["rotate-token", `--dir=${d}`, "--grace=2h"]);
      expect(code).toBe(0);
      expect(stdoutBuf.includes("the previous token keeps authenticating until")).toBe(true);
      expect(stdoutBuf.includes("the previous token no longer authenticates")).toBe(false);
      expect(stderrBuf).not.toContain("keeps authenticating");

      const entries = bearerTokensYaml(yamlPath);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.tokenHash).toBe(h0);
      expect(entries[0]?.name ?? "").toMatch(/^rotated-\d+$/);
    } finally {
      restore();
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("appends the grace entry beside existing named tokens", async () => {
    // Kills: replacing the bearerTokens block instead of appending to it.
    captureStdout();
    const d = mkdtempSync(join(tmpdir(), "rotate-grace-append-"));
    try {
      const h0 = await seed(d);
      const yamlPath = join(d, "agent.yaml");
      expect(await runAgent(["token", "add", "ci", `--dir=${d}`, "--json"])).toBe(0);
      stdoutBuf = "";
      stderrBuf = "";

      const ciBefore = bearerTokensYaml(yamlPath).find((e) => e.name === "ci");
      expect(ciBefore).toBeDefined();
      const code = await runAgent(["rotate-token", `--dir=${d}`, "--grace=30m", "--json"]);
      expect(code).toBe(0);

      const entries = bearerTokensYaml(yamlPath);
      expect(entries).toHaveLength(2);
      expect(entries.find((e) => e.name === "ci")).toEqual(ciBefore);
      const grace = entries.find((e) => e.name !== "ci");
      expect(grace?.name ?? "").toMatch(/^rotated-\d+$/);
      expect(grace?.tokenHash).toBe(h0);
    } finally {
      restore();
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("rejects invalid --grace durations and leaves agent.yaml byte-identical", async () => {
    // Kills: accepting a zero, empty, fractional, over-cap or overflowing
    // duration, or writing agent.yaml before validating the flag.
    captureStdout();
    const d = mkdtempSync(join(tmpdir(), "rotate-grace-bad-"));
    try {
      await seed(d);
      const yamlPath = join(d, "agent.yaml");
      const yamlBefore = readFileSync(yamlPath, "utf8");
      for (const value of ["bogus", "0", "", "1.5h", "366d", "99999999999999d"]) {
        stdoutBuf = "";
        stderrBuf = "";
        const code = await runAgent(["rotate-token", `--dir=${d}`, `--grace=${value}`, "--json"]);
        expect(code).toBe(1);
        expect(stderrBuf).toContain("agent rotate-token: --grace must be a positive duration");
      }
      expect(readFileSync(yamlPath, "utf8")).toBe(yamlBefore);
    } finally {
      restore();
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("--json record carries the grace entry and no extra keys", async () => {
    // Kills: omitting grace from the JSON record, or adding extra keys
    // such as a hash.
    captureStdout();
    const d = mkdtempSync(join(tmpdir(), "rotate-grace-record-"));
    try {
      await seed(d);
      const code = await runAgent(["rotate-token", `--dir=${d}`, "--grace=1d", "--json"]);
      expect(code).toBe(0);
      const record = parseJsonRecord(stdoutBuf.trim().split("\n").pop()!);
      expect(isPlainRecord(record["grace"])).toBe(true);
      const grace = requireRecordField(record, "grace");
      expect(String(grace["name"])).toMatch(/^rotated-\d+$/);
      expect(Number.isFinite(Date.parse(String(grace["expiresAt"])))).toBe(true);
      expect(Object.keys(record).sort()).toEqual(
        ["bindHost", "blob", "configPath", "fingerprint", "grace", "nodeName", "port"].sort(),
      );
    } finally {
      restore();
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("refuses to rotate when the existing bearerTokens block is invalid", async () => {
    // Kills: rotating the primary when the grace entry cannot be recorded
    // into a malformed bearerTokens block.
    captureStdout();
    const d = mkdtempSync(join(tmpdir(), "rotate-grace-malformed-"));
    try {
      await seed(d);
      const yamlPath = join(d, "agent.yaml");
      const cfg = agentConfigMod.loadAgentConfig(yamlPath);
      agentConfigMod.saveAgentConfig(
        {
          ...cfg,
          bearerTokens: [
            { name: "ci", tokenHash: "a".repeat(64), createdAt: "2026-01-01T00:00:00.000Z" },
            { name: "ci", tokenHash: "b".repeat(64), createdAt: "2026-01-01T00:00:00.000Z" },
          ],
        },
        yamlPath,
      );
      const yamlBefore = readFileSync(yamlPath, "utf8");

      const code = await runAgent(["rotate-token", `--dir=${d}`, "--grace=1h", "--json"]);
      expect(code).toBe(1);
      expect(stderrBuf).toContain("invalid bearerTokens block");
      expect(stderrBuf).toContain("Nothing was rotated");
      expect(readFileSync(yamlPath, "utf8")).toBe(yamlBefore);
    } finally {
      restore();
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("refuses to rotate when a named entry already holds the primary tokenHash", async () => {
    // Kills: skipping validation of the combined block, which would record
    // the previous primary hash a second time under the rotated-* name.
    captureStdout();
    const d = mkdtempSync(join(tmpdir(), "rotate-grace-dup-hash-"));
    try {
      const h0 = await seed(d);
      const yamlPath = join(d, "agent.yaml");
      const cfg = agentConfigMod.loadAgentConfig(yamlPath);
      agentConfigMod.saveAgentConfig(
        {
          ...cfg,
          bearerTokens: [{ name: "ci", tokenHash: h0, createdAt: "2026-01-01T00:00:00.000Z" }],
        },
        yamlPath,
      );
      const yamlBefore = readFileSync(yamlPath, "utf8");

      const code = await runAgent(["rotate-token", `--dir=${d}`, "--grace=1h", "--json"]);
      expect(code).toBe(1);
      expect(stderrBuf).toContain("invalid bearerTokens block");
      expect(stderrBuf).toContain("token hashes must be unique");
      expect(stderrBuf).toContain("Nothing was rotated");
      expect(readFileSync(yamlPath, "utf8")).toBe(yamlBefore);
    } finally {
      restore();
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("accepts --grace=365d, the cap itself", async () => {
    // Kills: an exclusive cap ('>=' instead of '>' against the maximum):
    // exactly 365d is allowed and records a year-long expiry.
    captureStdout();
    const d = mkdtempSync(join(tmpdir(), "rotate-grace-cap-"));
    try {
      const h0 = await seed(d);
      const yamlPath = join(d, "agent.yaml");
      const before = Date.now();
      const code = await runAgent(["rotate-token", `--dir=${d}`, "--grace=365d", "--json"]);
      const after = Date.now();
      expect(code).toBe(0);
      expect(stderrBuf).not.toContain("--grace must be a positive duration");

      const entries = bearerTokensYaml(yamlPath);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.tokenHash).toBe(h0);
      const expiresAt = Date.parse(entries[0]?.expiresAt ?? "");
      expect(expiresAt).toBeGreaterThanOrEqual(before + 365 * 86_400_000);
      expect(expiresAt).toBeLessThanOrEqual(after + 365 * 86_400_000);
    } finally {
      restore();
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("pin: without --grace the warning streams and the absent block are unchanged", async () => {
    // PIN (#218): passes at base. Kills: changing the non-grace output
    // stream, the warning text, or adding a block when no grace was asked for.
    captureStdout();
    const human = mkdtempSync(join(tmpdir(), "rotate-pin-human-"));
    const json = mkdtempSync(join(tmpdir(), "rotate-pin-json-"));
    try {
      await seed(human);
      expect(await runAgent(["rotate-token", `--dir=${human}`])).toBe(0);
      expect(stdoutBuf.includes("warning: the previous token no longer authenticates")).toBe(true);
      expect(stderrBuf).not.toContain("no longer authenticates");

      await seed(json);
      expect(await runAgent(["rotate-token", `--dir=${json}`, "--json"])).toBe(0);
      expect(stderrBuf).toContain("warning: the previous token no longer authenticates");

      for (const yamlPath of [join(human, "agent.yaml"), join(json, "agent.yaml")]) {
        const raw = parseYaml(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
        expect("bearerTokens" in raw).toBe(false);
      }
    } finally {
      restore();
      rmSync(human, { recursive: true, force: true });
      rmSync(json, { recursive: true, force: true });
    }
  });
});
