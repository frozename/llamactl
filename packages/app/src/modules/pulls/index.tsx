import * as React from 'react';
import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';
import { Button, Input, EditorialHero } from '@/ui';

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

function getLogColor(kind: LogLine['kind']): string {
  switch (kind) {
    case 'stderr':
    case 'error':
      return 'var(--color-warn)';
    case 'done':
      return 'var(--color-ok)';
    case 'start':
    case 'profile':
      return 'var(--color-brand)';
    default:
      return 'var(--color-text)';
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
      ? 'var(--color-ok)'
      : state === 'error'
        ? 'var(--color-err)'
        : 'var(--color-brand)';

  return (
    <div style={{ borderRadius: 6, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', fontSize: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: 'monospace', color: stateColor }}>{state}</span>
          <span style={{ fontFamily: 'monospace', color: 'var(--color-text-secondary)', wordBreak: 'break-all' }}>{label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {state === 'running' && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setState('error');
                setError('Cancelled by user');
              }}
              style={{ fontSize: 12, padding: '2px 8px' }}
            >
              Cancel
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDismiss(spec.id)}
            disabled={state === 'running'}
            style={{ fontSize: 12, padding: '2px 8px' }}
            aria-label="Dismiss"
          >
            ×
          </Button>
        </div>
      </div>
      {(summary || error) && (
        <div
          style={{
            fontFamily: 'monospace',
            borderTop: '1px solid var(--color-border)',
            padding: '4px 12px',
            fontSize: 12,
            color: error ? 'var(--color-err)' : 'var(--color-ok)',
          }}
        >
          {error ?? summary}
        </div>
      )}
      <div
        ref={logRef}
        style={{
          maxHeight: '28vh',
          overflow: 'auto',
          borderTop: '1px solid var(--color-border)',
          backgroundColor: 'var(--color-surface-0)',
          padding: '6px 12px',
          fontFamily: 'monospace',
          fontSize: 12,
        }}
      >
        {log.length === 0 ? (
          <div style={{ color: 'var(--color-text-secondary)' }}>Waiting for output…</div>
        ) : (
          log.map((line, i) => (
            <div key={i} style={{ color: getLogColor(line.kind), whiteSpace: 'pre-wrap' }}>
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
    <div style={{ height: '100%', overflow: 'auto', padding: 24 }} data-testid="models-pulls-root">
      <div style={{ marginBottom: 4, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-secondary)' }}>
        Pulls
      </div>
      <h1 style={{ marginBottom: 16, fontSize: 24, fontWeight: 600, color: 'var(--color-text)' }}>
        Download a model
      </h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          enqueue();
        }}
        style={{ marginBottom: 16, borderRadius: 6, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)', padding: 16 }}
      >
        <div style={{ marginBottom: 12, display: 'flex', gap: 4, fontSize: 12 }} role="tablist">
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
                style={{
                  borderRadius: 4,
                  border: isActive ? '1px solid var(--color-brand)' : '1px solid transparent',
                  backgroundColor: isActive ? 'var(--color-surface-2)' : 'transparent',
                  padding: '4px 12px',
                  fontWeight: isActive ? 500 : 400,
                  color: isActive ? 'var(--color-text)' : 'var(--color-text-secondary)',
                  cursor: 'pointer',
                }}
              >
                {m === 'file' ? 'Pull file' : m === 'candidate' ? 'Pull candidate' : 'Candidate test'}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 12 }}>
          <label style={{ gridColumn: 'span 5 / span 5', fontSize: 14 }}>
            <span style={{ marginBottom: 4, display: 'block', fontSize: 12, color: 'var(--color-text-secondary)' }}>Repo</span>
            <Input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="unsloth/gemma-4-E4B-it-GGUF"
              style={{ width: '100%', fontFamily: 'monospace' }}
            />
          </label>
          <label style={{ gridColumn: 'span 5 / span 5', fontSize: 14 }}>
            <span style={{ marginBottom: 4, display: 'block', fontSize: 12, color: 'var(--color-text-secondary)' }}>
              {mode === 'file' ? 'File' : 'File (optional override)'}
            </span>
            <Input
              value={file}
              onChange={(e) => setFile(e.target.value)}
              placeholder={
                mode === 'file' ? 'gemma-4-E4B-it-Q8_0.gguf' : '(auto-pick via profile)'
              }
              style={{ width: '100%', fontFamily: 'monospace' }}
            />
          </label>
          {(mode === 'candidate' || mode === 'test') && (
            <label style={{ gridColumn: 'span 2 / span 2', fontSize: 14 }}>
              <span style={{ marginBottom: 4, display: 'block', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                Profile
              </span>
              <select
                value={profile}
                onChange={(e) => setProfile(e.target.value as Profile | '')}
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
            style={{
              gridColumn: mode === 'file' ? 'span 2 / span 2' : 'span 12 / span 12',
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: mode === 'file' ? 'flex-start' : 'flex-end',
            }}
          >
            <Button
              type="submit"
              variant="primary"
            >
              {mode === 'test' ? 'Enqueue test' : 'Enqueue pull'}
            </Button>
          </div>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          Each Enqueue adds a new card below — runs are independent and can be cancelled
          individually.
        </div>
      </form>

      {error && (
        <div style={{ marginBottom: 12, borderRadius: 6, border: '1px solid var(--color-err)', backgroundColor: 'var(--color-surface-1)', padding: '8px 12px', fontSize: 14, color: 'var(--color-err)' }}>
          {error}
        </div>
      )}

      <section>
        <h2 style={{ marginBottom: 8, fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
          Queue ({activeCount})
        </h2>
        {cards.length === 0 ? (
          <EditorialHero
            title="No pulls yet"
            lede="Fill out the form above and hit Enqueue."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
