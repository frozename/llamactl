// The update history: one line per event, appended, never rewritten.
//
//   <iso> from=<branch>@<sha> to=<sha>                   an --apply started
//   <iso> rollback from=<branch>@<sha> to=<branch>@<sha> a --rollback started
//   <iso> ok <short>                                     ... and verified
//   <iso> rolled-back to <branch>@<short>                ... --apply failed and was undone
//   <iso> failed <short> <why>                           ... failed (and, for --apply, so did the undo)
//
// A detached checkout is written as the bare sha. The bash llamactl-update this
// replaces wrote the same lines (minus `failed`), so pointing
// LLAMACTL_UPDATE_HISTORY at its file carries the history over.
import { llamactlHome } from "@llamactl/core/config/env";
import { join } from "node:path";

export interface HistoryRef {
  /** Branch the checkout was on, or null when it was detached. */
  branch: string | null;
  sha: string;
}

export interface HistoryEntry {
  kind: "apply" | "rollback";
  from: HistoryRef;
  /** The target; for an apply line only the sha is recorded. */
  to: HistoryRef;
  /** null: no outcome line followed (the run was killed). */
  outcome: "failed" | "ok" | "rolled-back" | null;
}

const SHA_RE = /^[0-9a-f]{7,40}$/;
const START_RE = /(?:^|\s)(rollback )?from=(\S+) to=(\S+)/;
const OUTCOME_RE = /^\S+ (ok|rolled-back|failed)(?:\s|$)/;

/**
 * The update history path: $LLAMACTL_UPDATE_HISTORY, else
 * `update-history.log` in the llamactl state home ($DEV_STORAGE or
 * ~/.llamactl, the same base as the kubeconfig and workloads dir).
 */
export function defaultUpdateHistoryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["LLAMACTL_UPDATE_HISTORY"]?.trim();
  if (override) return override;
  return join(llamactlHome(env), "update-history.log");
}

export function formatHistoryRef(ref: HistoryRef): string {
  return ref.branch === null ? ref.sha : `${ref.branch}@${ref.sha}`;
}

/** Parse `branch@sha` or a bare sha; `DETACHED@sha` and `<sha>@<sha>` are detached. */
export function parseHistoryRef(text: string): HistoryRef | null {
  const at = text.lastIndexOf("@");
  if (at < 0) return SHA_RE.test(text) ? { branch: null, sha: text } : null;
  const branch = text.slice(0, at);
  const sha = text.slice(at + 1);
  if (!SHA_RE.test(sha) || branch === "") return null;
  if (branch === "DETACHED" || branch === "HEAD" || branch === sha) return { branch: null, sha };
  return { branch, sha };
}

function parseStartLine(line: string): HistoryEntry | null {
  const start = START_RE.exec(line);
  if (start?.[2] === undefined || start[3] === undefined) return null;
  const from = parseHistoryRef(start[2]);
  const to = parseHistoryRef(start[3]);
  if (from === null || to === null) return null;
  return { kind: start[1] === undefined ? "apply" : "rollback", from, to, outcome: null };
}

/** Parse history lines into entries, each with the outcome line that followed it. */
export function parseHistory(historyText: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of historyText.split("\n")) {
    const entry = parseStartLine(line);
    if (entry !== null) {
      entries.push(entry);
      continue;
    }
    const outcome = OUTCOME_RE.exec(line)?.[1];
    const last = entries.at(-1);
    if (last?.outcome === null && outcome !== undefined) {
      last.outcome = outcome as HistoryEntry["outcome"];
    }
  }
  return entries;
}

/**
 * Where `--rollback` goes without a target, judged by the newest entry that
 * says where the checkout should be:
 *
 * - an apply that verified, or a rollback that verified: back to its `from`
 *   (so a second rollback undoes the first);
 * - an apply that failed and was undone: skipped, the checkout is back at its
 *   `from` already, so the entry before it decides;
 * - an apply whose undo failed too, or that never recorded an outcome: its
 *   `from`, where the checkout was before it;
 * - a rollback that failed or never recorded an outcome: its `to`, i.e. retry
 *   it rather than turning around.
 */
export function defaultRollbackTarget(historyText: string): HistoryRef | null {
  const entries = parseHistory(historyText);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e === undefined || (e.kind === "apply" && e.outcome === "rolled-back")) continue;
    if (e.kind === "rollback" && e.outcome !== "ok") return e.to;
    return e.from;
  }
  return null;
}

export function applyStartLine(iso: string, from: HistoryRef, toSha: string): string {
  return `${iso} from=${formatHistoryRef(from)} to=${toSha}\n`;
}

export function rollbackStartLine(iso: string, from: HistoryRef, to: HistoryRef): string {
  const target = to.branch === null ? `DETACHED@${to.sha}` : formatHistoryRef(to);
  return `${iso} rollback from=${formatHistoryRef(from)} to=${target}\n`;
}

export function okLine(iso: string, sha: string): string {
  return `${iso} ok ${sha.slice(0, 7)}\n`;
}

export function failedLine(iso: string, sha: string, why: string): string {
  return `${iso} failed ${sha.slice(0, 7)} ${why.replaceAll("\n", " ")}\n`;
}

export function rolledBackLine(iso: string, to: HistoryRef): string {
  return `${iso} rolled-back to ${formatHistoryRef({ branch: to.branch, sha: to.sha.slice(0, 7) })}\n`;
}
