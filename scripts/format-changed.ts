// Changed-file format gate for the pre-push hook (frozename/llamactl#382):
// diff the branch against its upstream (or origin/main) merge-base, drop paths
// that no longer exist, and hand the survivors to `prettier --check`. Git runs
// through an injected GitRunner so tests never spawn a process.

import { existsSync } from "./safe-fs.js";

export type GitRunner = (args: string[]) => { code: number; stdout: string };

const UPSTREAM_CMD = "rev-parse --abbrev-ref --symbolic-full-name @{upstream}";
const DIFF_CMD_ARGS = ["diff", "--name-only", "-z", "--diff-filter=ACMR"];

export function resolveBaseRef(git: GitRunner): string | null {
  const upstreamResult = git(UPSTREAM_CMD.split(" "));
  if (upstreamResult.code !== 0) {
    const mainResult = git([...["merge-base", "origin/main", "HEAD"]]);
    if (mainResult.code !== 0) return null;
    return mainResult.stdout.trim();
  }
  const upstream = upstreamResult.stdout.trim();
  const mergeResult = git([...["merge-base", upstream, "HEAD"]]);
  if (mergeResult.code !== 0) return null;
  return mergeResult.stdout.trim();
}

export function changedFiles(git: GitRunner, base: string): string[] {
  const result = git([...DIFF_CMD_ARGS, base, "HEAD"]);
  if (result.code !== 0) {
    throw new Error(`git diff failed (exit ${String(result.code)})`);
  }
  const stdout = result.stdout;
  if (!stdout) return [];
  // NUL-separated, with trailing NUL(s)
  return stdout.split("\0").filter((f) => f.length > 0);
}

export function planFormatCheck(
  git: GitRunner,
  exists: (path: string) => boolean,
): { base: string | null; files: string[] } {
  const base = resolveBaseRef(git);
  if (base === null) return { base: null, files: [] };
  const all = changedFiles(git, base);
  return { base, files: all.filter(exists) };
}

export function prettierArgs(files: string[]): string[] {
  if (files.length === 0) return [];
  return ["--check", "--ignore-unknown", "--no-error-on-unmatched-pattern", "--", ...files];
}

// ─── CLI entry ──────────────────────────────────────────────

function runCli(): void {
  const git: GitRunner = (args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], {
      cwd: process.cwd(),
    });
    return { code: r.exitCode, stdout: r.stdout.toString() };
  };

  const plan = planFormatCheck(git, (path) => existsSync(path));

  if (plan.files.length === 0) {
    process.exit(0);
  }

  const args = prettierArgs(plan.files);
  const result = Bun.spawnSync(["bun", "x", "prettier", ...args], { cwd: process.cwd() });

  if (result.exitCode !== 0) {
    // prettier --check lists the offending files on stdout, warnings on stderr.
    process.stderr.write(result.stdout.toString());
    process.stderr.write(result.stderr.toString());
    process.stderr.write(`Run: bun x prettier --write ${plan.files.join(" ")}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.main) runCli();
