import * as React from 'react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { trpc } from '@/lib/trpc';

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
    <div className="mb-4 flex gap-1 text-sm" role="tablist">
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
            className={
              isActive
                ? 'rounded border border-[var(--color-ok)] bg-[var(--color-surface-2)] px-3 py-1 font-medium text-[color:var(--color-text)]'
                : 'rounded border border-transparent px-3 py-1 text-[color:var(--color-text-secondary)] hover:bg-[var(--color-surface-1)] hover:text-[color:var(--color-text)]'
            }
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
    <div className="h-full overflow-auto p-6" data-testid="models-root">
      <div className="mb-1 text-xs uppercase tracking-widest text-[color:var(--color-text-secondary)]">
        Models
      </div>
      <h1 className="mb-4 text-2xl font-semibold text-[color:var(--color-text)]">
        Catalog ({catalog.data?.length ?? 0})
      </h1>
      <ScopeTabs />

      {error && (
        <div className="mb-3 rounded-md border border-[var(--color-err)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[color:var(--color-err)]">
          {error}
        </div>
      )}

      {report && (
        <div className="mb-3 rounded-md border border-[var(--color-ok)] bg-[var(--color-surface-1)] px-3 py-2 text-sm">
          <div className="mb-1 text-[color:var(--color-ok)]">
            Uninstalled {report.rel}
          </div>
          <ul className="mono text-xs text-[color:var(--color-text-secondary)]">
            {report.actions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
        <table className="w-full mono text-sm">
          <thead className="bg-[var(--color-surface-1)] text-left text-[color:var(--color-text-secondary)]">
            <tr>
              <th className="px-3 py-2 font-medium">Label</th>
              <th className="px-3 py-2 font-medium">Family</th>
              <th className="px-3 py-2 font-medium">Class</th>
              <th className="px-3 py-2 font-medium">Scope</th>
              <th className="px-3 py-2 font-medium">Rel</th>
              <th className="w-40 px-3 py-2 font-medium text-right"></th>
            </tr>
          </thead>
          <tbody>
            {(catalog.data ?? []).map((row) => {
              const isPending = pendingRel === row.rel;
              const needsForce = row.scope !== 'candidate';
              return (
                <tr
                  key={row.id}
                  className="border-t border-[var(--color-border)] bg-[var(--color-surface-1)]"
                >
                  <td className="px-3 py-2">{row.label}</td>
                  <td className="px-3 py-2 text-[color:var(--color-text-secondary)]">{row.family}</td>
                  <td className="px-3 py-2">{row.class}</td>
                  <td className="px-3 py-2 text-[color:var(--color-text-secondary)]">{row.scope}</td>
                  <td className="px-3 py-2 text-[color:var(--color-brand)] break-all">
                    {row.rel}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {row.installed &&
                      (isPending ? (
                        <span className="inline-flex items-center gap-1">
                          {needsForce && (
                            <label className="flex items-center gap-1 text-xs text-[color:var(--color-text-secondary)]">
                              <input
                                type="checkbox"
                                checked={force}
                                onChange={(e) => setForce(e.target.checked)}
                              />
                              force
                            </label>
                          )}
                          <button
                            type="button"
                            disabled={uninstallMutation.isPending}
                            onClick={() =>
                              uninstallMutation.mutate({ rel: row.rel, force })
                            }
                            className="rounded border border-[var(--color-err)] px-2 py-0.5 text-xs text-[color:var(--color-err)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
                          >
                            {uninstallMutation.isPending ? 'Removing…' : 'Confirm'}
                          </button>
                          <button
                            type="button"
                            disabled={uninstallMutation.isPending}
                            onClick={() => {
                              setPendingRel(null);
                              setForce(false);
                            }}
                            className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-[color:var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setPendingRel(row.rel);
                            setReport(null);
                            setError(null);
                          }}
                          className="rounded border border-transparent px-2 py-0.5 text-xs text-[color:var(--color-text-secondary)] hover:border-[var(--color-border)] hover:text-[color:var(--color-text)]"
                        >
                          Uninstall
                        </button>
                      ))}
                  </td>
                </tr>
              );
            })}
            {catalog.isSuccess && (catalog.data?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-[color:var(--color-text-secondary)]">
                  No entries for scope "{scope}".
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
