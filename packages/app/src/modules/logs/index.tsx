import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button, StatusDot } from '@/ui';
import type { StatusDotTone } from '@/ui';

/**
 * Tails `server.log` via the `serverLogs` subscription. Keeps a
 * rolling buffer of the last N lines so the UI doesn't explode when
 * llama-server floods output. The "follow" toggle switches between
 * one-shot tail (the last `lines` items) and live streaming.
 */

const MAX_BUFFER_LINES = 2000;

type ConnState = 'connecting' | 'live' | 'error' | 'idle';

export default function Logs(): React.JSX.Element {
  const [lines, setLines] = useState<string[]>([]);
  const [follow, setFollow] = useState(true);
  const [historyLines, setHistoryLines] = useState(200);
  const [subKey, setSubKey] = useState(0);
  const [autoscroll, setAutoscroll] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Mirror the Server module's status poll so we can gate tailing when
  // no llama-server is reachable. Without this the subscription keeps
  // retrying a dead endpoint and the UI sits on an opaque empty state.
  const serverStatus = trpc.serverStatus.useQuery(undefined, { refetchInterval: 5000 });
  const serverDown = serverStatus.data?.state === 'down';

  trpc.serverLogs.useSubscription(
    { lines: historyLines, follow },
    {
      enabled: !serverDown,
      onStarted: () => {
        setConn(follow ? 'live' : 'idle');
        setError(null);
      },
      onData: (evt) => {
        const e = evt as { type?: string; line?: string };
        if (e.type === 'line' && typeof e.line === 'string') {
          setLines((prev) => {
            const next = [...prev, e.line as string];
            if (next.length > MAX_BUFFER_LINES) {
              return next.slice(next.length - MAX_BUFFER_LINES);
            }
            return next;
          });
        }
      },
      onError: (err) => {
        setError(err.message);
        setConn('error');
      },
      // The sub key forces the hook to tear down and recreate the
      // subscription when the user toggles follow or changes the
      // history window — tRPC v11 only re-subscribes when the input
      // identity changes, so we bump a counter to kick it.
      key: subKey,
    } as Parameters<typeof trpc.serverLogs.useSubscription>[1],
  );

  useEffect(() => {
    if (!autoscroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, autoscroll]);

  function clear(): void {
    setLines([]);
    setError(null);
  }

  function restart(): void {
    setLines([]);
    setError(null);
    setConn('connecting');
    setSubKey((k) => k + 1);
  }

  const connTone: StatusDotTone =
    conn === 'live'
      ? 'ok'
      : conn === 'error'
        ? 'err'
        : conn === 'connecting'
          ? 'info'
          : 'idle';
  const connLabel =
    conn === 'live'
      ? 'streaming'
      : conn === 'error'
        ? 'error'
        : conn === 'connecting'
          ? 'connecting'
          : 'idle';

  return (
    <div className="flex h-full flex-col p-6" data-testid="logs-root">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-semibold text-[color:var(--color-text)]">Logs</h1>
          <div className="text-xs text-[color:var(--color-text-secondary)]">
            {serverDown ? (
              <span>Server offline</span>
            ) : (
              <>
                Tailing <span className="font-mono">server.log</span>
              </>
            )}
            {error && (
              <span className="ml-2 text-[color:var(--color-err)]">· error: {error}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <StatusDot
            data-testid="logs-conn"
            data-state={conn}
            tone={connTone}
            pulse={conn === 'live' || conn === 'connecting'}
            label={connLabel}
            title={error ?? `subscription ${connLabel}`}
          />
          <label className="flex items-center gap-1 text-[color:var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => {
                setFollow(e.target.checked);
                setConn('connecting');
                setSubKey((k) => k + 1);
              }}
            />
            follow
          </label>
          <label className="flex items-center gap-1 text-[color:var(--color-text-secondary)]">
            history
            <input
              type="number"
              min={0}
              max={1000}
              step={50}
              value={historyLines}
              onChange={(e) => setHistoryLines(Number(e.target.value) || 0)}
              className="w-16 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 py-0.5 text-right text-[color:var(--color-text)]"
            />
          </label>
          <label className="flex items-center gap-1 text-[color:var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={autoscroll}
              onChange={(e) => setAutoscroll(e.target.checked)}
            />
            autoscroll
          </label>
          <Button type="button" variant="secondary" size="sm" onClick={restart}>
            Reconnect
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            Clear
          </Button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-0)] p-2 font-mono text-[11px] leading-snug text-[color:var(--color-text)]"
      >
        {serverDown ? (
          <div data-testid="logs-offline" className="text-[color:var(--color-text-secondary)]">
            No llama-server running. Start one from the Server module first.
          </div>
        ) : lines.length === 0 ? (
          <div className="text-[color:var(--color-text-secondary)]">(no log lines yet)</div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
