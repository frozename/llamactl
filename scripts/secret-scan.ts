#!/usr/bin/env bun
// Pre-commit + CI secret scanner. Generic secret shapes plus llamactl's own:
// ll_agt_-prefixed agent bearers (see packages/remote/src/server/auth.ts) and
// base64 bootstrap blobs carrying a token field (core's encodeBootstrap).

import { isAbsolute, join, resolve } from "node:path";

import { existsSync, readFileSync } from "./safe-fs.js";

export interface SecretFinding {
  file: string;
  line: number;
  preview: string;
  rule: string;
}

export interface SecretRule {
  id: string;
  pattern: RegExp;
}

export const RULES: SecretRule[] = [
  { id: "llamactl-agent-token", pattern: /\bll_agt_[A-Za-z0-9_-]{20,}/g },
  { id: "private-key", pattern: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g },
  { id: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "github-token", pattern: /\b(?:gh[oprsu]_[A-Za-z0-9]{36,}|github_pat_\w{22,})/g },
  { id: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: "anthropic-api-key", pattern: /\bsk-ant-[\w-]{20,}/g },
];

const MAX_SCAN_BYTES = 5_000_000;

// Base64 / base64url runs long enough to plausibly be an encodeBootstrap blob.
// Node's base64url decoder also accepts the standard alphabet, so "+" and "/"
// belong in the candidate class.
const BLOB_CANDIDATE = /[A-Za-z0-9+/_-]{40,}={0,2}/g;

function toFinding(
  file: string,
  rule: string,
  text: string,
  match: string,
  index: number,
): SecretFinding {
  return {
    file,
    line: text.slice(0, index).split("\n").length,
    preview: `${match.slice(0, 8)}…`,
    rule,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function carriesToken(candidate: string): boolean {
  const decoded = Buffer.from(candidate, "base64url").toString("utf8");
  if (!decoded.trimStart().startsWith("{")) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) {
    return false;
  }
  const token = parsed["token"];
  return typeof token === "string" && token.length > 0;
}

export function scanText(text: string, file: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      findings.push(toFinding(file, rule.id, text, match[0], match.index));
    }
  }
  for (const match of text.matchAll(BLOB_CANDIDATE)) {
    if (carriesToken(match[0])) {
      findings.push(toFinding(file, "llamactl-bootstrap-blob", text, match[0], match.index));
    }
  }
  return findings;
}

export function scanFiles(
  paths: string[],
  root: string,
  read: (path: string) => Buffer | null,
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const path of paths) {
    const content = read(isAbsolute(path) ? path : join(root, path));
    if (content === null || content.byteLength > MAX_SCAN_BYTES || content.includes(0)) {
      continue;
    }
    findings.push(...scanText(content.toString("utf8"), path));
  }
  return findings;
}

function gitRun(args: string[], cwd: string): { code: number; stdout: Buffer } {
  const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, stdout: proc.stdout };
}

function nulList(proc: { code: number; stdout: Buffer }, what: string): string[] {
  if (proc.code !== 0) {
    console.error(`secret-scan: git ${what} failed`);
    process.exit(1);
  }
  return proc.stdout
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry !== "");
}

function repoRoot(): string | null {
  const proc = gitRun(["rev-parse", "--show-toplevel"], process.cwd());
  if (proc.code !== 0) {
    return null;
  }
  return proc.stdout.toString("utf8").trim();
}

function readFromDisk(path: string): Buffer | null {
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path);
}

function indexReader(root: string, relPaths: string[]): (path: string) => Buffer | null {
  const byAbs = new Map(relPaths.map((rel) => [join(root, rel), rel]));
  return (path) => {
    const rel = byAbs.get(path);
    if (rel === undefined) {
      return null;
    }
    const proc = gitRun(["show", `:${rel}`], root);
    return proc.code === 0 ? proc.stdout : null;
  };
}

function countedRead(
  read: (path: string) => Buffer | null,
  counter: { scanned: number },
): (path: string) => Buffer | null {
  return (path) => {
    const content = read(path);
    if (content !== null) {
      counter.scanned += 1;
    }
    return content;
  };
}

function usage(): void {
  console.error("usage: secret-scan.ts [--staged] [file ...]");
}

function collect(argv: string[]): { staged: boolean; files: string[] } {
  const files: string[] = [];
  let staged = false;
  for (const arg of argv) {
    if (arg === "--staged") {
      staged = true;
    } else if (arg.startsWith("-")) {
      usage();
      process.exit(2);
    } else {
      files.push(resolve(process.cwd(), arg));
    }
  }
  return { files, staged };
}

function main(): void {
  const { files, staged } = collect(process.argv.slice(2));
  const root = repoRoot();
  if (root === null) {
    console.error("secret-scan: not inside a git repository");
    process.exit(2);
  }

  const counter = { scanned: 0 };
  let paths: string[];
  let read: (path: string) => Buffer | null;
  let scanRoot: string;
  if (files.length > 0) {
    scanRoot = process.cwd();
    paths = files;
    read = countedRead(readFromDisk, counter);
  } else if (staged) {
    paths = nulList(
      gitRun(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"], root),
      "diff --cached",
    );
    scanRoot = root;
    read = countedRead(indexReader(root, paths), counter);
  } else {
    paths = nulList(gitRun(["ls-files", "-z"], root), "ls-files");
    scanRoot = root;
    read = countedRead(readFromDisk, counter);
  }

  const findings = scanFiles(paths, scanRoot, read);
  for (const finding of findings) {
    console.error(`${finding.file}:${String(finding.line)} ${finding.rule} ${finding.preview}`);
  }
  if (findings.length > 0) {
    console.error(`secret-scan: ${String(findings.length)} finding(s)`);
    process.exit(1);
  }
  console.error(`secret-scan: clean (${String(counter.scanned)} file(s) scanned)`);
  process.exit(0);
}

if (import.meta.main) {
  main();
}
