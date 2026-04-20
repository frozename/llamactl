import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Root directory for ops-chat state. Honours the same cascade
 * every other llamactl data path uses:
 *   1. `$DEV_STORAGE` (the resolver's top-level root; under a
 *      hermetic `LLAMACTL_TEST_PROFILE` audit this re-reroots to
 *      the profile tmp dir)
 *   2. `homedir()/.llamactl` (the production default)
 *
 * Mirrors the pattern in `packages/agents/src/healer/journal.ts` and
 * `packages/remote/src/workload/store.ts` so one resolver flip in
 * Electron main (Fix 1) lights up every module at once.
 */
function defaultOpsChatDir(env: NodeJS.ProcessEnv = process.env): string {
  const devStorage = env.DEV_STORAGE?.trim();
  if (devStorage) return join(devStorage, 'ops-chat');
  return join(homedir(), '.llamactl', 'ops-chat');
}

/**
 * Default audit file path. Override via `LLAMACTL_OPS_CHAT_AUDIT`
 * (tests scope this to a tempdir so they never touch the real
 * ~/.llamactl).
 */
export function defaultOpsChatAuditPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.LLAMACTL_OPS_CHAT_AUDIT?.trim();
  if (override) return override;
  return join(defaultOpsChatDir(env), 'audit.jsonl');
}
