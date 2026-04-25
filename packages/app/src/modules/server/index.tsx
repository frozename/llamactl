import * as React from 'react';
import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';
import { Button, Input, StatusDot } from '@/ui';

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
    <div style={{ height: '100%', overflow: 'auto', padding: 24 }} data-testid="models-server-root">
      <div style={{ marginBottom: 4, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-secondary)' }}>
        Server
      </div>
      <h1 style={{ marginBottom: 16, fontSize: 24, fontWeight: 600, color: 'var(--color-text)' }}>
        llama.cpp lifecycle
      </h1>

      <div style={{ marginBottom: 16, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
        <div
          style={{ borderRadius: 6, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)', padding: 12 }}
          data-testid="server-state-card"
        >
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
            State
          </div>
          <div
            data-testid="server-state"
            data-state={s?.state ?? 'unknown'}
            style={{
              marginTop: 4,
              fontSize: 18,
              fontWeight: 600,
              color: isUp
                ? 'var(--color-ok)'
                : s?.state === 'down'
                  ? 'var(--color-err)'
                  : 'var(--color-text-secondary)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <StatusDot tone={isUp ? 'ok' : s?.state === 'down' ? 'err' : 'idle'} />
            {s?.state ?? '—'}
          </div>
        </div>
        <div style={{ borderRadius: 6, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)', padding: 12 }}>
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
            Endpoint
          </div>
          <div style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 14, wordBreak: 'break-all', color: 'var(--color-text)' }}>
            {s?.endpoint ? (
              <a href={s.endpoint} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
                {s.endpoint}
              </a>
            ) : (
              '—'
            )}
          </div>
          {s?.advertisedEndpoint && s.advertisedEndpoint !== s.endpoint && (
            <div style={{ marginTop: 4, fontSize: 10, color: 'var(--color-text-secondary)' }}>
              LAN:{' '}
              <a
                href={s.advertisedEndpoint}
                target="_blank"
                rel="noreferrer"
                style={{ fontFamily: 'monospace', textDecoration: 'underline' }}
              >
                {s.advertisedEndpoint}
              </a>
            </div>
          )}
        </div>
        <div style={{ borderRadius: 6, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)', padding: 12 }}>
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
            PID
          </div>
          <div style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 14, color: 'var(--color-text)' }}>
            {s?.pid ?? 'none'}
          </div>
        </div>
        <div
          style={{ borderRadius: 6, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)', padding: 12 }}
          data-testid="server-http-card"
        >
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
            HTTP
          </div>
          <div
            style={{
              marginTop: 4,
              fontFamily: 'monospace',
              fontSize: 14,
              color: httpOk
                ? 'var(--color-ok)'
                : s?.health.httpCode == null
                  ? 'var(--color-text-secondary)'
                  : 'var(--color-err)',
            }}
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
        style={{ marginBottom: 16, borderRadius: 6, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)', padding: 16 }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 12 }}>
          <label style={{ gridColumn: 'span 6 / span 6', fontSize: 14 }}>
            <span style={{ marginBottom: 4, display: 'block', fontSize: 12, color: 'var(--color-text-secondary)' }}>
              Target
            </span>
            <Input
              list="server-rel-suggestions"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={busy}
              style={{ width: '100%', fontFamily: 'monospace' }}
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
          <label style={{ gridColumn: 'span 2 / span 2', fontSize: 14 }}>
            <span style={{ marginBottom: 4, display: 'block', fontSize: 12, color: 'var(--color-text-secondary)' }}>
              Timeout (s)
            </span>
            <Input
              type="number"
              min={5}
              max={600}
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(Math.max(5, Number(e.target.value) || 60))}
              disabled={busy}
              style={{ width: '100%', fontFamily: 'monospace' }}
            />
          </label>
          <label style={{ gridColumn: 'span 2 / span 2', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', fontSize: 12, color: 'var(--color-text-secondary)' }}>
            <span style={{ marginBottom: 4 }}>Tuned args</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="checkbox"
                checked={!skipTuned}
                onChange={(e) => setSkipTuned(!e.target.checked)}
                disabled={busy}
              />
              <span>use tuned</span>
            </label>
          </label>
          <div style={{ gridColumn: 'span 2 / span 2', display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <Button
              type="submit"
              variant="primary"
              disabled={busy}
              data-testid="server-start"
              style={{ flex: 1 }}
            >
              {starting ? 'Starting…' : 'Start'}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => stopMutation.mutate({ graceSeconds: 5 })}
              disabled={busy || stopMutation.isPending || !isUp}
              data-testid="server-stop"
              title={!isUp ? 'Server is not running.' : 'Send SIGTERM, then SIGKILL after a 5s grace.'}
              style={{ flex: 1 }}
            >
              {stopMutation.isPending ? 'Stopping…' : 'Stop'}
            </Button>
          </div>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          LLAMA_CPP_HOST={envData?.LLAMA_CPP_HOST ?? '?'}:
          {envData?.LLAMA_CPP_PORT ?? '?'}
        </div>
      </form>

      {error && (
        <div style={{ marginBottom: 12, borderRadius: 6, border: '1px solid var(--color-err)', backgroundColor: 'var(--color-surface-1)', padding: '8px 12px', fontSize: 14, color: 'var(--color-err)' }}>
          {error}
        </div>
      )}

      <section style={{ marginBottom: 24, borderRadius: 6, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)', padding: 16 }}>
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
            Keep-alive supervisor
          </h2>
          <span
            style={{
              fontFamily: 'monospace',
              fontSize: 12,
              color: ka?.running ? 'var(--color-ok)' : 'var(--color-text-secondary)',
            }}
          >
            {ka?.running ? `running (pid=${ka.pid})` : 'stopped'}
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 12 }}>
          <label style={{ gridColumn: 'span 7 / span 7', fontSize: 14 }}>
            <span style={{ marginBottom: 4, display: 'block', fontSize: 12, color: 'var(--color-text-secondary)' }}>
              Target
            </span>
            <Input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={ka?.running || keepAliveStartMutation.isPending}
              style={{ width: '100%', fontFamily: 'monospace' }}
            />
          </label>
          <div style={{ gridColumn: 'span 5 / span 5', display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <Button
              type="button"
              variant="primary"
              onClick={() => keepAliveStartMutation.mutate({ target: target.trim() || 'current' })}
              disabled={ka?.running || keepAliveStartMutation.isPending}
              style={{ flex: 1 }}
            >
              {keepAliveStartMutation.isPending ? 'Starting…' : 'Start supervisor'}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => keepAliveStopMutation.mutate({ graceSeconds: 10 })}
              disabled={!ka?.running || keepAliveStopMutation.isPending}
              style={{ flex: 1 }}
            >
              {keepAliveStopMutation.isPending ? 'Stopping…' : 'Stop supervisor'}
            </Button>
          </div>
        </div>
        {ka?.state && (
          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            <div>
              state=<span style={{ color: 'var(--color-text)' }}>{ka.state.state ?? '—'}</span>
            </div>
            <div>
              model=<span style={{ color: 'var(--color-text)' }}>{ka.state.model ?? '—'}</span>
            </div>
            <div>
              restarts=<span style={{ color: 'var(--color-text)' }}>{ka.state.restarts ?? 0}</span>
            </div>
            <div>
              backoff=<span style={{ color: 'var(--color-text)' }}>{ka.state.backoff_seconds ?? 0}s</span>
            </div>
          </div>
        )}
      </section>

      <div style={{ borderRadius: 6, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-0)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
          <span>Log</span>
          <span>
            {log.length} line{log.length === 1 ? '' : 's'}
          </span>
        </div>
        <div
          ref={logRef}
          style={{
            maxHeight: '50vh',
            overflow: 'auto',
            borderTop: '1px solid var(--color-border)',
            padding: '8px 12px',
            fontFamily: 'monospace',
            fontSize: 12,
          }}
        >
          {log.length === 0 ? (
            <div style={{ color: 'var(--color-text-secondary)' }}>
              {busy ? 'Waiting for events…' : 'Lifecycle events appear here during a start.'}
            </div>
          ) : (
            log.map((line, i) => {
              let color = 'var(--color-text-secondary)';
              if (line.kind === 'error' || line.kind === 'timeout' || line.kind === 'exited') {
                color = 'var(--color-err)';
              } else if (line.kind === 'ready' || line.kind === 'done') {
                color = 'var(--color-ok)';
              } else if (line.kind === 'launch' || line.kind === 'retry') {
                color = 'var(--color-brand)';
              }

              return (
                <div key={i} style={{ color, whiteSpace: 'pre-wrap' }}>
                  {line.text}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
