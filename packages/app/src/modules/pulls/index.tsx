import * as React from 'react';
import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';

type Mode = 'file' | 'candidate' | 'test';
type Profile = 'mac-mini-16g' | 'balanced' | 'macbook-pro-48g';

const PROFILES: readonly Profile[] = ['mac-mini-16g', 'balanced', 'macbook-pro-48g'];
const MAX_LOG_LINES = 250;

type CardMode = 'file' | 'candidate' | 'test';

interface PullCardSpec {
  id: string;
  mode: CardMode;
  repo: string;
  file?: string;
  profile?: Profile;
}

interface LogLine {
  kind: 'stdout' | 'stderr' | 'start' | 'exit' | 'done' | 'error' | 'profile';
  text: string;
}

function truncate(lines: LogLine[]): LogLine[] {
  return lines.length > MAX_LOG_LINES ? lines.slice(lines.length - MAX_LOG_LINES) : lines;
}

function lineClass(kind: LogLine['kind']): string {
  switch (kind) {
    case 'stderr':
    case 'error':
      return 'text-[color:var(--color-warn)] whitespace-pre-wrap';
    case 'done':
      return 'text-[color:var(--color-accent)] whitespace-pre-wrap';
    case 'start':
    case 'profile':
      return 'text-[color:var(--color-brand)] whitespace-pre-wrap';
    default:
      return 'text-[color:var(--color-fg)] whitespace-pre-wrap';
  }
}

