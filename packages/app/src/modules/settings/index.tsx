import * as React from 'react';
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { schemas } from '@llamactl/core';
import { trpc } from '@/lib/trpc';
import { Button, Input } from '@/ui';

type PresetOverride = schemas.PresetOverride;
type Profile = 'mac-mini-16g' | 'balanced' | 'macbook-pro-48g';
type Preset = 'best' | 'vision' | 'balanced' | 'fast';

const PROFILES: readonly Profile[] = ['mac-mini-16g', 'balanced', 'macbook-pro-48g'];
const PRESETS: readonly Preset[] = ['best', 'vision', 'balanced', 'fast'];

const GROUPS: { title: string; keys: string[] }[] = [
  {
    title: 'Paths',
    keys: [
      'DEV_STORAGE',
      'LLAMA_CPP_ROOT',
      'LLAMA_CPP_MODELS',
      'LLAMA_CPP_CACHE',
      'LLAMA_CPP_LOGS',
      'LLAMA_CPP_BIN',
      'LOCAL_AI_RUNTIME_DIR',
      'HF_HOME',
      'OLLAMA_MODELS',
    ],
  },
  {
    title: 'Machine',
    keys: [
      'LLAMA_CPP_MACHINE_PROFILE',
      'LLAMA_CPP_DEFAULT_MODEL',
      'LLAMA_CPP_GEMMA_CTX_SIZE',
      'LLAMA_CPP_QWEN_CTX_SIZE',
    ],
  },
  {
    title: 'Provider',
    keys: [
      'LOCAL_AI_PROVIDER',
      'LOCAL_AI_PROVIDER_URL',
      'LOCAL_AI_MODEL',
      'LOCAL_AI_SOURCE_MODEL',
      'LOCAL_AI_CONTEXT_LENGTH',
    ],
  },
  {
    title: 'Discovery',
    keys: [
      'LOCAL_AI_DISCOVERY_AUTHOR',
      'LOCAL_AI_DISCOVERY_LIMIT',
      'LOCAL_AI_DISCOVERY_SEARCH',
      'LOCAL_AI_RECOMMENDATIONS_SOURCE',
      'LOCAL_AI_HF_CACHE_TTL_SECONDS',
    ],
  },
  {
    title: 'Feature toggles',
    keys: [
      'LLAMA_CPP_AUTO_TUNE_ON_PULL',
      'LLAMA_CPP_AUTO_BENCH_VISION',
      'LOCAL_AI_ENABLE_THINKING',
      'LOCAL_AI_PRESERVE_THINKING',
    ],
  },
];

