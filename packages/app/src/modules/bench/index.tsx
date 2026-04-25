import * as React from 'react';
import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';
import { Button, Input, StatusDot, EditorialHero } from '@/ui';

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

function fmtTps(raw: string | number | undefined | null): string {
  if (raw == null || raw === '') return '—';
  const n = typeof raw === 'number' ? raw : Number.parseFloat(raw);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(1);
}

function SchedulerPanel(): React.JSX.Element {
  const utils = trpc.useUtils();
  const list = trpc.benchScheduleList.useQuery();
  const status = trpc.benchSchedulerStatus.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const nodes = trpc.nodeList.useQuery();
  const add = trpc.benchScheduleAdd.useMutation({
    onSuccess: () => void utils.benchScheduleList.invalidate(),
  });
  const remove = trpc.benchScheduleRemove.useMutation({
    onSuccess: () => void utils.benchScheduleList.invalidate(),
  });
  const toggle = trpc.benchScheduleToggle.useMutation({
    onSuccess: () => void utils.benchScheduleList.invalidate(),
  });
  const start = trpc.benchSchedulerStart.useMutation({
    onSuccess: () => void utils.benchSchedulerStatus.invalidate(),
  });
  const stop = trpc.benchSchedulerStop.useMutation({
    onSuccess: () => void utils.benchSchedulerStatus.invalidate(),
  });
  const kick = trpc.benchSchedulerKick.useMutation({
    onSuccess: () => {
      void utils.benchScheduleList.invalidate();
      void utils.benchSchedulerStatus.invalidate();
    },
  });

  const [id, setId] = useState('');
  const [node, setNode] = useState('local');
  const [rel, setRel] = useState('');
  const [hours, setHours] = useState(24);
  const [error, setError] = useState<string | null>(null);

  const schedules = list.data ?? [];
  const running = status.data?.running ?? false;
  const lastTick = status.data?.lastTickAt
    ? new Date(status.data.lastTickAt).toLocaleTimeString()
    : '—';
  const canAddSchedule = id.trim().length > 0 && rel.trim().length > 0;

  function onAdd(): void {
    setError(null);
    if (!id.trim() || !rel.trim()) {
      setError('id and rel are required');
      return;
    }
    add.mutate(
      {
        id: id.trim(),
        node: node.trim() || 'local',
        rel: rel.trim(),
        intervalSeconds: hours * 3600,
      },
      {
        onSuccess: () => {
          setId('');
          setRel('');
        },
        onError: (e) => setError(e.message),
      },
    );
  }

  return (
    <section style={{ marginBottom: 24, borderRadius: 6, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-text)' }}>
          Bench scheduler
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
          <StatusDot tone={running ? 'ok' : 'idle'} />
          <span style={{ color: 'var(--color-text-secondary)' }}>
            {running ? `running · last ${lastTick}` : 'stopped'}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => kick.mutate()}
            disabled={kick.isPending}
            style={{ fontSize: 10, padding: '2px 8px' }}
          >
            {kick.isPending ? '…' : 'Kick'}
          </Button>
          {running ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => stop.mutate()}
              style={{ fontSize: 10, padding: '2px 8px' }}
            >
              Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={() => start.mutate({ tickIntervalSeconds: 60 })}
              style={{ fontSize: 10, padding: '2px 8px' }}
            >
              Start
            </Button>
          )}
        </div>
      </div>
      <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, fontSize: 12 }}>
        <Input
          type="text"
          placeholder="id (e.g. gemma-daily)"
          value={id}
          onChange={(e) => setId(e.target.value)}
          data-testid="bench-schedule-id"
          style={{ width: 160 }}
        />
        <select
          value={node}
          onChange={(e) => setNode(e.target.value)}
          data-testid="bench-schedule-node"
          style={{
            width: 128,
            borderRadius: 4,
            border: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-surface-2)',
            padding: '4px 8px',
            color: 'var(--color-text)',
          }}
        >
          {(nodes.data?.nodes ?? [{ name: 'local' }]).map((n) => (
            <option key={n.name} value={n.name}>
              {n.name}
            </option>
          ))}
        </select>
        <Input
          type="text"
          placeholder="rel path"
          value={rel}
          onChange={(e) => setRel(e.target.value)}
          data-testid="bench-schedule-rel"
          style={{ flex: 1, fontFamily: 'monospace' }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-text-secondary)' }}>
          every
          <Input
            type="number"
            min={1}
            max={168}
            value={hours}
            onChange={(e) => setHours(Math.max(1, Number(e.target.value) || 1))}
            style={{ width: 56, textAlign: 'right' }}
          />
          hours
        </label>
        <Button
          variant="primary"
          size="sm"
          onClick={onAdd}
          disabled={add.isPending || !canAddSchedule}
          data-testid="bench-schedule-add"
          title={
            !canAddSchedule
              ? 'Fill id and rel before adding a schedule.'
              : `Run bench for ${rel.trim()} on ${node.trim() || 'local'} every ${hours}h.`
          }
        >
          {add.isPending ? 'Adding…' : 'Add schedule'}
        </Button>
      </div>
      {error && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-err)' }}>{error}</div>
      )}
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {schedules.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            No schedules yet. Add one above to run benches on a cadence.
          </div>
        )}
        {schedules.map((s) => (
          <div
            key={s.id}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderRadius: 4, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-2)', padding: '8px 12px', fontSize: 12 }}
          >
            <div>
              <span style={{ fontFamily: 'monospace', color: 'var(--color-text)' }}>{s.id}</span>
              <span style={{ margin: '0 4px', color: 'var(--color-text-secondary)' }}>·</span>
              <span style={{ color: 'var(--color-text-secondary)' }}>{s.node}</span>
              <span style={{ margin: '0 4px', color: 'var(--color-text-secondary)' }}>·</span>
              <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{s.rel}</span>
              <div style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
                every {Math.round(s.intervalSeconds / 3600)} hours · last {s.lastRunAt ?? '—'}
                {s.lastError && (
                  <span style={{ marginLeft: 8, color: 'var(--color-err)' }}>err: {s.lastError}</span>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => toggle.mutate({ id: s.id, enabled: !s.enabled })}
                style={{ fontSize: 10, padding: '2px 8px' }}
              >
                {s.enabled ? 'pause' : 'resume'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove.mutate({ id: s.id })}
                style={{ fontSize: 10, padding: '2px 8px' }}
              >
                remove
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function Bench(): React.JSX.Element {
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
  const canRun = target.trim().length > 0;
  const cancel = () => {
    setActive(null);
    setError('Cancelled by user');
  };

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 24 }} data-testid="models-bench-root">
      <div style={{ marginBottom: 4, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-secondary)' }}>
        Bench
      </div>
      <h1 style={{ marginBottom: 16, fontSize: 24, fontWeight: 600, color: 'var(--color-text)' }}>
        Tune + measure
      </h1>

      <SchedulerPanel />

      <form
        onSubmit={(e) => e.preventDefault()}
        style={{ marginBottom: 16, borderRadius: 6, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)', padding: 16 }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 12 }}>
          <label style={{ gridColumn: 'span 7 / span 7', fontSize: 14 }}>
            <span style={{ marginBottom: 4, display: 'block', fontSize: 12, color: 'var(--color-text-secondary)' }}>
              Target (rel or preset alias)
            </span>
            <Input
              list="bench-rel-suggestions"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={busy}
              data-testid="bench-target"
              style={{ width: '100%', fontFamily: 'monospace' }}
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
          <label style={{ gridColumn: 'span 2 / span 2', fontSize: 14 }}>
            <span style={{ marginBottom: 4, display: 'block', fontSize: 12, color: 'var(--color-text-secondary)' }}>Mode</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as Mode)}
              disabled={busy}
              style={{
                width: '100%',
                borderRadius: 4,
                border: '1px solid var(--color-border)',
                backgroundColor: 'var(--color-surface-2)',
                padding: '4px 8px',
                fontFamily: 'monospace',
                color: 'var(--color-text)',
              }}
            >
              <option value="auto">auto</option>
              <option value="text">text</option>
              <option value="vision">vision</option>
            </select>
          </label>
          <div style={{ gridColumn: 'span 3 / span 3', display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            {busy ? (
              <Button
                variant="destructive"
                onClick={cancel}
                data-testid="bench-cancel"
                style={{ flex: 1 }}
              >
                Cancel
              </Button>
            ) : (
              <>
                <Button
                  variant="primary"
                  onClick={() => start('preset')}
                  disabled={!canRun}
                  data-testid="bench-run-preset"
                  title={canRun ? 'Run text preset bench.' : 'Enter a target first.'}
                  style={{ flex: 1 }}
                >
                  Run preset
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => start('vision')}
                  disabled={!canRun}
                  data-testid="bench-run-vision"
                  title={canRun ? 'Run vision bench.' : 'Enter a target first.'}
                  style={{ flex: 1 }}
                >
                  Run vision
                </Button>
              </>
            )}
          </div>
        </div>
      </form>

      {error && (
        <div style={{ marginBottom: 12, borderRadius: 6, border: '1px solid var(--color-err)', backgroundColor: 'var(--color-surface-1)', padding: '8px 12px', fontSize: 14, color: 'var(--color-err)' }}>
          {error}
        </div>
      )}
      {summary && (
        <div style={{ marginBottom: 12, borderRadius: 6, border: '1px solid var(--color-ok)', backgroundColor: 'var(--color-surface-1)', padding: '8px 12px', fontSize: 14 }}>
          <div style={{ color: 'var(--color-ok)' }}>Bench complete</div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--color-text-secondary)' }}>{summary}</div>
        </div>
      )}

      <div style={{ marginBottom: 24, borderRadius: 6, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-0)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
          <span>Log</span>
          <span>
            {log.length} line{log.length === 1 ? '' : 's'}
          </span>
        </div>
        <div
          ref={logRef}
          style={{
            maxHeight: '40vh',
            overflow: 'auto',
            borderTop: '1px solid var(--color-border)',
            padding: '8px 12px',
            fontFamily: 'monospace',
            fontSize: 12,
          }}
        >
          {log.length === 0 ? (
            <div style={{ color: 'var(--color-text-secondary)' }}>
              {busy ? 'Waiting for output…' : 'Run preset or vision to see streaming output here.'}
            </div>
          ) : (
            log.map((line, i) => {
              let color = 'var(--color-text)';
              if (line.kind === 'stderr' || line.kind === 'error') color = 'var(--color-warn)';
              else if (line.kind === 'done') color = 'var(--color-ok)';
              else if (line.kind === 'start' || line.kind === 'profile') color = 'var(--color-brand)';

              return (
                <div key={i} style={{ color, whiteSpace: 'pre-wrap' }}>
                  {line.text}
                </div>
              );
            })
          )}
        </div>
      </div>

      <section>
        <h2 style={{ marginBottom: 8, fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
          Recent history ({recentHistory.length})
        </h2>
        {recentHistory.length === 0 ? (
          <EditorialHero
            title="No benchmark history recorded yet"
            lede="Run a benchmark to see the history here."
          />
        ) : (
          <div style={{ overflow: 'hidden', borderRadius: 6, border: '1px solid var(--color-border)' }}>
            <table style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}>
              <thead style={{ backgroundColor: 'var(--color-surface-1)', textAlign: 'left', color: 'var(--color-text-secondary)' }}>
                <tr>
                  <th style={{ padding: '8px 12px', fontWeight: 500 }}>Updated</th>
                  <th style={{ padding: '8px 12px', fontWeight: 500 }}>Rel</th>
                  <th style={{ padding: '8px 12px', fontWeight: 500 }}>Mode</th>
                  <th style={{ padding: '8px 12px', fontWeight: 500 }}>Profile</th>
                  <th style={{ padding: '8px 12px', fontWeight: 500, textAlign: 'right' }}>Gen tps</th>
                  <th style={{ padding: '8px 12px', fontWeight: 500, textAlign: 'right' }}>Prompt tps</th>
                  <th style={{ padding: '8px 12px', fontWeight: 500 }}>Build</th>
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
                      style={{ borderTop: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}
                    >
                      <td style={{ padding: '6px 12px', color: 'var(--color-text-secondary)' }}>
                        {row.updated_at}
                      </td>
                      <td style={{ padding: '6px 12px', color: 'var(--color-brand)', wordBreak: 'break-all' }}>
                        {row.rel}
                      </td>
                      <td style={{ padding: '6px 12px' }}>{row.mode}</td>
                      <td style={{ padding: '6px 12px' }}>{row.profile}</td>
                      <td style={{ padding: '6px 12px', textAlign: 'right', color: 'var(--color-ok)' }}>
                        {fmtTps(row.gen_ts)}
                      </td>
                      <td style={{ padding: '6px 12px', textAlign: 'right' }}>{fmtTps(row.prompt_ts)}</td>
                      <td style={{ padding: '6px 12px', color: 'var(--color-text-secondary)' }}>
                        {row.build}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