function PullCard({
  spec,
  onDismiss,
  onDone,
}: {
  spec: PullCardSpec;
  onDismiss: (id: string) => void;
  onDone: () => void;
}): React.JSX.Element {
  const [log, setLog] = useState<LogLine[]>([]);
  const [state, setState] = useState<'running' | 'done' | 'error'>('running');
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const appendLog = (line: LogLine) => {
    setLog((prev) => truncate([...prev, line]));
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  };

  const handleData = (ev: unknown) => {
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
      case 'exit':
        appendLog({ kind: 'exit' as 'stdout', text: `(exit ${e.code})` });
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
      case 'done':
      case 'done-candidate': {
        const result = e.result as { rel?: string; wasMissing?: boolean; mmproj?: string | null };
        const parts = [
          `rel=${result.rel ?? '?'}`,
          `wasMissing=${result.wasMissing ? 'yes' : 'no'}`,
        ];
        if (result.mmproj) parts.push(`mmproj=${result.mmproj}`);
        setSummary(parts.join(' '));
        setState('done');
        appendLog({ kind: 'done', text: parts.join(' ') });
        onDone();
        break;
      }
      case 'done-candidate-test': {
        const result = e.result as {
          rel?: string;
          curatedAdded?: boolean;
          preset?: { ran?: boolean; reason?: string };
          vision?: { ran?: boolean; reason?: string };
        };
        const parts = [
          `rel=${result.rel}`,
          `curated_added=${result.curatedAdded}`,
          `preset=${result.preset?.ran ? 'ran' : (result.preset?.reason ?? 'skipped')}`,
          `vision=${result.vision?.ran ? 'ran' : (result.vision?.reason ?? 'skipped')}`,
        ];
        setSummary(parts.join(' '));
        setState('done');
        appendLog({ kind: 'done', text: parts.join(' ') });
        onDone();
        break;
      }
      default:
        appendLog({ kind: 'stdout', text: JSON.stringify(e) });
    }
  };

  const handleError = (err: { message: string }) => {
    appendLog({ kind: 'error', text: err.message });
    setError(err.message);
    setState('error');
  };

  const enabled = state === 'running';
  trpc.pullFile.useSubscription(
    spec.mode === 'file' && spec.file
      ? { repo: spec.repo, file: spec.file }
      : { repo: '', file: '' },
    {
      enabled: enabled && spec.mode === 'file' && !!spec.file,
      onData: handleData,
      onError: handleError,
    },
  );
  trpc.pullCandidate.useSubscription(
    spec.mode === 'candidate'
      ? { repo: spec.repo, file: spec.file, profile: spec.profile }
      : { repo: '' },
    {
      enabled: enabled && spec.mode === 'candidate',
      onData: handleData,
      onError: handleError,
    },
  );
  trpc.candidateTestRun.useSubscription(
    spec.mode === 'test'
      ? { repo: spec.repo, file: spec.file, profile: spec.profile }
      : { repo: '' },
    {
      enabled: enabled && spec.mode === 'test',
      onData: handleData,
      onError: handleError,
    },
  );

  const label =
    spec.mode === 'file'
      ? `pull file ${spec.repo} ${spec.file}`
      : spec.mode === 'candidate'
        ? `pull candidate ${spec.repo}${spec.profile ? ` (${spec.profile})` : ''}`
        : `candidate test ${spec.repo}`;

  const stateColor =
    state === 'done'
      ? 'text-[color:var(--color-accent)]'
      : state === 'error'
        ? 'text-[color:var(--color-danger)]'
        : 'text-[color:var(--color-brand)]';

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)]">
      <div className="flex items-center justify-between px-3 py-2 text-xs">
        <div className="flex items-center gap-3">
          <span className={`mono ${stateColor}`}>{state}</span>
          <span className="mono text-[color:var(--color-fg-muted)] break-all">{label}</span>
        </div>
        <div className="flex items-center gap-1">
          {state === 'running' && (
            <button
              type="button"
              onClick={() => {
                // Flipping state to `error` (and the useSubscription
                // `enabled` flag with it) unmounts the subscription,
                // triggering the server-side abort controller.
                setState('error');
                setError('Cancelled by user');
              }}
              className="rounded border border-[var(--color-danger)] px-2 py-0.5 text-xs text-[color:var(--color-danger)] hover:bg-[var(--color-surface-2)]"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={() => onDismiss(spec.id)}
            disabled={state === 'running'}
            className="rounded border border-transparent px-2 py-0.5 text-xs text-[color:var(--color-fg-muted)] hover:border-[var(--color-border)] hover:text-[color:var(--color-fg)] disabled:opacity-40"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      </div>
      {(summary || error) && (
        <div
          className={`mono border-t border-[var(--color-border)] px-3 py-1 text-xs ${
            error ? 'text-[color:var(--color-danger)]' : 'text-[color:var(--color-accent)]'
          }`}
        >
          {error ?? summary}
        </div>
      )}
      <div
        ref={logRef}
        className="max-h-[28vh] overflow-auto border-t border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-1.5 mono text-xs"
      >
        {log.length === 0 ? (
          <div className="text-[color:var(--color-fg-muted)]">Waiting for output…</div>
        ) : (
          log.map((line, i) => (
            <div key={i} className={lineClass(line.kind)}>
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default function Pulls(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('file');
  const [repo, setRepo] = useState('');
  const [file, setFile] = useState('');
  const [profile, setProfile] = useState<Profile | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<PullCardSpec[]>([]);

  const enqueue = (): void => {
    const r = repo.trim();
    if (!r) {
      setError('Repo is required');
      return;
    }
    if (mode === 'file' && !file.trim()) {
      setError('File is required for pull-file');
      return;
    }
    setError(null);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const spec: PullCardSpec = {
      id,
      mode,
      repo: r,
      file: mode === 'file' ? file.trim() : file.trim() || undefined,
      profile: mode === 'file' ? undefined : profile || undefined,
    };
    setCards((prev) => [spec, ...prev]);
    setRepo('');
    setFile('');
  };

  const onDismiss = (id: string) => {
    setCards((prev) => prev.filter((c) => c.id !== id));
  };

  const onDone = () => {
    void queryClient.invalidateQueries({
      queryKey: [['catalogList'], { type: 'query' }],
    });
    void queryClient.invalidateQueries({
      queryKey: [['benchHistory'], { type: 'query' }],
    });
    void queryClient.invalidateQueries({
      queryKey: [['benchCompare'], { type: 'query' }],
    });
  };

  const activeCount = useMemo(
    () => cards.length,
    [cards],
  );

  return (
    <div className="h-full overflow-auto p-6" data-testid="pulls-root">
      <div className="mb-1 text-xs uppercase tracking-widest text-[color:var(--color-fg-muted)]">
        Pulls
      </div>
      <h1 className="mb-4 text-2xl font-semibold text-[color:var(--color-fg)]">
        Download a model
      </h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          enqueue();
        }}
        className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
      >
        <div className="mb-3 flex gap-1 text-xs" role="tablist">
          {(['file', 'candidate', 'test'] as Mode[]).map((m) => {
            const isActive = mode === m;
            return (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={isActive}
                data-testid={`pulls-mode-${m}`}
                data-active={isActive ? 'true' : 'false'}
                onClick={() => setMode(m)}
                className={
                  isActive
                    ? 'rounded border border-[var(--color-accent)] bg-[var(--color-surface-2)] px-3 py-1 font-medium text-[color:var(--color-fg)]'
                    : 'rounded border border-transparent px-3 py-1 text-[color:var(--color-fg-muted)] hover:bg-[var(--color-surface-2)] hover:text-[color:var(--color-fg)]'
                }
              >
                {m === 'file' ? 'Pull file' : m === 'candidate' ? 'Pull candidate' : 'Candidate test'}
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-12 gap-3">
          <label className="col-span-5 text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-fg-muted)]">Repo</span>
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
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
              placeholder={
                mode === 'file' ? 'gemma-4-E4B-it-Q8_0.gguf' : '(auto-pick via profile)'
              }
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono"
            />
          </label>
          {(mode === 'candidate' || mode === 'test') && (
            <label className="col-span-2 text-sm">
              <span className="mb-1 block text-xs text-[color:var(--color-fg-muted)]">
                Profile
              </span>
              <select
                value={profile}
                onChange={(e) => setProfile(e.target.value as Profile | '')}
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
              mode === 'file' ? 'col-span-2 flex items-end' : 'col-span-12 flex justify-end'
            }
          >
            <button
              type="submit"
              className="rounded bg-[var(--color-brand)] px-3 py-1 text-sm font-medium text-[color:var(--color-surface-0)] hover:opacity-90"
            >
              {mode === 'test' ? 'Enqueue test' : 'Enqueue pull'}
            </button>
          </div>
        </div>
        <div className="mt-2 text-xs text-[color:var(--color-fg-muted)]">
          Each Enqueue adds a new card below — runs are independent and can be cancelled
          individually.
        </div>
      </form>

      {error && (
        <div className="mb-3 rounded-md border border-[var(--color-danger)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[color:var(--color-danger)]">
          {error}
        </div>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-fg-muted)]">
          Queue ({activeCount})
        </h2>
        {cards.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-[color:var(--color-fg-muted)]">
            No pulls yet. Fill out the form above and hit Enqueue.
          </div>
        ) : (
          <div className="space-y-3">
            {cards.map((spec) => (
              <PullCard
                key={spec.id}
                spec={spec}
                onDismiss={onDismiss}
                onDone={onDone}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
