import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Default audit file path. Override via `LLAMACTL_OPS_CHAT_AUDIT`
 * (tests scope this to a tempdir so they never touch the real
 * ~/.llamactl).
 */
export function defaultOpsChatAuditPath(): string {
  const override = process.env.LLAMACTL_OPS_CHAT_AUDIT;
  if (override && override.length > 0) return override;
  return join(homedir(), '.llamactl', 'ops-chat', 'audit.jsonl');
}
