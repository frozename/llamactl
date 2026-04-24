import * as React from 'react';
import { RAIL_VIEWS, type RailViewId } from './rail-views';
import { cx } from '@/ui';

interface ActivityRailProps {
  activeView: RailViewId;
  onChange: (next: RailViewId) => void;
}

/**
 * 56 px left rail — the Beacon view switcher. Top group = Explorer /
 * Search / Sessions / Fleet / Tokens. Bottom group = Cost / Settings.
 * Active button has brand-ghost background + 2 px brand indicator on
 * the left edge.
 */
export function ActivityRail({ activeView, onChange }: ActivityRailProps): React.JSX.Element {
  const top = RAIL_VIEWS.filter((v) => v.position === 'top');
  const bottom = RAIL_VIEWS.filter((v) => v.position === 'bottom');

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
      {top.map((v) => <RailButton key={v.id} view={v} active={v.id === activeView} onChange={onChange} />)}
      <div style={{ flex: 1 }} />
      {bottom.map((v) => <RailButton key={v.id} view={v} active={v.id === activeView} onChange={onChange} />)}
    </div>
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
      data-testid={`bcn-rail-${view.id}`}
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
