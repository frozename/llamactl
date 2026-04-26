import * as React from 'react';
import { Input, Kbd } from '@/ui';
import { Search as SearchIcon } from 'lucide-react';
import { useTabStore } from '@/stores/tab-store';
import { useGlobalSearch } from '@/lib/global-search/hooks/use-global-search';
import { SearchResultsTree } from './search-results-tree';
import type { Hit } from '@/lib/global-search/types';
import { trpcUIClient } from '@/lib/trpc';

export function SearchView(): React.JSX.Element {
  const [q, setQ] = React.useState('');
  const open = useTabStore((s) => s.open);
  const { results, status } = useGlobalSearch(q);
  const [connectedNode, setConnectedNode] = React.useState<string | undefined>();
  React.useEffect(() => {
    trpcUIClient.uiGetActiveNode.query().then((res) => setConnectedNode(res.name || undefined)).catch(() => {});
  }, []);

  const onActivate = React.useCallback(
    (hit: Hit) => {
      if (hit.action.kind === 'open-tab') open(hit.action.tab);
    },
    [open],
  );

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
          placeholder="Search everything…"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          autoFocus
        />
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {q.trim() === '' ? (
          <div
            style={{
              padding: '12px 18px',
              color: 'var(--color-text-tertiary)',
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            Type to search across modules, ops sessions, workloads, knowledge, logs, and more. Use{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>session:</code>,{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>module:</code>, or{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>kb:</code> to filter to one surface. Or use
            the palette (<Kbd compact>⌘⇧P</Kbd>) for quick jumps.
          </div>
        ) : results.length === 0 && status === 'idle' ? (
          <div
            style={{
              padding: '12px 18px',
              color: 'var(--color-text-tertiary)',
              fontSize: 12,
            }}
          >
            No results.
          </div>
        ) : (
          <SearchResultsTree results={results} onActivate={onActivate} connectedNode={connectedNode} />
        )}
      </div>
    </div>
  );
}
