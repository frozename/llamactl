import * as React from 'react';
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';

/**
 * Preset gallery. Joins `promotions` (preset-overrides.tsv) with
 * `benchCompare` (bench history) so the operator sees at a glance
 *   * which rel is currently serving each (profile, preset) slot
 *   * the tok/s that rel actually delivered on its last bench
 *   * every other bench'd rel ranked by gen_tps
 * and can re-promote a faster candidate with one click.
 */

const PROFILES = ['mac-mini-16g', 'balanced', 'macbook-pro-48g'] as const;
const PRESETS = ['best', 'vision', 'balanced', 'fast'] as const;
type Profile = (typeof PROFILES)[number];
type Preset = (typeof PRESETS)[number];

type ClassFilter = 'all' | 'reasoning' | 'multimodal' | 'general' | 'custom';

function fmtTps(raw: string | undefined | null): string {
  if (raw == null || raw === '') return '—';
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(1);
}

export default function Presets(): React.JSX.Element {
  const queryClient = useQueryClient();
  const promotions = trpc.promotions.useQuery();
  const [classFilter, setClassFilter] = useState<ClassFilter>('all');
  const [minTps, setMinTps] = useState(0);
  const [installedOnly, setInstalledOnly] = useState(false);
  const bench = trpc.benchCompare.useQuery({ classFilter, scopeFilter: 'all' });

  // Inline promote controls — one row can be pending at a time.
  const [pendingRel, setPendingRel] = useState<string | null>(null);
  const [pickProfile, setPickProfile] = useState<Profile>('macbook-pro-48g');
  const [pickPreset, setPickPreset] = useState<Preset>('best');
  const [error, setError] = useState<string | null>(null);
  const [copiedRel, setCopiedRel] = useState<string | null>(null);

  const promoteMutation = trpc.promote.useMutation({
    onSuccess: async () => {
      setPendingRel(null);
      setError(null);
      await queryClient.invalidateQueries({
        queryKey: [['promotions'], { type: 'query' }],
      });
    },
    onError: (err) => setError(err.message),
  });

  const deleteMutation = trpc.promoteDelete.useMutation({
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({
        queryKey: [['promotions'], { type: 'query' }],
      });
    },
    onError: (err) => setError(err.message),
  });

  // Quick lookup: rel → latest gen_tps from the current bench query.
  const tpsByRel = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of bench.data ?? []) {
      const t = row.tuned?.gen_tps ? Number.parseFloat(row.tuned.gen_tps) : NaN;
      if (Number.isFinite(t) && t > 0) m.set(row.rel, t);
    }
    return m;
  }, [bench.data]);

  // Candidate list — bench rows sorted by gen_tps desc, with installed
  // rels first (within same tps bucket) so operators see what's already
  // on-disk at the top. Filtered by minTps + optional installedOnly.
  const candidates = useMemo(() => {
    const rows = [...(bench.data ?? [])];
    rows.sort((a, b) => {
      const ta = a.tuned?.gen_tps ? Number.parseFloat(a.tuned.gen_tps) : 0;
      const tb = b.tuned?.gen_tps ? Number.parseFloat(b.tuned.gen_tps) : 0;
      if (tb !== ta) return tb - ta;
      if (a.installed !== b.installed) return a.installed ? -1 : 1;
      return a.rel.localeCompare(b.rel);
    });
    return rows.filter((row) => {
      if (installedOnly && !row.installed) return false;
      if (minTps > 0) {
        const t = row.tuned?.gen_tps ? Number.parseFloat(row.tuned.gen_tps) : 0;
        if (!Number.isFinite(t) || t < minTps) return false;
      }
      return true;
    });
  }, [bench.data, minTps, installedOnly]);

  async function copyStartCommand(rel: string): Promise<void> {
    const cmd = `llamactl server start '${rel}'`;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedRel(rel);
      setTimeout(() => {
        setCopiedRel((cur) => (cur === rel ? null : cur));
      }, 2000);
    } catch {
      /* clipboard disallowed — operator can still copy manually */
    }
  }

  return (
    <div className="h-full overflow-auto p-6" data-testid="presets-root">
      <div className="mb-1 text-xs uppercase tracking-widest text-[color:var(--color-text-secondary)]">
        Presets
      </div>
      <h1 className="mb-4 text-2xl font-semibold text-[color:var(--color-text)]">
        Promotions &amp; candidates
      </h1>

      {error && (
        <div className="mb-3 rounded-md border border-[var(--color-err)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[color:var(--color-err)]">
          {error}
        </div>
      )}

      {/* Current promotions — (profile × preset) matrix. */}
      <section className="mb-6">
        <h2 className="mb-2 text-sm uppercase tracking-widest text-[color:var(--color-text-secondary)]">
          Current promotions
        </h2>
        <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
          <table className="w-full mono text-sm">
            <thead className="bg-[var(--color-surface-1)] text-left text-[color:var(--color-text-secondary)]">
              <tr>
                <th className="px-3 py-2 font-medium">Profile</th>
                {PRESETS.map((p) => (
                  <th key={p} className="px-3 py-2 font-medium">
                    {p}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PROFILES.map((profile) => (
                <tr key={profile} className="border-t border-[var(--color-border)] bg-[var(--color-surface-1)]">
                  <td className="px-3 py-2 text-[color:var(--color-text-secondary)]">{profile}</td>
                  {PRESETS.map((preset) => {
                    const row = (promotions.data ?? []).find(
                      (o) => o.profile === profile && o.preset === preset,
                    );
                    if (!row) {
                      return (
                        <td key={preset} className="px-3 py-2 text-[color:var(--color-text-secondary)]">
                          —
                        </td>
                      );
                    }
                    const tps = tpsByRel.get(row.rel);
                    return (
                      <td key={preset} className="px-3 py-2">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[color:var(--color-brand)] break-all">{row.rel}</span>
                          <div className="flex items-center gap-2 text-[10px] text-[color:var(--color-text-secondary)]">
                            {tps !== undefined ? (
                              <span>{tps.toFixed(1)} tok/s</span>
                            ) : (
                              <span>no bench</span>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                deleteMutation.mutate({ profile, preset })
                              }
                              disabled={deleteMutation.isPending}
                              className="rounded border border-transparent px-1 text-[10px] text-[color:var(--color-text-secondary)] hover:border-[var(--color-border)] hover:text-[color:var(--color-err)] disabled:opacity-50"
                              title={`remove promotion for ${profile}/${preset}`}
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Filters — all drive the candidate table below. */}
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm uppercase tracking-widest text-[color:var(--color-text-secondary)]">
            Candidates ({candidates.length})
          </h2>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1 text-[color:var(--color-text-secondary)]">
              min tok/s
              <input
                type="number"
                min={0}
                step={5}
                value={minTps}
                onChange={(e) => setMinTps(Math.max(0, Number.parseFloat(e.target.value) || 0))}
                data-testid="presets-min-tps"
                className="w-16 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 py-0.5 text-right font-mono text-[color:var(--color-text)]"
              />
            </label>
            <label className="flex items-center gap-1 text-[color:var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={installedOnly}
                onChange={(e) => setInstalledOnly(e.target.checked)}
                data-testid="presets-installed-only"
              />
              installed only
            </label>
            <span className="text-[color:var(--color-text-secondary)]">class</span>
            <select
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value as ClassFilter)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 font-mono text-[11px] text-[color:var(--color-text)]"
            >
              <option value="all">all</option>
              <option value="reasoning">reasoning</option>
              <option value="multimodal">multimodal</option>
              <option value="general">general</option>
              <option value="custom">custom</option>
            </select>
          </div>
        </div>

        <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
          <table className="w-full mono text-sm">
            <thead className="bg-[var(--color-surface-1)] text-left text-[color:var(--color-text-secondary)]">
              <tr>
                <th className="px-3 py-2 font-medium">Rel</th>
                <th className="px-3 py-2 font-medium">Class</th>
                <th className="px-3 py-2 font-medium">Installed</th>
                <th className="px-3 py-2 font-medium text-right">gen tok/s</th>
                <th className="px-3 py-2 font-medium text-right">prompt tok/s</th>
                <th className="w-20 px-3 py-2 font-medium text-right">Start</th>
                <th className="w-72 px-3 py-2 font-medium text-right">Promote</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((row) => {
                const isPending = pendingRel === row.rel;
                const gen = fmtTps(row.tuned?.gen_tps);
                const pt = fmtTps(row.tuned?.prompt_tps);
                return (
                  <tr
                    key={row.rel}
                    className="border-t border-[var(--color-border)] bg-[var(--color-surface-1)]"
                  >
                    <td className="px-3 py-2 text-[color:var(--color-brand)] break-all">{row.rel}</td>
                    <td className="px-3 py-2 text-[color:var(--color-text-secondary)]">{row.class}</td>
                    <td className="px-3 py-2 text-[color:var(--color-text-secondary)]">
                      {row.installed ? 'yes' : 'no'}
                    </td>
                    <td className="px-3 py-2 text-right">{gen}</td>
                    <td className="px-3 py-2 text-right text-[color:var(--color-text-secondary)]">{pt}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          void copyStartCommand(row.rel);
                        }}
                        data-testid={`presets-start-${row.rel}`}
                        title={`Copy: llamactl server start '${row.rel}'`}
                        className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[11px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text)]"
                      >
                        {copiedRel === row.rel ? 'copied' : 'start'}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isPending ? (
                        <span className="inline-flex items-center gap-1 text-[11px]">
                          <select
                            value={pickProfile}
                            onChange={(e) => setPickProfile(e.target.value as Profile)}
                            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 py-0.5 font-mono"
                          >
                            {PROFILES.map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </select>
                          <select
                            value={pickPreset}
                            onChange={(e) => setPickPreset(e.target.value as Preset)}
                            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 py-0.5 font-mono"
                          >
                            {PRESETS.map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            disabled={promoteMutation.isPending}
                            onClick={() =>
                              promoteMutation.mutate({
                                profile: pickProfile,
                                preset: pickPreset,
                                rel: row.rel,
                              })
                            }
                            className="rounded border border-[var(--color-ok)] px-2 py-0.5 text-[color:var(--color-ok)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
                          >
                            {promoteMutation.isPending ? 'Setting…' : 'Set'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingRel(null)}
                            className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[color:var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setPendingRel(row.rel);
                            setError(null);
                          }}
                          className="rounded border border-transparent px-2 py-0.5 text-xs text-[color:var(--color-text-secondary)] hover:border-[var(--color-border)] hover:text-[color:var(--color-text)]"
                        >
                          Promote to…
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {bench.isSuccess && candidates.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-[color:var(--color-text-secondary)]">
                    No candidates for class "{classFilter}".
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
