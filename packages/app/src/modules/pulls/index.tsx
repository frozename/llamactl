import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';

type Mode = 'file' | 'candidate';
type Profile = 'mac-mini-16g' | 'balanced' | 'macbook-pro-48g';

interface LogLine {
  kind: 'stdout' | 'stderr' | 'start' | 'exit' | 'done' | 'error';
  text: string;
  at: number;
}

const PROFILES: readonly Profile[] = ['mac-mini-16g', 'balanced', 'macbook-pro-48g'];
const MAX_LOG_LINES = 400;

function truncate(lines: LogLine[]): LogLine[] {
  return lines.length > MAX_LOG_LINES ? lines.slice(lines.length - MAX_LOG_LINES) : lines;
}

export default function Pulls(): JSX.Element {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('file');
  const [repo, setRepo] = useState('');
  const [file, setFile] = useState('');
  const [profile, setProfile] = useState<Profile | ''>('');
  const [active, setActive] = useState<
    | { mode: 'file'; repo: string; file: string }
    | { mode: 'candidate'; repo: string; file?: string; profile?: Profile }
    | null
  >(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const scrollLogToEnd = () => {
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  };

  const appendLog = (line: LogLine) => {
    setLog((prev) => {
      const next = truncate([...prev, line]);
      return next;
    });
    scrollLogToEnd();
  };

  const handleData = (ev: unknown) => {
    // The router yields a tagged union — narrow defensively since the
    // client doesn't enforce `unknown`'s structure at runtime.
    const e = ev as { type: string } & Record<string, unknown>;
    const now = Date.now();
    switch (e.type) {
      case 'start':
        appendLog({
          kind: 'start',
          text: `$ ${String(e.command)} ${((e.args as string[]) ?? []).join(' ')}`,
          at: now,
        });
        break;
      case 'stdout':
        appendLog({ kind: 'stdout', text: String(e.line ?? ''), at: now });
        break;
      case 'stderr':
        appendLog({ kind: 'stderr', text: String(e.line ?? ''), at: now });
        break;
      case 'exit':
        appendLog({ kind: 'exit', text: `(exit ${e.code})`, at: now });
        break;
      case 'done':
      case 'done-candidate': {
        const result = e.result as { rel?: string; wasMissing?: boolean; mmproj?: string | null };
        const parts = [
          `rel=${result.rel ?? '?'}`,
          `wasMissing=${result.wasMissing ? 'yes' : 'no'}`,
        ];
        if (result.mmproj) parts.push(`mmproj=${result.mmproj}`);
        const text = parts.join(' ');
        appendLog({ kind: 'done', text, at: now });
        setSummary(text);
        setActive(null);
        void queryClient.invalidateQueries({
          queryKey: [['catalogList'], { type: 'query' }],
        });
        break;
      }
      default:
        appendLog({ kind: 'stdout', text: JSON.stringify(e), at: now });
    }
  };

  const handleError = (err: { message: string }) => {
    appendLog({ kind: 'error', text: err.message, at: Date.now() });
    setError(err.message);
    setActive(null);
  };

  trpc.pullFile.useSubscription(
    active?.mode === 'file'
      ? { repo: active.repo, file: active.file }
      : { repo: '', file: '' },
    {
      enabled: active?.mode === 'file',
      onData: handleData,
      onError: handleError,
    },
  );

  trpc.pullCandidate.useSubscription(
    active?.mode === 'candidate'
      ? { repo: active.repo, file: active.file, profile: active.profile }
      : { repo: '' },
    {
      enabled: active?.mode === 'candidate',
      onData: handleData,
      onError: handleError,
    },
  );

  const start = (e: React.FormEvent) => {
    e.preventDefault();
    const r = repo.trim();
    if (!r) {
      setError('Repo is required');
      return;
    }
    setLog([]);
    setSummary(null);
    setError(null);
    if (mode === 'file') {
      if (!file.trim()) {
        setError('File is required for pull-file');
        return;
      }
      setActive({ mode: 'file', repo: r, file: file.trim() });
    } else {
      setActive({
        mode: 'candidate',
        repo: r,
        file: file.trim() || undefined,
        profile: profile || undefined,
      });
    }
  };

  const busy = active !== null;
  const cancel = () => {
    // Tearing down the active subscription triggers the subscription
    // cleanup in the tRPC router which aborts the child process.
    setActive(null);
    setError('Cancelled by user');
  };

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-1 text-xs uppercase tracking-widest text-[color:var(--color-fg-muted)]">
        Pulls
      </div>
      <h1 className="mb-4 text-2xl font-semibold text-[color:var(--color-fg)]">
        Download a model
      </h1>

      <form
        onSubmit={start}
        className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
      >
        <div className="mb-3 flex gap-1 text-xs">
          {(['file', 'candidate'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              disabled={busy}
              className={
                mode === m
                  ? 'rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-[color:var(--color-fg)]'
                  : 'rounded border border-transparent px-3 py-1 text-[color:var(--color-fg-muted)] hover:bg-[var(--color-surface-2)]'
              }
            >
              {m === 'file' ? 'Pull file' : 'Pull candidate'}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-12 gap-3">
          <label className="col-span-5 text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-fg-muted)]">Repo</span>
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              disabled={busy}
              placeholder="unsloth/gemma-4-E4B-it-GGUF"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono"
            />
          </label>
          <label className="col-span-5 text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-fg-muted)]">
              {mode === 'file' ? 'File' : 'File (optional override)'}
            </span>
            <input
              value={file}
              onChange={(e) => setFile(e.target.value)}
              disabled={busy}
              placeholder={
                mode === 'file' ? 'gemma-4-E4B-it-Q8_0.gguf' : '(auto-pick via profile)'
              }
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono"
            />
          </label>
          {mode === 'candidate' && (
            <label className="col-span-2 text-sm">
              <span className="mb-1 block text-xs text-[color:var(--color-fg-muted)]">
                Profile
              </span>
              <select
                value={profile}
                onChange={(e) => setProfile(e.target.value as Profile | '')}
                disabled={busy}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono"
              >
                <option value="">(current)</option>
                {PROFILES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div
            className={
              mode === 'candidate' ? 'col-span-12 flex justify-end' : 'col-span-2 flex items-end'
            }
          >
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-[var(--color-brand)] px-3 py-1 text-sm font-medium text-[color:var(--color-surface-0)] hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Pulling…' : 'Pull'}
            </button>
            {busy && (
              <button
                type="button"
                onClick={cancel}
                className="ml-2 rounded border border-[var(--color-danger)] px-3 py-1 text-sm text-[color:var(--color-danger)] hover:bg-[var(--color-surface-2)]"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </form>

      {error && (
        <div className="mb-3 rounded-md border border-[var(--color-danger)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[color:var(--color-danger)]">
          {error}
        </div>
      )}
      {summary && (
        <div className="mb-3 rounded-md border border-[var(--color-accent)] bg-[var(--color-surface-1)] px-3 py-2 text-sm">
          <div className="text-[color:var(--color-accent)]">Pull complete</div>
          <div className="mono text-xs text-[color:var(--color-fg-muted)]">{summary}</div>
        </div>
      )}

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-0)]">
        <div className="flex items-center justify-between px-3 py-2 text-xs uppercase tracking-wide text-[color:var(--color-fg-muted)]">
          <span>Log</span>
          <span>
            {log.length} line{log.length === 1 ? '' : 's'}
          </span>
        </div>
        <div
          ref={logRef}
          className="max-h-[50vh] overflow-auto border-t border-[var(--color-border)] px-3 py-2 mono text-xs"
        >
          {log.length === 0 ? (
            <div className="text-[color:var(--color-fg-muted)]">
              {busy ? 'Waiting for output…' : 'Submit a pull to see streaming output here.'}
            </div>
          ) : (
            log.map((line, i) => (
              <div
                key={i}
                className={
                  line.kind === 'stderr' || line.kind === 'error'
                    ? 'text-[color:var(--color-warn)] whitespace-pre-wrap'
                    : line.kind === 'done'
                      ? 'text-[color:var(--color-accent)] whitespace-pre-wrap'
                      : line.kind === 'start'
                        ? 'text-[color:var(--color-brand)] whitespace-pre-wrap'
                        : 'text-[color:var(--color-fg)] whitespace-pre-wrap'
                }
              >
                {line.text}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