function PromotionsEditor(): React.JSX.Element {
  const queryClient = useQueryClient();
  const promotions = trpc.promotions.useQuery();
  const catalog = trpc.catalogList.useQuery('all');

  const [profile, setProfile] = useState<Profile>('macbook-pro-48g');
  const [preset, setPreset] = useState<Preset>('best');
  const [rel, setRel] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: [['promotions'], { type: 'query' }],
    });
  };

  const promoteMutation = trpc.promote.useMutation({
    onSuccess: async () => {
      setRel('');
      setError(null);
      await invalidate();
    },
    onError: (err) => setError(err.message),
  });
  const deleteMutation = trpc.promoteDelete.useMutation({
    onSuccess: async () => {
      setPendingDelete(null);
      await invalidate();
    },
    onError: (err) => setError(err.message),
  });

  const rels = useMemo(
    () => (catalog.data ?? []).map((row) => row.rel),
    [catalog.data],
  );

  const handleSubmit = (): void => {
    setError(null);
    if (rel.trim().length === 0) {
      setError('Rel is required');
      return;
    }
    promoteMutation.mutate({ profile, preset, rel: rel.trim() });
  };

  const rows = promotions.data ?? [];
  const busy = promoteMutation.isPending || deleteMutation.isPending;

  return (
    <section>
      <h2 style={{ marginBottom: 8, fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.025em', color: 'var(--color-text-secondary)' }}>
        Preset promotions ({rows.length})
      </h2>

      {error && (
        <div style={{ marginBottom: 12, borderRadius: 6, border: '1px solid var(--color-err)', background: 'var(--color-surface-1)', padding: '8px 12px', fontSize: 14, color: 'var(--color-err)' }}>
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{ marginBottom: 16, borderRadius: 6, border: '1px dashed var(--color-border)', padding: 16, color: 'var(--color-text-secondary)' }}>
          No active promotions. Use the form below or{' '}
          <span style={{ fontFamily: 'var(--font-mono)' }}>llamactl catalog promote</span> to add one.
        </div>
      ) : (
        <div style={{ marginBottom: 16, overflow: 'hidden', borderRadius: 6, border: '1px solid var(--color-border)' }}>
          <table style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 14, borderCollapse: 'collapse' }}>
            <thead style={{ background: 'var(--color-surface-1)', textAlign: 'left', color: 'var(--color-text-secondary)' }}>
              <tr>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>Profile</th>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>Preset</th>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>Rel</th>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>Updated</th>
                <th style={{ width: 112, padding: '8px 12px', fontWeight: 500, textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p: PresetOverride) => {
                const key = `${p.profile}:${p.preset}`;
                const isPending = pendingDelete === key;
                return (
                  <tr
                    key={key}
                    style={{ borderTop: '1px solid var(--color-border)', background: 'var(--color-surface-1)' }}
                  >
                    <td style={{ padding: '8px 12px', color: 'var(--color-brand)' }}>{p.profile}</td>
                    <td style={{ padding: '8px 12px' }}>{p.preset}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--color-ok)', wordBreak: 'break-all' }}>
                      {p.rel}
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--color-text-secondary)' }}>
                      {p.updated_at ?? ''}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                      {isPending ? (
                        <span style={{ display: 'inline-flex', gap: 4 }}>
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              deleteMutation.mutate({
                                profile: p.profile as Profile,
                                preset: p.preset as Preset,
                              })
                            }
                          >
                            Confirm
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => setPendingDelete(null)}
                          >
                            Cancel
                          </Button>
                        </span>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setPendingDelete(key)}
                          aria-label={`Remove promotion ${key}`}
                        >
                          Remove
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
        style={{ borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-surface-1)', padding: 16 }}
      >
        <div style={{ marginBottom: 12, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.025em', color: 'var(--color-text-secondary)' }}>
          Add / update promotion
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 12 }}>
          <label style={{ gridColumn: 'span 3 / span 3', fontSize: 14 }}>
            <span style={{ marginBottom: 4, display: 'block', fontSize: 12, color: 'var(--color-text-secondary)' }}>Profile</span>
            <select
              value={profile}
              onChange={(e) => setProfile(e.target.value as Profile)}
              disabled={busy}
              style={{ width: '100%', borderRadius: 4, border: '1px solid var(--color-border)', background: 'var(--color-surface-2)', padding: '4px 8px', fontFamily: 'var(--font-mono)' }}
            >
              {PROFILES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label style={{ gridColumn: 'span 2 / span 2', fontSize: 14 }}>
            <span style={{ marginBottom: 4, display: 'block', fontSize: 12, color: 'var(--color-text-secondary)' }}>Preset</span>
            <select
              value={preset}
              onChange={(e) => setPreset(e.target.value as Preset)}
              disabled={busy}
              style={{ width: '100%', borderRadius: 4, border: '1px solid var(--color-border)', background: 'var(--color-surface-2)', padding: '4px 8px', fontFamily: 'var(--font-mono)' }}
            >
              {PRESETS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label style={{ gridColumn: 'span 5 / span 5', fontSize: 14 }}>
            <span style={{ marginBottom: 4, display: 'block', fontSize: 12, color: 'var(--color-text-secondary)' }}>Rel</span>
            <Input
              list="rel-suggestions"
              value={rel}
              onChange={(e) => setRel(e.target.value)}
              disabled={busy}
              placeholder="e.g. gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
            <datalist id="rel-suggestions">
              {rels.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>
          <div style={{ gridColumn: 'span 2 / span 2', display: 'flex', alignItems: 'flex-end' }}>
            <Button
              type="submit"
              variant="primary"
              disabled={busy}
              style={{ width: '100%' }}
            >
              {promoteMutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          Existing (profile, preset) pairs are replaced in place. Rels autocomplete from the
          catalog.
        </div>
      </form>
    </section>
  );
}

export default function Settings(): React.JSX.Element {
  const env = trpc.env.useQuery();

  if (env.isLoading) {
    return <div style={{ padding: 24, color: 'var(--color-text-secondary)' }}>Loading…</div>;
  }
  const values = (env.data ?? {}) as Record<string, string>;

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 24 }} data-testid="settings-root">
      <div style={{ marginBottom: 4, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-secondary)' }}>
        Settings
      </div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600, color: 'var(--color-text)' }}>Environment</h1>
      <p style={{ marginBottom: 24, fontSize: 12, color: 'var(--color-text-secondary)' }}>
        Read-only snapshot of the shell environment llamactl is running under. Values
        come from your shell (e.g. <span style={{ fontFamily: 'var(--font-mono)' }}>LLAMA_CPP_MODELS</span>) and
        <span style={{ fontFamily: 'var(--font-mono)' }}> ~/.llamactl/env</span>; rows marked
        <span style={{ color: 'var(--color-text-secondary)' }}> unset</span> fall back to defaults.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h2 style={{ marginBottom: 8, fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.025em', color: 'var(--color-text-secondary)' }}>
              {group.title}
            </h2>
            <div style={{ overflow: 'hidden', borderRadius: 6, border: '1px solid var(--color-border)' }}>
              <table style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 14, borderCollapse: 'collapse' }}>
                <tbody>
                  {group.keys.map((key, idx) => {
                    const raw = values[key];
                    const isSet = raw !== undefined && raw !== '';
                    return (
                      <tr
                        key={key}
                        data-testid={`env-${key}`}
                        data-set={isSet ? 'true' : 'false'}
                        style={{
                          borderBottom: idx === group.keys.length - 1 ? 'none' : '1px solid var(--color-border)',
                          background: 'var(--color-surface-1)'
                        }}
                      >
                        <td style={{ width: 288, padding: '6px 12px', color: 'var(--color-text-secondary)' }}>
                          {key}
                        </td>
                        <td
                          style={
                            isSet
                              ? { padding: '6px 12px', color: 'var(--color-text)', wordBreak: 'break-all' }
                              : { padding: '6px 12px', color: 'var(--color-text-secondary)' }
                          }
                        >
                          {isSet ? raw : 'unset'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))}

        <PromotionsEditor />
      </div>
    </div>
  );
}
