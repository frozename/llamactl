import * as React from 'react';
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';
import { Button, Input, EditorialHero } from '@/ui';

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
    <div style={{ height: '100%', overflow: 'auto', padding: 24 }} data-testid="models-presets-root">
      <div style={{ marginBottom: 4, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-secondary)' }}>
        Presets
      </div>
      <h1 style={{ marginBottom: 16, fontSize: 24, fontWeight: 600, color: 'var(--color-text)' }}>
        Promotions &amp; candidates
      </h1>

      {error && (
        <div style={{ marginBottom: 12, borderRadius: 6, border: '1px solid var(--color-err)', backgroundColor: 'var(--color-surface-1)', padding: '8px 12px', fontSize: 14, color: 'var(--color-err)' }}>
          {error}
        </div>
      )}

      {/* Current promotions — (profile × preset) matrix. */}
      <section style={{ marginBottom: 24 }}>
        <h2 style={{ marginBottom: 8, fontSize: 14, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-secondary)' }}>
          Current promotions
        </h2>
        <div style={{ overflow: 'hidden', borderRadius: 6, border: '1px solid var(--color-border)' }}>
          <table style={{ width: '100%', fontFamily: 'monospace', fontSize: 14 }}>
            <thead style={{ backgroundColor: 'var(--color-surface-1)', textAlign: 'left', color: 'var(--color-text-secondary)' }}>
              <tr>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>Profile</th>
                {PRESETS.map((p) => (
                  <th key={p} style={{ padding: '8px 12px', fontWeight: 500 }}>
                    {p}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PROFILES.map((profile) => (
                <tr key={profile} style={{ borderTop: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}>
                  <td style={{ padding: '8px 12px', color: 'var(--color-text-secondary)' }}>{profile}</td>
                  {PRESETS.map((preset) => {
                    const row = (promotions.data ?? []).find(
                      (o) => o.profile === profile && o.preset === preset,
                    );
                    if (!row) {
                      return (
                        <td key={preset} style={{ padding: '8px 12px', color: 'var(--color-text-secondary)' }}>
                          —
                        </td>
                      );
                    }
                    const tps = tpsByRel.get(row.rel);
                    return (
                      <td key={preset} style={{ padding: '8px 12px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ color: 'var(--color-brand)', wordBreak: 'break-all' }}>{row.rel}</span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: 'var(--color-text-secondary)' }}>
                            {tps !== undefined ? (
                              <span>{tps.toFixed(1)} tok/s</span>
                            ) : (
                              <span>no bench</span>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => deleteMutation.mutate({ profile, preset })}
                              disabled={deleteMutation.isPending}
                              style={{ fontSize: 10, padding: '2px 4px' }}
                              title={`remove promotion for ${profile}/${preset}`}
                            >
                              ×
                            </Button>
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
        <div style={{ marginBottom: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <h2 style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-secondary)' }}>
            Candidates ({candidates.length})
          </h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, fontSize: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-text-secondary)' }}>
              min tok/s
              <Input
                type="number"
                min={0}
                step={5}
                value={minTps}
                onChange={(e) => setMinTps(Math.max(0, Number.parseFloat(e.target.value) || 0))}
                data-testid="presets-min-tps"
                style={{ width: 64, textAlign: 'right', fontFamily: 'monospace' }}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-text-secondary)' }}>
              <input
                type="checkbox"
                checked={installedOnly}
                onChange={(e) => setInstalledOnly(e.target.checked)}
                data-testid="presets-installed-only"
              />
              installed only
            </label>
            <span style={{ color: 'var(--color-text-secondary)' }}>class</span>
            <select
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value as ClassFilter)}
              style={{
                borderRadius: 4,
                border: '1px solid var(--color-border)',
                backgroundColor: 'var(--color-surface-2)',
                padding: '4px 8px',
                fontFamily: 'monospace',
                fontSize: 11,
                color: 'var(--color-text)',
              }}
            >
              <option value="all">all</option>
              <option value="reasoning">reasoning</option>
              <option value="multimodal">multimodal</option>
              <option value="general">general</option>
              <option value="custom">custom</option>
            </select>
          </div>
        </div>

        <div style={{ overflow: 'hidden', borderRadius: 6, border: '1px solid var(--color-border)' }}>
          <table style={{ width: '100%', fontFamily: 'monospace', fontSize: 14 }}>
            <thead style={{ backgroundColor: 'var(--color-surface-1)', textAlign: 'left', color: 'var(--color-text-secondary)' }}>
              <tr>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>Rel</th>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>Class</th>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>Installed</th>
                <th style={{ padding: '8px 12px', fontWeight: 500, textAlign: 'right' }}>gen tok/s</th>
                <th style={{ padding: '8px 12px', fontWeight: 500, textAlign: 'right' }}>prompt tok/s</th>
                <th style={{ width: 80, padding: '8px 12px', fontWeight: 500, textAlign: 'right' }}>Start</th>
                <th style={{ width: 288, padding: '8px 12px', fontWeight: 500, textAlign: 'right' }}>Promote</th>
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
                    style={{ borderTop: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}
                  >
                    <td style={{ padding: '8px 12px', color: 'var(--color-brand)', wordBreak: 'break-all' }}>{row.rel}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--color-text-secondary)' }}>{row.class}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--color-text-secondary)' }}>
                      {row.installed ? 'yes' : 'no'}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>{gen}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--color-text-secondary)' }}>{pt}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          void copyStartCommand(row.rel);
                        }}
                        data-testid={`presets-start-${row.rel}`}
                        title={`Copy: llamactl server start '${row.rel}'`}
                        style={{ fontSize: 11, padding: '2px 8px' }}
                      >
                        {copiedRel === row.rel ? 'copied' : 'start'}
                      </Button>
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                      {isPending ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                          <select
                            value={pickProfile}
                            onChange={(e) => setPickProfile(e.target.value as Profile)}
                            style={{
                              borderRadius: 4,
                              border: '1px solid var(--color-border)',
                              backgroundColor: 'var(--color-surface-2)',
                              padding: '2px 4px',
                              fontFamily: 'monospace',
                            }}
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
                            style={{
                              borderRadius: 4,
                              border: '1px solid var(--color-border)',
                              backgroundColor: 'var(--color-surface-2)',
                              padding: '2px 4px',
                              fontFamily: 'monospace',
                            }}
                          >
                            {PRESETS.map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </select>
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={promoteMutation.isPending}
                            onClick={() =>
                              promoteMutation.mutate({
                                profile: pickProfile,
                                preset: pickPreset,
                                rel: row.rel,
                              })
                            }
                            style={{ padding: '2px 8px' }}
                          >
                            {promoteMutation.isPending ? 'Setting…' : 'Set'}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setPendingRel(null)}
                            style={{ padding: '2px 8px' }}
                          >
                            Cancel
                          </Button>
                        </span>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setPendingRel(row.rel);
                            setError(null);
                          }}
                        >
                          Promote to…
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {bench.isSuccess && candidates.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--color-text-secondary)' }}>
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
