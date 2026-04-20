import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Append-only JSONL journal for the reverse tunnel. One line per
 * operator-debug event (connect, disconnect, relay call, relay error,
 * unauthorized hello, replaced connection). Operators grep this file
 * to diagnose tunnel flaps + auth failures offline.
 *
 * Intentional payload omissions: relay entries carry method name +
 * duration + ok flag, but NEVER the tRPC `input` or `result` — those
 * can carry bearer tokens, PEM material, or other secrets, and this
 * journal is a plaintext file on disk.
 *
 * Env override: `$LLAMACTL_TUNNEL_JOURNAL`. Falls back to
 * `$DEV_STORAGE/tunnel/journal.jsonl`, then
 * `~/.llamactl/tunnel/journal.jsonl`.
 */

export interface TunnelJournalConnect {
  kind: 'tunnel-connect';
  ts: string;
  nodeName: string;
}

export interface TunnelJournalDisconnect {
  kind: 'tunnel-disconnect';
  ts: string;
  nodeName: string;
  /** Free-form human-readable close descriptor from the ws close event. */
  reason: string;
  /** Numeric ws close code when parseable from the reason string. */
  code?: number;
}

export interface TunnelJournalRelayCall {
  kind: 'tunnel-relay-call';
  ts: string;
  nodeName: string;
  method: string;
  durationMs: number;
  ok: boolean;
  // INTENTIONALLY OMITS the tRPC call's `input` and the response
  // body. Those may carry secrets; this is metadata-only.
}

export interface TunnelJournalRelayError {
  kind: 'tunnel-relay-error';
  ts: string;
  nodeName: string;
  method?: string;
  code: string;
  message: string;
}

export interface TunnelJournalUnauthorized {
  kind: 'tunnel-unauthorized';
  ts: string;
  /** May be absent if the client never sent a well-formed hello. */
  nodeName?: string;
  reason:
    | 'bad-bearer'
    | 'malformed-hello'
    | 'hello-required-first'
    | 'hello-timeout';
}

export interface TunnelJournalReplaced {
  kind: 'tunnel-replaced';
  ts: string;
  nodeName: string;
}

export type TunnelJournalEntry =
  | TunnelJournalConnect
  | TunnelJournalDisconnect
  | TunnelJournalRelayCall
  | TunnelJournalRelayError
  | TunnelJournalUnauthorized
  | TunnelJournalReplaced;

export function defaultTunnelJournalPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.LLAMACTL_TUNNEL_JOURNAL?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'tunnel', 'journal.jsonl');
}

// Module-scoped so we stderr-log exactly once per process when the
// journal path turns out to be unwritable. Tunnel handlers fire at
// connection-rate; spamming stderr once per failed append would bury
// the actual diagnostic output.
let warnedAboutJournalFailure = false;

export function appendTunnelJournal(
  entry: TunnelJournalEntry,
  path: string = defaultTunnelJournalPath(),
): void {
  // Tunnel handlers MUST NOT fail because the journal is unwritable.
  // Swallow all I/O errors; emit one stderr diagnostic per process to
  // surface the misconfiguration without looping.
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    if (!warnedAboutJournalFailure) {
      warnedAboutJournalFailure = true;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `tunnel-journal: ${path} not writable (${message}); entries dropped\n`,
      );
    }
  }
}
