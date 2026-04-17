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

function ScopeTabs(): JSX.Element {
  const { scope, setScope } = useModelsStore();
  const tabs: { id: ScopeFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'builtin', label: 'Built-in' },
    { id: 'custom', label: 'Custom' },
  ];
  return (
    <div className="mb-4 flex gap-1 text-sm">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => setScope(tab.id)}
          className={
            tab.id === scope
              ? 'rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-[color:var(--color-fg)]'
              : 'rounded border border-transparent px-3 py-1 text-[color:var(--color-fg-muted)] hover:bg-[var(--color-surface-1)]'
          }
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export default function Models(): JSX.Element {
  const scope = useModelsStore((s) => s.scope);
  const catalog = trpc.catalogList.useQuery(scope);

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-1 text-xs uppercase tracking-widest text-[color:var(--color-fg-muted)]">
        Models
      </div>
      <h1 className="mb-4 text-2xl font-semibold text-[color:var(--color-fg)]">
        Catalog ({catalog.data?.length ?? 0})
      </h1>
      <ScopeTabs />
      <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
        <table className="w-full mono text-sm">
          <thead className="bg-[var(--color-surface-1)] text-left text-[color:var(--color-fg-muted)]">
            <tr>
              <th className="px-3 py-2 font-medium">Label</th>
              <th className="px-3 py-2 font-medium">Family</th>
              <th className="px-3 py-2 font-medium">Class</th>
              <th className="px-3 py-2 font-medium">Scope</th>
              <th className="px-3 py-2 font-medium">Rel</th>
            </tr>
          </thead>
          <tbody>
            {(catalog.data ?? []).map((row) => (
              <tr
                key={row.id}
                className="border-t border-[var(--color-border)] bg-[var(--color-surface-1)]"
              >
                <td className="px-3 py-2">{row.label}</td>
                <td className="px-3 py-2 text-[color:var(--color-fg-muted)]">{row.family}</td>
                <td className="px-3 py-2">{row.class}</td>
                <td className="px-3 py-2 text-[color:var(--color-fg-muted)]">{row.scope}</td>
                <td className="px-3 py-2 text-[color:var(--color-brand)] break-all">
                  {row.rel}
                </td>
              </tr>
            ))}
            {catalog.isSuccess && (catalog.data?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-[color:var(--color-fg-muted)]">
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
