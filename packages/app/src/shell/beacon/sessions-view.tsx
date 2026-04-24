import * as React from 'react';
import { TreeItem } from '@/ui';
import { useTabStore, type TabEntry } from '@/stores/tab-store';

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

  const all = React.useMemo(
    () => [...tabs, ...closed].sort((a, b) => b.openedAt - a.openedAt),
    [tabs, closed],
  );

  const now = Date.now();
  const today: TabEntry[] = [];
  const earlier: TabEntry[] = [];
  const older: TabEntry[] = [];
  for (const t of all) {
    const age = now - t.openedAt;
    if (age < 24 * 3_600_000) today.push(t);
    else if (age < 7 * 24 * 3_600_000) earlier.push(t);
    else older.push(t);
  }

  return (
    <div style={{ overflowY: 'auto', flex: 1 }}>
      <Group label="Today" items={today} onOpen={open} />
      <Group label="Earlier this week" items={earlier} onOpen={open} />
      <Group label="Older" items={older} onOpen={open} />
      {all.length === 0 && (
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
