import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Source-staleness detection for long-running services that run from a git
 * checkout via launchd (KeepAlive=true). They load their code/schema at startup,
 * so after a `git pull` they keep executing stale code and silently mishandle new
 * schema fields (zod strips unknown keys) until restarted. The running source's
 * git HEAD is the signal: `startupRev !== currentRev` ⇒ the on-disk source changed
 * since this process started ⇒ stale, so the service exits at a safe boundary and
 * launchd reloads it with fresh code.
 *
 * Limitation: detects COMMITTED changes only — uncommitted local edits do not move
 * HEAD. Deploys here are git pulls, so HEAD is the correct signal.
 */

export interface StaleStreakState {
  streak: number;
}

export interface StaleStreakResult {
  state: StaleStreakState;
  shouldReload: boolean;
}

/**
 * Pure reducer over consecutive boundary observations — the entire safety surface,
 * testable without git or a process:
 *  - `currentRev` null/empty (git read failed, detached, or broken): streak
 *    UNCHANGED, never reload (fail-safe — a read error is not a rev change).
 *  - `currentRev === startupRev`: streak resets to 0, no reload.
 *  - `currentRev !== startupRev`: streak + 1; reload once the streak reaches
 *    `reloadStaleChecks` (debounce against a transient mid-`git pull` index state).
 */
export function stepStaleStreak(
  state: StaleStreakState,
  currentRev: string | null,
  startupRev: string,
  reloadStaleChecks: number,
): StaleStreakResult {
  if (currentRev === null || currentRev === "") {
    return { state, shouldReload: false };
  }
  if (currentRev === startupRev) {
    return { state: { streak: 0 }, shouldReload: false };
  }
  const streak = state.streak + 1;
  return { state: { streak }, shouldReload: streak >= reloadStaleChecks };
}

export interface FindRepoRootOptions {
  existsFn?: (path: string) => boolean;
}

/**
 * Walk up from `startDir` to the first directory containing a `.git` entry (a
 * directory for a normal checkout, a file for a linked worktree). Returns null
 * when no ancestor has one (not a git checkout).
 */
export function findRepoRoot(
  startDir: string = MODULE_DIR,
  opts: FindRepoRootOptions = {},
): string | null {
  const exists = opts.existsFn ?? existsSync;
  let dir = startDir;
  for (;;) {
    if (exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export type ExecFn = (command: string) => string;

export interface GetSourceRevisionOptions {
  exec?: ExecFn;
  repoRoot?: string | null;
  existsFn?: (path: string) => boolean;
}

/**
 * The git HEAD sha of the running source checkout, or null on ANY failure (no
 * repo root, git error, empty output). NEVER throws and NEVER returns a sentinel
 * string — null must be distinct from every real sha so that a read error is never
 * mistaken for a rev change.
 */
export function getSourceRevision(opts: GetSourceRevisionOptions = {}): string | null {
  const exec =
    opts.exec ??
    ((command: string): string =>
      execSync(command, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }));
  const root =
    opts.repoRoot !== undefined
      ? opts.repoRoot
      : findRepoRoot(MODULE_DIR, opts.existsFn ? { existsFn: opts.existsFn } : {});
  if (root === null) return null;
  try {
    const out = exec(`git -C ${JSON.stringify(root)} rev-parse HEAD`).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export interface CheckSourceStaleOptions {
  readSourceRevision?: () => string | null;
  reloadStaleChecks?: number;
}

export interface CheckSourceStaleResult {
  state: StaleStreakState;
  shouldReload: boolean;
  currentRev: string | null;
}

/**
 * Thin orchestrator: read the current revision via the injected reader and advance
 * the streak. Returns the new state, the reload decision, and the observed
 * `currentRev` (so callers can log/journal it).
 */
export function checkSourceStale(
  startupRev: string,
  state: StaleStreakState,
  opts: CheckSourceStaleOptions = {},
): CheckSourceStaleResult {
  const read = opts.readSourceRevision ?? ((): string | null => getSourceRevision());
  const currentRev = read();
  const { state: nextState, shouldReload } = stepStaleStreak(
    state,
    currentRev,
    startupRev,
    opts.reloadStaleChecks ?? 2,
  );
  return { state: nextState, shouldReload, currentRev };
}
