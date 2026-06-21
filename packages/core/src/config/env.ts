import { homedir } from "node:os";
import { join } from "node:path";

export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

/**
 * Canonical base directory for llamactl operator state — kubeconfig,
 * workloads, composites, projects, journals, infra. A non-empty
 * $DEV_STORAGE wins; otherwise fall back to ~/.llamactl. One resolver,
 * one empty-string rule: a blank or whitespace $DEV_STORAGE is ignored
 * rather than used as a literal base (the bug behind the divergent
 * `?.trim() ??` spellings this replaces).
 *
 * Distinct from core's runtime/model-path resolution, which probes
 * ~/DevStorage — operator STATE must not relocate when $DEV_STORAGE is
 * unset, so the fallback here stays ~/.llamactl.
 */
export function llamactlHome(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(env["DEV_STORAGE"]) ?? join(homedir(), ".llamactl");
}
