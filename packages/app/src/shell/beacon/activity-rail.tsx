import * as React from 'react';
import { Coins, Settings as SettingsIcon, type LucideIcon } from 'lucide-react';
import { RAIL_VIEWS, type RailViewId } from './rail-views';
import { useTabStore } from '@/stores/tab-store';
import { cx } from '@/ui';

interface ActivityRailProps {
  activeView: RailViewId;
  onChange: (next: RailViewId) => void;
}

interface TabOpener {
  id: 'cost' | 'settings';
  label: string;
  icon: LucideIcon;
}

const BOTTOM_TAB_OPENERS: readonly TabOpener[] = [
  { id: 'cost',     label: 'Cost',     icon: Coins },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

/**
 * 56 px left rail. Top group = rail-views (Explorer / Search / Sessions /
 * Fleet) which swap the panel content. Bottom group = tab-openers (Cost /
 * Settings) which open the corresponding module tab directly — they don't
 * touch the rail-view state. Active rail-view gets a brand-ghost background
 * + 2 px brand indicator on the left edge.
 */
export function ActivityRail({ activeView, onChange }: ActivityRailProps): React.JSX.Element {
  const open = useTabStore((s) => s.open);
  const activeKey = useTabStore((s) => s.activeKey);

  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      className={cx('bcn-rail')}
      style={{
        width: 56,
        background: 'var(--color-surface-1)',
        borderRight: '1px solid var(--color-border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '12px 0',
        gap: 4,
      }}
    >
      {RAIL_VIEWS.map((v) => (
        <RailButton key={v.id} view={v} active={v.id === activeView} onChange={onChange} />
      ))}
      <div style={{ flex: 1 }} />
      {BOTTOM_TAB_OPENERS.map((m) => (
        <TabOpenerButton
          key={m.id}
          opener={m}
          active={activeKey === `module:${m.id}`}
          onOpen={() =>
            open({ tabKey: `module:${m.id}`, title: m.label, kind: 'module', openedAt: Date.now() })
          }
        />
      ))}
    </div>
  );
}

function TabOpenerButton({
  opener,
  active,
  onOpen,
}: {
  opener: TabOpener;
  active: boolean;
  onOpen: () => void;
}): React.JSX.Element {
  const Icon = opener.icon;
  return (
    <button
      type="button"
      aria-label={opener.label}
      title={opener.label}
      onClick={onOpen}
      data-testid={`rail-icon-${opener.id}`}
      style={{
        width: 40,
        height: 40,
        display: 'grid',
        placeItems: 'center',
        borderRadius: 'var(--r-lg)',
        border: 'none',
        cursor: 'pointer',
        color: active ? 'var(--color-brand)' : 'var(--color-text-tertiary)',
        background: active ? 'var(--color-brand-ghost)' : 'transparent',
        position: 'relative',
        transition: 'background 160ms, color 160ms',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'var(--color-surface-2)';
          e.currentTarget.style.color = 'var(--color-text)';
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--color-text-tertiary)';
        }
      }}
    >
      <Icon size={18} strokeWidth={1.75} />
    </button>
  );
}

function RailButton({ view, active, onChange }: { view: typeof RAIL_VIEWS[number]; active: boolean; onChange: (id: RailViewId) => void }): React.JSX.Element {
  const Icon = view.icon;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={view.label}
      title={view.label}
      onClick={() => onChange(view.id)}
      data-testid={`rail-icon-${view.id}`}
      style={{
        width: 40,
        height: 40,
        display: 'grid',
        placeItems: 'center',
        borderRadius: 'var(--r-lg)',
        border: 'none',
        cursor: 'pointer',
        color: active ? 'var(--color-brand)' : 'var(--color-text-tertiary)',
        background: active ? 'var(--color-brand-ghost)' : 'transparent',
        position: 'relative',
        transition: 'background 160ms, color 160ms',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'var(--color-surface-2)';
          e.currentTarget.style.color = 'var(--color-text)';
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--color-text-tertiary)';
        }
      }}
    >
      {active && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: -8,
            top: 8,
            bottom: 8,
            width: 2,
            background: 'var(--color-brand)',
            borderRadius: 2,
          }}
        />
      )}
      <Icon size={18} strokeWidth={1.75} />
    </button>
  );
}
