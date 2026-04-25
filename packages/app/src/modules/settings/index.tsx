import * as React from 'react';
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { schemas } from '@llamactl/core';
import { trpc } from '@/lib/trpc';

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
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        Preset promotions ({rows.length})
      </h2>

      {error && (
        <div className="mb-3 rounded-md border border-[var(--color-err)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[color:var(--color-err)]">
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="mb-4 rounded-md border border-dashed border-[var(--color-border)] p-4 text-[color:var(--color-text-secondary)]">
          No active promotions. Use the form below or{' '}
          <span className="mono">llamactl catalog promote</span> to add one.
        </div>
      ) : (
        <div className="mb-4 overflow-hidden rounded-md border border-[var(--color-border)]">
          <table className="w-full mono text-sm">
            <thead className="bg-[var(--color-surface-1)] text-left text-[color:var(--color-text-secondary)]">
              <tr>
                <th className="px-3 py-2 font-medium">Profile</th>
                <th className="px-3 py-2 font-medium">Preset</th>
                <th className="px-3 py-2 font-medium">Rel</th>
                <th className="px-3 py-2 font-medium">Updated</th>
                <th className="w-28 px-3 py-2 font-medium text-right"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p: PresetOverride) => {
                const key = `${p.profile}:${p.preset}`;
                const isPending = pendingDelete === key;
                return (
                  <tr
                    key={key}
                    className="border-t border-[var(--color-border)] bg-[var(--color-surface-1)]"
                  >
                    <td className="px-3 py-2 text-[color:var(--color-brand)]">{p.profile}</td>
                    <td className="px-3 py-2">{p.preset}</td>
                    <td className="px-3 py-2 text-[color:var(--color-ok)] break-all">
                      {p.rel}
                    </td>
                    <td className="px-3 py-2 text-[color:var(--color-text-secondary)]">
                      {p.updated_at ?? ''}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isPending ? (
                        <span className="inline-flex gap-1">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              deleteMutation.mutate({
                                profile: p.profile as Profile,
                                preset: p.preset as Preset,
                              })
                            }
                            className="rounded border border-[var(--color-err)] px-2 py-0.5 text-xs text-[color:var(--color-err)] hover:bg-[var(--color-surface-2)]"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setPendingDelete(null)}
                            className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-[color:var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setPendingDelete(key)}
                          className="rounded border border-transparent px-2 py-0.5 text-xs text-[color:var(--color-text-secondary)] hover:border-[var(--color-border)] hover:text-[color:var(--color-text)]"
                          aria-label={`Remove promotion ${key}`}
                        >
                          Remove
                        </button>
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
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
      >
        <div className="mb-3 text-xs uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          Add / update promotion
        </div>
        <div className="grid grid-cols-12 gap-3">
          <label className="col-span-3 text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">Profile</span>
            <select
              value={profile}
              onChange={(e) => setProfile(e.target.value as Profile)}
              disabled={busy}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono"
            >
              {PROFILES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-2 text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">Preset</span>
            <select
              value={preset}
              onChange={(e) => setPreset(e.target.value as Preset)}
              disabled={busy}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono"
            >
              {PRESETS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-5 text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">Rel</span>
            <input
              list="rel-suggestions"
              value={rel}
              onChange={(e) => setRel(e.target.value)}
              disabled={busy}
              placeholder="e.g. gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono"
            />
            <datalist id="rel-suggestions">
              {rels.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>
          <div className="col-span-2 flex items-end">
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded bg-[var(--color-brand)] px-3 py-1 text-sm font-medium text-[color:var(--color-surface-0)] hover:opacity-90 disabled:opacity-50"
            >
              {promoteMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
        <div className="mt-3 text-xs text-[color:var(--color-text-secondary)]">
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
    return <div className="p-6 text-[color:var(--color-text-secondary)]">Loading…</div>;
  }
  const values = (env.data ?? {}) as Record<string, string>;

  return (
    <div className="h-full overflow-auto p-6" data-testid="settings-root">
      <div className="mb-1 text-xs uppercase tracking-widest text-[color:var(--color-text-secondary)]">
        Settings
      </div>
      <h1 className="mb-2 text-2xl font-semibold text-[color:var(--color-text)]">Environment</h1>
      <p className="mb-6 text-xs text-[color:var(--color-text-secondary)]">
        Read-only snapshot of the shell environment llamactl is running under. Values
        come from your shell (e.g. <span className="mono">LLAMA_CPP_MODELS</span>) and
        <span className="mono"> ~/.llamactl/env</span>; rows marked
        <span className="text-[color:var(--color-text-secondary)]"> unset</span> fall back to defaults.
      </p>

      <div className="space-y-6">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
              {group.title}
            </h2>
            <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
              <table className="w-full mono text-sm">
                <tbody>
                  {group.keys.map((key) => {
                    const raw = values[key];
                    const isSet = raw !== undefined && raw !== '';
                    return (
                      <tr
                        key={key}
                        data-testid={`env-${key}`}
                        data-set={isSet ? 'true' : 'false'}
                        className="border-b border-[var(--color-border)] last:border-b-0 bg-[var(--color-surface-1)]"
                      >
                        <td className="w-72 px-3 py-1.5 text-[color:var(--color-text-secondary)]">
                          {key}
                        </td>
                        <td
                          className={
                            isSet
                              ? 'px-3 py-1.5 text-[color:var(--color-text)] break-all'
                              : 'px-3 py-1.5 text-[color:var(--color-text-secondary)]'
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
