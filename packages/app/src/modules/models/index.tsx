import * as React from 'react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { trpc } from '@/lib/trpc';
import { Button, EditorialHero } from '@/ui';

type ScopeFilter = 'all' | 'builtin' | 'custom';

interface ModelsStore {
  scope: ScopeFilter;
  setScope: (s: ScopeFilter) => void;
}

/**
 * Per-module store: UI state local to the Models view. Kept in its own
 * file so feature slices stay isolated (matches the novaflow pattern).
 */
export const useModelsStore = create<ModelsStore>()(
  persist(
    (set) => ({
      scope: 'all',
      setScope: (s) => set({ scope: s }),
    }),
    { name: 'llamactl-models' },
  ),
);

function ScopeTabs(): React.JSX.Element {
  const { scope, setScope } = useModelsStore();
  const tabs: { id: ScopeFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'builtin', label: 'Built-in' },
    { id: 'custom', label: 'Custom' },
  ];
  return (
    <div style={{ marginBottom: 16, display: 'flex', gap: 4, fontSize: 14 }} role="tablist">
      {tabs.map((tab) => {
        const isActive = tab.id === scope;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-testid={`models-scope-${tab.id}`}
            data-active={isActive ? 'true' : 'false'}
            onClick={() => setScope(tab.id)}
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
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

interface UninstallReport {
  rel: string;
  code: number;
  error?: string;
  actions: string[];
}

export default function Models(): React.JSX.Element {
  const queryClient = useQueryClient();
  const scope = useModelsStore((s) => s.scope);
  const catalog = trpc.catalogList.useQuery(scope);

  const [pendingRel, setPendingRel] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [report, setReport] = useState<UninstallReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const uninstallMutation = trpc.uninstall.useMutation({
    onSuccess: async (result) => {
      setPendingRel(null);
      setForce(false);
      if (result.code === 0) {
        setReport(result);
        setError(null);
      } else {
        setReport(null);
        setError(result.error ?? `Uninstall refused (code=${result.code})`);
      }
      await queryClient.invalidateQueries({
        queryKey: [['catalogList'], { type: 'query' }],
      });
      await queryClient.invalidateQueries({
        queryKey: [['promotions'], { type: 'query' }],
      });
    },
    onError: (err) => {
      setPendingRel(null);
      setForce(false);
      setError(err.message);
    },
  });

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 24 }} data-testid="models-catalog-root">
      <div style={{ marginBottom: 4, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-secondary)' }}>
        Models
      </div>
      <h1 style={{ marginBottom: 16, fontSize: 24, fontWeight: 600, color: 'var(--color-text)' }}>
        Catalog ({catalog.data?.length ?? 0})
      </h1>
      <ScopeTabs />

      {error && (
        <div style={{ marginBottom: 12, borderRadius: 6, border: '1px solid var(--color-err)', backgroundColor: 'var(--color-surface-1)', padding: '8px 12px', fontSize: 14, color: 'var(--color-err)' }}>
          {error}
        </div>
      )}

      {report && (
        <div style={{ marginBottom: 12, borderRadius: 6, border: '1px solid var(--color-ok)', backgroundColor: 'var(--color-surface-1)', padding: '8px 12px', fontSize: 14 }}>
          <div style={{ marginBottom: 4, color: 'var(--color-ok)' }}>
            Uninstalled {report.rel}
          </div>
          <ul style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {report.actions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}

      {catalog.isSuccess && (catalog.data?.length ?? 0) === 0 ? (
        <EditorialHero title={`No entries for scope "${scope}"`} lede="Pull a new model to see it here." />
      ) : (
        <div style={{ overflow: 'hidden', borderRadius: 6, border: '1px solid var(--color-border)' }}>
          <table style={{ width: '100%', fontFamily: 'monospace', fontSize: 14 }}>
            <thead style={{ backgroundColor: 'var(--color-surface-1)', textAlign: 'left', color: 'var(--color-text-secondary)' }}>
              <tr>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>Label</th>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>Family</th>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>Class</th>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>Scope</th>
                <th style={{ padding: '8px 12px', fontWeight: 500 }}>Rel</th>
                <th style={{ width: 160, padding: '8px 12px', fontWeight: 500, textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {(catalog.data ?? []).map((row) => {
                const isPending = pendingRel === row.rel;
                const needsForce = row.scope !== 'candidate';
                return (
                  <tr
                    key={row.id}
                    style={{ borderTop: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}
                  >
                    <td style={{ padding: '8px 12px' }}>{row.label}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--color-text-secondary)' }}>{row.family}</td>
                    <td style={{ padding: '8px 12px' }}>{row.class}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--color-text-secondary)' }}>{row.scope}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--color-brand)', wordBreak: 'break-all' }}>
                      {row.rel}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                      {row.installed &&
                        (isPending ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            {needsForce && (
                              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                                <input
                                  type="checkbox"
                                  checked={force}
                                  onChange={(e) => setForce(e.target.checked)}
                                />
                                force
                              </label>
                            )}
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={uninstallMutation.isPending}
                              onClick={() =>
                                uninstallMutation.mutate({ rel: row.rel, force })
                              }
                            >
                              {uninstallMutation.isPending ? 'Removing…' : 'Confirm'}
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={uninstallMutation.isPending}
                              onClick={() => {
                                setPendingRel(null);
                                setForce(false);
                              }}
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
                              setReport(null);
                              setError(null);
                            }}
                          >
                            Uninstall
                          </Button>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}