import type { ExecFn, ExecResult } from "./deps.js";
import type { HistoryRef } from "./history.js";

export type GitFn = (args: readonly string[]) => Promise<ExecResult>;

export interface GitCommit {
  sha: string;
  subject: string;
}

/** Where `switch` leaves the checkout. */
export type BranchMode = { kind: "branch"; name: string } | { kind: "detach" } | { kind: "main" };

export const DEPLOY_BRANCH = "main";
export const DEPLOY_UPSTREAM = "origin/main";

export class UpdateError extends Error {}

export function makeGit(exec: ExecFn, repo: string): GitFn {
  return async (args) => await exec(["git", "-C", repo, ...args]);
}

async function gitOut(git: GitFn, args: readonly string[]): Promise<string> {
  const r = await git(args);
  if (r.code !== 0) {
    throw new UpdateError(
      `git ${args.join(" ")} failed: ${r.stderr.trim() || `exit ${String(r.code)}`}`,
    );
  }
  return r.stdout.trim();
}

export interface CheckoutState {
  branch: string | null;
  sha: string;
  /** `git status --porcelain` lines for tracked changes (untracked files are ignored). */
  dirty: string[];
}

export async function readCheckout(git: GitFn): Promise<CheckoutState> {
  const sha = await gitOut(git, ["rev-parse", "HEAD"]);
  const sym = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const status = await git(["status", "--porcelain", "--untracked-files=no"]);
  if (status.code !== 0) throw new UpdateError(`git status failed: ${status.stderr.trim()}`);
  return {
    sha,
    branch: sym.code === 0 && sym.stdout.trim() !== "" ? sym.stdout.trim() : null,
    dirty: status.stdout.split("\n").filter((l) => l.trim() !== ""),
  };
}

/**
 * Fetch args that refresh the remote-tracking ref behind `ref`. The refspec is
 * explicit so a single-branch or shallow clone (whose configured refspec only
 * covers its own branch) still updates `origin/main`.
 */
export function fetchArgs(ref: string): string[] {
  const branch = ref.startsWith("origin/") ? ref.slice("origin/".length) : DEPLOY_BRANCH;
  return ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`];
}

export async function resolveCommit(git: GitFn, ref: string): Promise<string | null> {
  const r = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && sha !== "" ? sha : null;
}

export async function isAncestor(
  git: GitFn,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  return (await git(["merge-base", "--is-ancestor", ancestor, descendant])).code === 0;
}

export async function commitsBetween(
  git: GitFn,
  from: string,
  to: string,
  limit: number,
): Promise<{ count: number; commits: GitCommit[] }> {
  const count = Number.parseInt(await gitOut(git, ["rev-list", "--count", `${from}..${to}`]), 10);
  const log = await gitOut(git, [
    "log",
    "--no-decorate",
    `-n${String(limit)}`,
    "--format=%H%x09%s",
    `${from}..${to}`,
  ]);
  const commits = log === "" ? [] : log.split("\n").map(parseLogLine);
  return { count: Number.isFinite(count) ? count : commits.length, commits };
}

function parseLogLine(line: string): GitCommit {
  const tab = line.indexOf("\t");
  return tab < 0
    ? { sha: line, subject: "" }
    : { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
}

export async function changedFiles(git: GitFn, from: string, to: string): Promise<string[]> {
  const out = await gitOut(git, ["diff", "--name-only", from, to]);
  return out === "" ? [] : out.split("\n");
}

/** A lockfile or any workspace package.json changed: `bun install` must run. */
export function depsChanged(files: readonly string[]): boolean {
  return files.some(
    (f) => f === "bun.lock" || f === "package.json" || /^packages\/[^/]+\/package\.json$/.test(f),
  );
}

/** `owner/repo` for a GitHub remote URL (https or ssh), else null. */
export function parseGithubRepo(url: string): string | null {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match?.[1] !== undefined && match[2] !== undefined ? `${match[1]}/${match[2]}` : null;
}

export async function originGithubRepo(git: GitFn): Promise<string | null> {
  const r = await git(["remote", "get-url", "origin"]);
  return r.code === 0 ? parseGithubRepo(r.stdout) : null;
}

/**
 * How to land on a recorded ref: `main` is always reset to the sha (it is the
 * deploy pointer and the update moved it); another branch is restored only if
 * it still points at the sha, otherwise the checkout is detached at the sha.
 */
export async function restoreMode(git: GitFn, ref: HistoryRef): Promise<BranchMode> {
  if (ref.branch === null) return { kind: "detach" };
  if (ref.branch === DEPLOY_BRANCH) return { kind: "main" };
  const tip = await resolveCommit(git, `refs/heads/${ref.branch}`);
  return tip === ref.sha ? { kind: "branch", name: ref.branch } : { kind: "detach" };
}

export function describeMode(mode: BranchMode): string {
  switch (mode.kind) {
    case "main":
      return `branch ${DEPLOY_BRANCH} (tracking ${DEPLOY_UPSTREAM})`;
    case "branch":
      return `branch ${mode.name}`;
    case "detach":
      return "a detached HEAD";
  }
}

/** Move the checkout to `sha` as `mode` says. Returns an error message, or null. */
export async function switchTo(git: GitFn, sha: string, mode: BranchMode): Promise<string | null> {
  const run = async (args: readonly string[]): Promise<string | null> => {
    const r = await git(args);
    return r.code === 0
      ? null
      : `git ${args.join(" ")}: ${r.stderr.trim() || `exit ${String(r.code)}`}`;
  };
  switch (mode.kind) {
    case "main": {
      const err = await run(["switch", "--quiet", "-C", DEPLOY_BRANCH, sha]);
      if (err !== null) return err;
      // Best-effort: a missing origin/main only loses `git status` ahead/behind.
      await git(["branch", "--quiet", `--set-upstream-to=${DEPLOY_UPSTREAM}`, DEPLOY_BRANCH]);
      return null;
    }
    case "branch": {
      const err = await run(["switch", "--quiet", mode.name]);
      if (err === null && (await resolveCommit(git, "HEAD")) === sha) return null;
      return await run(["switch", "--quiet", "--detach", sha]);
    }
    case "detach":
      return await run(["switch", "--quiet", "--detach", sha]);
  }
}
