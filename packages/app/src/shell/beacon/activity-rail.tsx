import * as React from 'react';
import { RAIL_VIEWS, type RailViewId } from './rail-views';
import { APP_MODULES } from '@/modules/registry';
import { useTabStore } from '@/stores/tab-store';
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
 *
 * Below the rail-view icons, module activity-bar buttons are rendered
 * for every APP_MODULES entry with `activityBar: true`. These buttons
 * open the corresponding tab directly, giving smoke tests a stable
 * click target (`data-testid="activity-bar-{id}"`).
 */
export function ActivityRail({ activeView, onChange }: ActivityRailProps): React.JSX.Element {
  const top = RAIL_VIEWS.filter((v) => v.position === 'top');
  const bottom = RAIL_VIEWS.filter((v) => v.position === 'bottom');

  const activeKey = useTabStore((s) => s.activeKey);
  const openTab = useTabStore((s) => s.open);

  const activityBarTop = APP_MODULES.filter((m) => m.activityBar && m.position !== 'bottom');
  const activityBarBottom = APP_MODULES.filter((m) => m.activityBar && m.position === 'bottom');

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
      {activityBarTop.map((m) => {
        const Icon = m.icon;
        const isActive = activeKey === `module:${m.id}`;
        return (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={m.labelKey}
            title={m.labelKey}
            data-testid={`activity-bar-${m.id}`}
            onClick={() => openTab({ tabKey: `module:${m.id}`, title: m.labelKey, kind: 'module', openedAt: Date.now() })}
            style={{
              width: 40,
              height: 40,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 'var(--r-lg)',
              border: 'none',
              cursor: 'pointer',
              color: isActive ? 'var(--color-brand)' : 'var(--color-text-tertiary)',
              background: isActive ? 'var(--color-brand-ghost)' : 'transparent',
              position: 'relative',
              transition: 'background 160ms, color 160ms',
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = 'var(--color-surface-2)';
                e.currentTarget.style.color = 'var(--color-text)';
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--color-text-tertiary)';
              }
            }}
          >
            {isActive && (
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
      })}
      {activityBarBottom.map((m) => {
        const Icon = m.icon;
        const isActive = activeKey === `module:${m.id}`;
        return (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={m.labelKey}
            title={m.labelKey}
            data-testid={`activity-bar-${m.id}`}
            onClick={() => openTab({ tabKey: `module:${m.id}`, title: m.labelKey, kind: 'module', openedAt: Date.now() })}
            style={{
              width: 40,
              height: 40,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 'var(--r-lg)',
              border: 'none',
              cursor: 'pointer',
              color: isActive ? 'var(--color-brand)' : 'var(--color-text-tertiary)',
              background: isActive ? 'var(--color-brand-ghost)' : 'transparent',
              position: 'relative',
              transition: 'background 160ms, color 160ms',
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = 'var(--color-surface-2)';
                e.currentTarget.style.color = 'var(--color-text)';
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--color-text-tertiary)';
              }
            }}
          >
            {isActive && (
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
      })}
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
