import * as React from 'react';
import { Input, TreeItem, Kbd } from '@/ui';
import { Search as SearchIcon } from 'lucide-react';
import { APP_MODULES } from '@/modules/registry';
import { useTabStore } from '@/stores/tab-store';

/**
 * Global search across static modules. Rank by substring match in
 * labelKey + aliases + id. Selecting a row opens it as a tab. Live
 * workloads / nodes / logs are not in scope yet — the fuller
 * "search everything" query ships post-renewal.
 */
export function SearchView(): React.JSX.Element {
  const [q, setQ] = React.useState('');
  const open = useTabStore((s) => s.open);

  const results = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return APP_MODULES.filter((m) => m.beaconGroup && m.beaconGroup !== 'hidden')
      .map((m) => {
        const hay = [m.labelKey, ...(m.aliases ?? []), m.id].join(' ').toLowerCase();
        const score = hay.includes(needle)
          ? m.labelKey.toLowerCase().startsWith(needle)
            ? 2
            : 1
          : 0;
        return { m, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.m.labelKey.localeCompare(b.m.labelKey))
      .slice(0, 30);
  }, [q]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '10px 14px' }}>
        <Input
          leadingSlot={<SearchIcon size={12} />}
          placeholder="Search modules…"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          autoFocus
        />
      </div>
      <div role="tree" style={{ padding: '0 0 12px', overflowY: 'auto', flex: 1 }}>
        {q.trim() === '' && (
          <div
            style={{
              padding: '12px 18px',
              color: 'var(--color-text-tertiary)',
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            Type to search modules. For fuzzy matching with aliases, the command palette (
            <Kbd compact>⌘⇧P</Kbd>) is still the pro move.
          </div>
        )}
        {results.map(({ m }) => (
          <TreeItem
            key={m.id}
            label={m.labelKey}
            trailing={
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--color-text-tertiary)',
                }}
              >
                {m.beaconGroup}
              </span>
            }
            onClick={() =>
              open({
                tabKey: `module:${m.id}`,
                title: m.labelKey,
                kind: 'module',
                openedAt: Date.now(),
              })
            }
          />
        ))}
      </div>
    </div>
  );
}
