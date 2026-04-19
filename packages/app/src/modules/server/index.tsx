import * as React from 'react';
import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';

interface LogLine {
  kind: 'launch' | 'waiting' | 'retry' | 'ready' | 'timeout' | 'exited' | 'done' | 'error';
  text: string;
}

const MAX_LOG_LINES = 200;
function truncate(lines: LogLine[]): LogLine[] {
  return lines.length > MAX_LOG_LINES
    ? lines.slice(lines.length - MAX_LOG_LINES)
    : lines;
}

export default function Server(): React.JSX.Element {
  const queryClient = useQueryClient();
  const status = trpc.serverStatus.useQuery(undefined, { refetchInterval: 5000 });
  const catalog = trpc.catalogList.useQuery('all');
  const env = trpc.env.useQuery();

  const [target, setTarget] = useState('current');
  const [timeoutSeconds, setTimeoutSeconds] = useState(60);
  const [skipTuned, setSkipTuned] = useState(false);
  const [starting, setStarting] = useState<{ target: string; timeoutSeconds: number; skipTuned: boolean } | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
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
      case 'launch':
        appendLog({
          kind: 'launch',
          text: `launched pid=${String(e.pid)} — ${String(e.command)} ${((e.args as string[]) ?? []).join(' ')}`,
        });
        break;
      case 'waiting':
        if ((e.attempt as number) % 5 === 0) {
          appendLog({
            kind: 'waiting',
            text: `waiting attempt=${String(e.attempt)} http=${String(e.httpCode ?? 'n/a')}`,
          });
        }
        break;
      case 'retry':
        appendLog({ kind: 'retry', text: `retry: ${String(e.reason)}` });
        break;
      case 'ready':
        appendLog({ kind: 'ready', text: `ready pid=${String(e.pid)} endpoint=${String(e.endpoint)}` });
        break;
      case 'timeout':
        appendLog({ kind: 'timeout', text: `timeout pid=${String(e.pid)}` });
        break;
      case 'exited':
        appendLog({ kind: 'exited', text: `exited code=${String(e.code ?? '?')}` });
        break;
      case 'done': {
        const r = e.result as { ok?: boolean; pid?: number; endpoint?: string; error?: string };
        if (r.ok) {
          appendLog({ kind: 'done', text: `started pid=${r.pid} endpoint=${r.endpoint}` });
        } else {
          appendLog({ kind: 'error', text: r.error ?? 'start failed' });
          setError(r.error ?? 'start failed');
        }
        setStarting(null);
        void queryClient.invalidateQueries({
          queryKey: [['serverStatus'], { type: 'query' }],
        });
        break;
      }
      default:
        appendLog({ kind: 'waiting', text: JSON.stringify(e) });
    }
  };

  const handleError = (err: { message: string }) => {
    appendLog({ kind: 'error', text: err.message });
    setError(err.message);
    setStarting(null);
  };

  trpc.serverStart.useSubscription(
    starting ?? { target: '', timeoutSeconds: 60, skipTuned: false },
    {
      enabled: starting !== null,
      onData: handleEvent,
      onError: handleError,
    },
  );

  const stopMutation = trpc.serverStop.useMutation({
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [['serverStatus'], { type: 'query' }],
      });
    },
    onError: (err) => setError(err.message),
  });

  const rels = useMemo(
    () => (catalog.data ?? []).map((row) => row.rel),
    [catalog.data],
  );

  const onStart = () => {
    const t = target.trim();
    if (!t) {
      setError('Target is required');
      return;
    }
    setLog([]);
    setError(null);
    setStarting({ target: t, timeoutSeconds, skipTuned });
  };

  const s = status.data;
  const envData = env.data as Record<string, string> | undefined;
  const busy = starting !== null;
  const isUp = s?.state === 'up';
  const httpLabel = s?.health.httpCode ?? 'unreachable';
  const httpOk = typeof s?.health.httpCode === 'number' && s.health.httpCode < 400;

  const keepAliveStatus = trpc.keepAliveStatus.useQuery(undefined, { refetchInterval: 5000 });
  const keepAliveStartMutation = trpc.keepAliveStart.useMutation({
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [['keepAliveStatus'], { type: 'query' }],
      });
    },
    onError: (err) => setError(err.message),
  });
  const keepAliveStopMutation = trpc.keepAliveStop.useMutation({
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [['keepAliveStatus'], { type: 'query' }],
      });
    },
    onError: (err) => setError(err.message),
  });
  const ka = keepAliveStatus.data;

  return (
    <div className="h-full overflow-auto p-6" data-testid="server-root">
      <div className="mb-1 text-xs uppercase tracking-widest text-[color:var(--color-fg-muted)]">
        Server
      </div>
      <h1 className="mb-4 text-2xl font-semibold text-[color:var(--color-fg)]">
        llama.cpp lifecycle
      </h1>

      <div className="mb-4 grid grid-cols-4 gap-3">
        <div
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
          data-testid="server-state-card"
        >
          <div className="text-xs uppercase tracking-wide text-[color:var(--color-fg-muted)]">
            State
          </div>
          <div
            data-testid="server-state"
            data-state={s?.state ?? 'unknown'}
            className={`mt-1 text-lg font-semibold ${
              isUp
                ? 'text-[color:var(--color-accent)]'
                : s?.state === 'down'
                  ? 'text-[color:var(--color-danger)]'
                  : 'text-[color:var(--color-fg-muted)]'
            }`}
          >
            {s?.state ?? '—'}
          </div>
        </div>
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3">
          <div className="text-xs uppercase tracking-wide text-[color:var(--color-fg-muted)]">
            Endpoint
          </div>
          <div className="mt-1 mono text-sm break-all text-[color:var(--color-fg)]">
            {s?.endpoint ? (
              <a href={s.endpoint} target="_blank" rel="noreferrer" className="underline">
                {s.endpoint}
              </a>
            ) : (
              '—'
            )}
          </div>
          {s?.advertisedEndpoint && s.advertisedEndpoint !== s.endpoint && (
            <div className="mt-1 text-[10px] text-[color:var(--color-fg-muted)]">
              LAN:{' '}
              <a
                href={s.advertisedEndpoint}
                target="_blank"
                rel="noreferrer"
                className="mono underline"
              >
                {s.advertisedEndpoint}
              </a>
            </div>
          )}
        </div>
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3">
          <div className="text-xs uppercase tracking-wide text-[color:var(--color-fg-muted)]">
            PID
          </div>
          <div className="mt-1 mono text-sm text-[color:var(--color-fg)]">
            {s?.pid ?? 'none'}
          </div>
        </div>
        <div
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
          data-testid="server-http-card"
        >
          <div className="text-xs uppercase tracking-wide text-[color:var(--color-fg-muted)]">
            HTTP
          </div>
          <div
            className={`mt-1 mono text-sm ${
              httpOk
                ? 'text-[color:var(--color-accent)]'
                : s?.health.httpCode == null
                  ? 'text-[color:var(--color-fg-muted)]'
                  : 'text-[color:var(--color-danger)]'
            }`}
          >
            {httpLabel}
          </div>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onStart();
        }}
        className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
      >
        <div className="grid grid-cols-12 gap-3">
          <label className="col-span-6 text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-fg-muted)]">
              Target
            </span>
            <input
              list="server-rel-suggestions"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={busy}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono"
              placeholder="current | best | <rel>"
            />
            <datalist id="server-rel-suggestions">
              {['current', 'best', 'vision', 'balanced', 'fast'].map((alias) => (
                <option key={alias} value={alias} />
              ))}
              {rels.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>
          <label className="col-span-2 text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-fg-muted)]">
              Timeout (s)
            </span>
            <input
              type="number"
              min={5}
              max={600}
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(Math.max(5, Number(e.target.value) || 60))}
              disabled={busy}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono"
            />
          </label>
          <label className="col-span-2 flex flex-col justify-end text-xs text-[color:var(--color-fg-muted)]">
            <span className="mb-1">Tuned args</span>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={!skipTuned}
                onChange={(e) => setSkipTuned(!e.target.checked)}
                disabled={busy}
              />
              <span>use tuned</span>
            </label>
          </label>
          <div className="col-span-2 flex items-end gap-2">
            <button
              type="submit"
              disabled={busy}
              data-testid="server-start"
              className="flex-1 rounded bg-[var(--color-brand)] px-3 py-1 text-sm font-medium text-[color:var(--color-surface-0)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {starting ? 'Starting…' : 'Start'}
            </button>
            <button
              type="button"
              onClick={() => stopMutation.mutate({ graceSeconds: 5 })}
              disabled={busy || stopMutation.isPending || !isUp}
              data-testid="server-stop"
              title={!isUp ? 'Server is not running.' : 'Send SIGTERM, then SIGKILL after a 5s grace.'}
              className="flex-1 rounded border border-[var(--color-danger)] px-3 py-1 text-sm text-[color:var(--color-danger)] hover:bg-[var(--color-surface-2)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {stopMutation.isPending ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        </div>
        <div className="mt-2 text-xs text-[color:var(--color-fg-muted)]">
          LLAMA_CPP_HOST={envData?.LLAMA_CPP_HOST ?? '?'}:
          {envData?.LLAMA_CPP_PORT ?? '?'}
        </div>
      </form>

      {error && (
        <div className="mb-3 rounded-md border border-[var(--color-danger)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[color:var(--color-danger)]">
          {error}
        </div>
      )}

      <section className="mb-6 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-fg-muted)]">
            Keep-alive supervisor
          </h2>
          <span
            className={
              ka?.running
                ? 'mono text-xs text-[color:var(--color-accent)]'
                : 'mono text-xs text-[color:var(--color-fg-muted)]'
            }
          >
            {ka?.running ? `running (pid=${ka.pid})` : 'stopped'}
          </span>
        </div>
        <div className="grid grid-cols-12 gap-3">
          <label className="col-span-7 text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-fg-muted)]">
              Target
            </span>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={ka?.running || keepAliveStartMutation.isPending}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono"
            />
          </label>
          <div className="col-span-5 flex items-end gap-2">
            <button
              type="button"
              onClick={() => keepAliveStartMutation.mutate({ target: target.trim() || 'current' })}
              disabled={ka?.running || keepAliveStartMutation.isPending}
              className="flex-1 rounded bg-[var(--color-accent)] px-3 py-1 text-sm font-medium text-[color:var(--color-surface-0)] hover:opacity-90 disabled:opacity-50"
            >
              {keepAliveStartMutation.isPending ? 'Starting…' : 'Start supervisor'}
            </button>
            <button
              type="button"
              onClick={() => keepAliveStopMutation.mutate({ graceSeconds: 10 })}
              disabled={!ka?.running || keepAliveStopMutation.isPending}
              className="flex-1 rounded border border-[var(--color-danger)] px-3 py-1 text-sm text-[color:var(--color-danger)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
            >
              {keepAliveStopMutation.isPending ? 'Stopping…' : 'Stop supervisor'}
            </button>
          </div>
        </div>
        {ka?.state && (
          <div className="mt-3 grid grid-cols-4 gap-2 text-xs text-[color:var(--color-fg-muted)]">
            <div>
              state=<span className="text-[color:var(--color-fg)]">{ka.state.state ?? '—'}</span>
            </div>
            <div>
              model=<span className="text-[color:var(--color-fg)]">{ka.state.model ?? '—'}</span>
            </div>
            <div>
              restarts=<span className="text-[color:var(--color-fg)]">{ka.state.restarts ?? 0}</span>
            </div>
            <div>
              backoff=<span className="text-[color:var(--color-fg)]">{ka.state.backoff_seconds ?? 0}s</span>
            </div>
          </div>
        )}
      </section>

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
              {busy ? 'Waiting for events…' : 'Lifecycle events appear here during a start.'}
            </div>
          ) : (
            log.map((line, i) => (
              <div
                key={i}
                className={
                  line.kind === 'error' || line.kind === 'timeout' || line.kind === 'exited'
                    ? 'text-[color:var(--color-danger)] whitespace-pre-wrap'
                    : line.kind === 'ready' || line.kind === 'done'
                      ? 'text-[color:var(--color-accent)] whitespace-pre-wrap'
                      : line.kind === 'launch' || line.kind === 'retry'
                        ? 'text-[color:var(--color-brand)] whitespace-pre-wrap'
                        : 'text-[color:var(--color-fg-muted)] whitespace-pre-wrap'
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
