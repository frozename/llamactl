/**
 * CLI-call journal. One JSONL entry per `createResponse` call from
 * a `CliSubprocessAdapter`. Lives at
 * `$LLAMACTL_CLI_JOURNAL_DIR/<YYYY-MM-DD>.jsonl` — rotated per day,
 * aligned with how cost-guardian and UsageRecord sinks work today.
 *
 * What we DO record:
 *   - ts, agent, binding name/preset, subscription label, model
 *   - prompt/response BYTES (not content), latency_ms, ok/error
 *
 * What we NEVER record:
 *   - Prompt or response text. Bodies are for transient transport;
 *     leaking them into a persistent journal turns every
 *     `llamactl agent cli doctor` into a privacy incident.
 *
 * Cost-guardian consumes this journal in a later phase to surface
 * "calls per subscription per day" — the quota proxy for flat-fee
 * subscription backends where USD tracking is meaningless.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CliJournalEntry {
  ts: string;
  agent: string;
  binding_name: string;
  preset: string;
  subscription?: string;
  model?: string;
  prompt_bytes: number;
  response_bytes: number;
  latency_ms: number;
  ok: boolean;
  /** Short machine-readable code, e.g. 'timeout', 'non-zero-exit',
   *  'parse-error'. Never a raw stderr dump. */
  error_code?: string;
  /** The exit code from the subprocess — only populated when the
   *  CLI terminated (null while hung + killed by timeout). */
  exit_code?: number | null;
}

export function defaultCliJournalDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_CLI_JOURNAL_DIR?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'cli-journal');
}

export function cliJournalPathFor(
  ts: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = defaultCliJournalDir(env);
  const day = ts.toISOString().slice(0, 10);
  return join(dir, `${day}.jsonl`);
}

/**
 * Append a single entry. Non-throwing by design — a journal write
 * failure must never kill the inflight response path. The adapter
 * awaits this so tests can observe write ordering, but any IO
 * failure is swallowed + logged to stderr so the run continues.
 */
export async function appendCliJournal(
  entry: CliJournalEntry,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const path = cliJournalPathFor(new Date(entry.ts), env);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    process.stderr.write(
      `cli-journal: append failed (${(err as Error).message}) — continuing\n`,
    );
  }
}
