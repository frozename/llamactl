import * as React from 'react';
import { TreeItem } from '@/ui';
import { useTabStore, type TabEntry } from '@/stores/tab-store';
import { bucketTabsByAge } from './session-buckets';

/**
 * Recent tabs, grouped by age buckets (today / earlier this week /
 * older) based on openedAt. Merges currently-open tabs with the
 * closed-tab LRU so there's always something to look at. A fuller
 * session-replay view — with chat transcripts and ops timelines —
 * ships post-renewal.
 */
export function SessionsView(): React.JSX.Element {
  const tabs = useTabStore((s) => s.tabs);
  const closed = useTabStore((s) => s.closed);
  const open = useTabStore((s) => s.open);

  const { today, earlier, older } = React.useMemo(
    () => bucketTabsByAge(tabs, closed, Date.now()),
    [tabs, closed],
  );
  const total = today.length + earlier.length + older.length;

  return (
    <div role="tree" style={{ overflowY: 'auto', flex: 1 }}>
      <Group label="Today" items={today} onOpen={open} />
      <Group label="Earlier this week" items={earlier} onOpen={open} />
      <Group label="Older" items={older} onOpen={open} />
      {total === 0 && (
        <div
          style={{
            padding: '14px 18px',
            color: 'var(--color-text-tertiary)',
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          No recent sessions yet. Open a tab from the Explorer and it shows up here.
        </div>
      )}
    </div>
  );
}

function Group({
  label,
  items,
  onOpen,
}: {
  label: string;
  items: TabEntry[];
  onOpen: (entry: TabEntry) => void;
}): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div>
      <h3
        style={{
          padding: '10px 18px 4px',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-text-tertiary)',
          margin: 0,
          fontWeight: 500,
        }}
      >
        {label}
      </h3>
      {items.map((t) => (
        <TreeItem
          key={`${t.tabKey}:${t.openedAt}`}
          label={t.title}
          trailing={
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--color-text-tertiary)',
              }}
            >
              {t.kind}
            </span>
          }
          onClick={() => onOpen({ ...t, openedAt: Date.now() })}
        />
      ))}
    </div>
  );
}
