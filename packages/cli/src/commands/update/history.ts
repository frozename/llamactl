// The update history: one line per event, appended, never rewritten.
//
//   <iso> from=<branch>@<sha> to=<sha>                  an --apply started
//   <iso> ok <short>                                    the procedure verified
//   <iso> rolled-back to <branch>@<short>               --apply failed and was undone
//   <iso> rollback from=<branch>@<sha> to=<branch>@<sha> a --rollback started
//
// A detached checkout is written as the bare sha. `--rollback` with no target
// goes to the `from=` of the last line that has one, so a second --rollback
// undoes the first. Same format as the bash llamactl-update it replaces, so an
// existing history file keeps working.
import { llamactlHome } from "@llamactl/core/config/env";
import { join } from "node:path";

export interface HistoryRef {
  /** Branch the checkout was on, or null when it was detached. */
  branch: string | null;
  sha: string;
}

const SHA_RE = /^[0-9a-f]{7,40}$/;
const FROM_RE = /(?:^|\s)from=(\S+)/;

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

/** The `from=` ref of the last history line that records one. */
export function lastFromRef(historyText: string): HistoryRef | null {
  const lines = historyText.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = FROM_RE.exec(lines[i] ?? "");
    if (match?.[1] !== undefined) return parseHistoryRef(match[1]);
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

export function rolledBackLine(iso: string, to: HistoryRef): string {
  return `${iso} rolled-back to ${formatHistoryRef({ branch: to.branch, sha: to.sha.slice(0, 7) })}\n`;
}
