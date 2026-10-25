import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "./safe-fs.js";
import { scanText } from "./secret-scan.ts";

const SCRIPT = join(import.meta.dir, "secret-scan.ts");
const REPO_ROOT = join(import.meta.dir, "..");

// Built at runtime so no committed file carries a literal the scanner flags.
const TOKEN = "ll_agt_" + "Ab3_".repeat(8);

function runScan(args: string[], cwd: string): { code: number; output: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

function git(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  expect(proc.exitCode).toBe(0);
}

function bootstrapBlob(encoding: "base64" | "base64url"): string {
  return Buffer.from(
    JSON.stringify({
      url: "https://10.0.0.2:7843",
      fingerprint: "sha256:" + "ab".repeat(32),
      token: "fixture-" + "token-value",
      certificate: "-----BEGIN " + "CERTIFICATE-----",
    }),
    "utf8",
  ).toString(encoding);
}

describe("secret-scan", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flags an ll_agt_ agent token in a note", () => {
    const findings = scanText(`session note\ntoken: ${TOKEN}\n`, "docs/notes/note.md");
    expect(findings.length).toBe(1);
    const finding = findings[0];
    expect(finding?.rule).toBe("llamactl-agent-token");
    expect(finding?.line).toBe(2);
    expect(finding?.preview).not.toContain(TOKEN);
  });

  test("flags a base64url bootstrap blob that carries a token", () => {
    for (const encoding of ["base64url", "base64"] as const) {
      const findings = scanText(`bootstrap ${bootstrapBlob(encoding)}\n`, "note.md");
      expect(findings.length).toBe(1);
      expect(findings[0]?.rule).toBe("llamactl-bootstrap-blob");
    }
  });

  test("ignores base64 that does not decode to an object with a token", () => {
    const noToken = Buffer.from(
      JSON.stringify({ url: "https://10.0.0.2:7843", fingerprint: "sha256:" + "ab".repeat(32) }),
      "utf8",
    ).toString("base64url");
    const arbitrary = Buffer.alloc(64, 171).toString("base64");
    expect(scanText(`payload ${noToken}\nother ${arbitrary}\n`, "note.md")).toEqual([]);
  });

  test("ignores the short ll_agt_ placeholders tests use", () => {
    const text = [
      "tok = " + "ll_agt_" + "test",
      "tok = " + "ll_agt_" + "abc",
      'startsWith("ll_agt_")',
    ].join("\n");
    expect(scanText(text, "note.md")).toEqual([]);
  });

  test("flags generic secret shapes", () => {
    const text = [
      "-----BEGIN " + "RSA PRIVATE KEY-----",
      "AKIA" + "Q".repeat(16),
      "ghp_" + "a".repeat(36),
    ].join("\n");
    const rules = scanText(text, "note.md").map((finding) => finding.rule);
    expect(rules).toEqual(["private-key", "aws-access-key-id", "github-token"]);
  });

  test("passes the cleaned session notes", () => {
    const notes = [
      "docs/notes/maestro-continuation-2026-06-08-pm-5.md",
      "docs/notes/archive/maestro-continuation-2026-05-17-am-2.md",
    ];
    for (const rel of notes) {
      const text = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect(scanText(text, rel)).toEqual([]);
    }
  });

  test("CLI exits 1 on a finding without printing the secret, and 0 on a clean file", () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-scan-"));
    dirs.push(dir);
    const dirty = join(dir, "dirty.md");
    const clean = join(dir, "clean.md");
    writeFileSync(dirty, `# note\nbearer ${TOKEN}\n`);
    writeFileSync(clean, "# note\nnothing to see\n");

    const dirtyRun = runScan([dirty], REPO_ROOT);
    expect(dirtyRun.code).toBe(1);
    expect(dirtyRun.output).toContain("llamactl-agent-token");
    expect(dirtyRun.output).not.toContain(TOKEN);

    const cleanRun = runScan([clean], REPO_ROOT);
    expect(cleanRun.code).toBe(0);
    expect(cleanRun.output).toContain("secret-scan: clean");
  });

  test("--staged reads the index, not the working tree", () => {
    const repo = mkdtempSync(join(tmpdir(), "secret-scan-"));
    dirs.push(repo);
    git(repo, ["init", "-q"]);
    const file = join(repo, "note.md");
    writeFileSync(file, `leaked ${TOKEN}\n`);
    git(repo, ["add", "note.md"]);
    writeFileSync(file, "clean now\n");

    const stale = runScan(["--staged"], repo);
    expect(stale.code).toBe(1);

    git(repo, ["add", "note.md"]);
    const refreshed = runScan(["--staged"], repo);
    expect(refreshed.code).toBe(0);
  });
});
