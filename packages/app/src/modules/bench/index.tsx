import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';

type Mode = 'auto' | 'text' | 'vision';
type RunKind = 'preset' | 'vision';

interface LogLine {
  kind: 'stdout' | 'stderr' | 'start' | 'profile' | 'done' | 'error';
  text: string;
}

const MAX_LOG_LINES = 400;

function truncate(lines: LogLine[]): LogLine[] {
  return lines.length > MAX_LOG_LINES
    ? lines.slice(lines.length - MAX_LOG_LINES)
    : lines;
}

export default function Bench(): JSX.Element {
  const queryClient = useQueryClient();
  const catalog = trpc.catalogList.useQuery('all');
  const history = trpc.benchHistory.useQuery(undefined);

  const [target, setTarget] = useState('current');
  const [mode, setMode] = useState<Mode>('auto');
  const [active, setActive] = useState<
    | { kind: 'preset'; target: string; mode: Mode }
    | { kind: 'vision'; target: string }
    | null
  >(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const appendLog = (line: LogLine) => {
    setLog((prev) => truncate([...prev, line]));
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  };

  const handleEvent = (ev: unknown) => {
    const e = ev as { type: string } & Record<string, unknown>;
    switch (e.type) {
      case 'start':
        appendLog({
          kind: 'start',
          text: `$ ${String(e.command)} ${((e.args as string[]) ?? []).join(' ')}`,
        });
        break;
      case 'stdout':
        appendLog({ kind: 'stdout', text: String(e.line ?? '') });
        break;
      case 'stderr':
        appendLog({ kind: 'stderr', text: String(e.line ?? '') });
        break;
      case 'profile-start':
        appendLog({ kind: 'profile', text: `-- profile=${String(e.profile)} --` });
        break;
      case 'profile-done':
        appendLog({
          kind: 'profile',
          text: `-- profile=${String(e.profile)} gen_ts=${String(e.gen_ts)} prompt_ts=${String(e.prompt_ts)} --`,
        });
        break;
      case 'profile-fail':
        appendLog({
          kind: 'error',
          text: `-- profile=${String(e.profile)} failed (code=${String(e.code)}) --`,
        });
        break;
      case 'done-preset': {
        const r = e.result as {
          bestProfile?: string;
          gen_ts?: string;
          prompt_ts?: string;
          rel?: string;
        };
        const text = `preset: rel=${r.rel} profile=${r.bestProfile} gen_tps=${r.gen_ts} prompt_tps=${r.prompt_ts}`;
        appendLog({ kind: 'done', text });
        setSummary(text);
        setActive(null);
        void queryClient.invalidateQueries({
          queryKey: [['benchHistory'], { type: 'query' }],
        });
        void queryClient.invalidateQueries({
          queryKey: [['benchCompare'], { type: 'query' }],
        });
        break;
      }
      case 'done-vision': {
        const r = e.result as {
          rel?: string;
          load_ms?: string;
          image_encode_ms?: string;
          prompt_tps?: string;
          gen_tps?: string;
        };
        const text = `vision: rel=${r.rel} load_ms=${r.load_ms} encode_ms=${r.image_encode_ms} prompt_tps=${r.prompt_tps} gen_tps=${r.gen_tps}`;
        appendLog({ kind: 'done', text });
        setSummary(text);
        setActive(null);
        void queryClient.invalidateQueries({
          queryKey: [['benchVisionRows'], { type: 'query' }],
        });
        void queryClient.invalidateQueries({
          queryKey: [['benchCompare'], { type: 'query' }],
        });
        break;
      }
      default:
        appendLog({ kind: 'stdout', text: JSON.stringify(e) });
    }
  };

  const handleError = (err: { message: string }) => {
    appendLog({ kind: 'error', text: err.message });
    setError(err.message);
    setActive(null);
  };

  trpc.benchPresetRun.useSubscription(
    active?.kind === 'preset'
      ? { target: active.target, mode: active.mode }
      : { target: '' },
    {
      enabled: active?.kind === 'preset',
      onData: handleEvent,
      onError: handleError,
    },
  );

  trpc.benchVisionRun.useSubscription(
    active?.kind === 'vision'
      ? { target: active.target }
      : { target: '' },
    {
      enabled: active?.kind === 'vision',
      onData: handleEvent,
      onError: handleError,
    },
  );

  const rels = useMemo(
    () => (catalog.data ?? []).map((row) => row.rel),
    [catalog.data],
  );

  const start = (kind: RunKind) => {
    const t = target.trim();
    if (!t) {
      setError('Target is required');
      return;
    }
    setLog([]);
    setSummary(null);
    setError(null);
    if (kind === 'preset') {
      setActive({ kind: 'preset', target: t, mode });
    } else {
      setActive({ kind: 'vision', target: t });
    }
  };

  const busy = active !== null;
  const recentHistory = history.data ?? [];

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-1 text-xs uppercase tracking-widest text-[color:var(--color-fg-muted)]">
        Bench
      </div>
      <h1 className="mb-4 text-2xl font-semibold text-[color:var(--color-fg)]">
        Tune + measure
      </h1>

      <form
        onSubmit={(e) => e.preventDefault()}
        className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
      >
        <div className="grid grid-cols-12 gap-3">
          <label className="col-span-7 text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-fg-muted)]">
              Target (rel or preset alias)
            </span>
            <input
              list="bench-rel-suggestions"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={busy}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono"
              placeholder="current | best | <rel>"
            />
            <datalist id="bench-rel-suggestions">
              {['current', 'best', 'vision', 'balanced', 'fast'].map((alias) => (
                <option key={alias} value={alias} />
              ))}
              {rels.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>
          <label className="col-span-2 text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-fg-muted)]">Mode</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as Mode)}
              disabled={busy}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono"
            >
              <option value="auto">auto</option>
              <option value="text">text</option>
              <option value="vision">vision</option>
            </select>
          </label>
          <div className="col-span-3 flex items-end gap-2">
            <button
              type="button"
              onClick={() => start('preset')}
              disabled={busy}
              className="flex-1 rounded bg-[var(--color-brand)] px-3 py-1 text-sm font-medium text-[color:var(--color-surface-0)] hover:opacity-90 disabled:opacity-50"
            >
              {active?.kind === 'preset' ? 'Running…' : 'Run preset'}
            </button>
            <button
              type="button"
              onClick={() => start('vision')}
              disabled={busy}
              className="flex-1 rounded border border-[var(--color-accent)] px-3 py-1 text-sm font-medium text-[color:var(--color-accent)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
            >
              {active?.kind === 'vision' ? 'Running…' : 'Run vision'}
            </button>
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
          <div className="text-[color:var(--color-accent)]">Bench complete</div>
          <div className="mono text-xs text-[color:var(--color-fg-muted)]">{summary}</div>
        </div>
      )}

      <div className="mb-6 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-0)]">
        <div className="flex items-center justify-between px-3 py-2 text-xs uppercase tracking-wide text-[color:var(--color-fg-muted)]">
          <span>Log</span>
          <span>
            {log.length} line{log.length === 1 ? '' : 's'}
          </span>
        </div>
        <div
          ref={logRef}
          className="max-h-[40vh] overflow-auto border-t border-[var(--color-border)] px-3 py-2 mono text-xs"
        >
          {log.length === 0 ? (
            <div className="text-[color:var(--color-fg-muted)]">
              {busy ? 'Waiting for output…' : 'Run preset or vision to see streaming output here.'}
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
                      : line.kind === 'start' || line.kind === 'profile'
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

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-fg-muted)]">
          Recent history ({recentHistory.length})
        </h2>
        <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
          <table className="w-full mono text-xs">
            <thead className="bg-[var(--color-surface-1)] text-left text-[color:var(--color-fg-muted)]">
              <tr>
                <th className="px-3 py-2 font-medium">Updated</th>
                <th className="px-3 py-2 font-medium">Rel</th>
                <th className="px-3 py-2 font-medium">Mode</th>
                <th className="px-3 py-2 font-medium">Profile</th>
                <th className="px-3 py-2 text-right font-medium">Gen tps</th>
                <th className="px-3 py-2 text-right font-medium">Prompt tps</th>
                <th className="px-3 py-2 font-medium">Build</th>
              </tr>
            </thead>
            <tbody>
              {recentHistory
                .slice()
                .reverse()
                .slice(0, 30)
                .map((row, i) => (
                  <tr
                    key={`${row.updated_at}-${i}`}
                    className="border-t border-[var(--color-border)] bg-[var(--color-surface-1)]"
                  >
                    <td className="px-3 py-1.5 text-[color:var(--color-fg-muted)]">
                      {row.updated_at}
                    </td>
                    <td className="px-3 py-1.5 text-[color:var(--color-brand)] break-all">
                      {row.rel}
                    </td>
                    <td className="px-3 py-1.5">{row.mode}</td>
                    <td className="px-3 py-1.5">{row.profile}</td>
                    <td className="px-3 py-1.5 text-right text-[color:var(--color-accent)]">
                      {row.gen_ts}
                    </td>
                    <td className="px-3 py-1.5 text-right">{row.prompt_ts}</td>
                    <td className="px-3 py-1.5 text-[color:var(--color-fg-muted)]">
                      {row.build}
                    </td>
                  </tr>
                ))}
              {recentHistory.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-6 text-center text-[color:var(--color-fg-muted)]"
                  >
                    No benchmark history recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
