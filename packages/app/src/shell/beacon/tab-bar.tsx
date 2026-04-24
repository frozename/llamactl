import * as React from 'react';
import { X, Pin } from 'lucide-react';
import { useTabStore, type TabEntry } from '@/stores/tab-store';

/**
 * Persistent tab strip. Pinned tabs render leftmost with a pin glyph
 * in place of the × close button. Active tab paints a 1.5 px brand
 * underbar on its top edge. Middle-click closes; right-click shows a
 * context menu (Pin, Close others, Close all).
 */
export function TabBar(): React.JSX.Element {
  const tabs = useTabStore((s) => s.tabs);
  const activeKey = useTabStore((s) => s.activeKey);
  const setActive = useTabStore((s) => s.setActive);
  const close = useTabStore((s) => s.close);
  const pin = useTabStore((s) => s.pin);
  const unpin = useTabStore((s) => s.unpin);
  const closeOthers = useTabStore((s) => s.closeOthers);
  const closeAll = useTabStore((s) => s.closeAll);

  const [menu, setMenu] = React.useState<{ x: number; y: number; tab: TabEntry } | null>(null);
  const tabRefs = React.useRef<Map<string, HTMLDivElement>>(new Map());

  React.useEffect(() => {
    if (!menu) return;
    const dismiss = (): void => setMenu(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('click', dismiss);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', dismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const focusTab = (key: string): void => {
    requestAnimationFrame(() => tabRefs.current.get(key)?.focus());
  };

  return (
    <div
      role="tablist"
      style={{
        display: 'flex',
        alignItems: 'stretch',
        background: 'var(--color-surface-1)',
        borderBottom: '1px solid var(--color-border-subtle)',
        overflowX: 'auto',
        minHeight: 38,
      }}
    >
      {tabs.map((tab, idx) => {
        const active = tab.tabKey === activeKey;
        return (
          <div
            key={tab.tabKey}
            ref={(el) => {
              if (el) tabRefs.current.set(tab.tabKey, el);
              else tabRefs.current.delete(tab.tabKey);
            }}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => setActive(tab.tabKey)}
            onAuxClick={(e) => {
              if (e.button === 1) close(tab.tabKey);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, tab });
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const dir = e.key === 'ArrowRight' ? 1 : -1;
                const next = tabs[(idx + dir + tabs.length) % tabs.length];
                if (next) {
                  setActive(next.tabKey);
                  focusTab(next.tabKey);
                }
                return;
              }
              if (e.key === 'Home') {
                e.preventDefault();
                const first = tabs[0];
                if (first) {
                  setActive(first.tabKey);
                  focusTab(first.tabKey);
                }
                return;
              }
              if (e.key === 'End') {
                e.preventDefault();
                const last = tabs[tabs.length - 1];
                if (last) {
                  setActive(last.tabKey);
                  focusTab(last.tabKey);
                }
                return;
              }
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setActive(tab.tabKey);
              }
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 14px',
              fontSize: 12,
              color: active ? 'var(--color-text)' : 'var(--color-text-tertiary)',
              background: active ? 'var(--color-surface-0)' : 'transparent',
              cursor: 'pointer',
              borderRight: '1px solid var(--color-border-subtle)',
              position: 'relative',
              whiteSpace: 'nowrap',
              transition: 'background 160ms, color 160ms',
            }}
          >
            {active && (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: 0,
                  height: 1.5,
                  background: 'var(--color-brand)',
                }}
              />
            )}
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: active ? 'var(--color-brand)' : 'var(--color-text-ghost)',
              }}
            />
            <span>{tab.title}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (tab.pinned) {
                  unpin(tab.tabKey);
                } else {
                  close(tab.tabKey);
                }
              }}
              style={{
                all: 'unset',
                width: 16,
                height: 16,
                display: 'grid',
                placeItems: 'center',
                borderRadius: 4,
                cursor: 'pointer',
                marginLeft: 4,
                color: 'inherit',
              }}
              title={tab.pinned ? 'Unpin' : 'Close'}
            >
              {tab.pinned ? (
                <Pin size={11} strokeWidth={2} fill="currentColor" />
              ) : (
                <X size={12} strokeWidth={2} />
              )}
            </button>
          </div>
        );
      })}
      {menu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: menu.x,
            top: menu.y,
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--r-md)',
            padding: 4,
            boxShadow: 'var(--shadow-md)',
            fontSize: 12,
            zIndex: 2000,
            minWidth: 180,
          }}
        >
          <MenuItem
            label={menu.tab.pinned ? 'Unpin' : 'Pin'}
            onPick={() => {
              if (menu.tab.pinned) {
                unpin(menu.tab.tabKey);
              } else {
                pin(menu.tab.tabKey);
              }
              setMenu(null);
            }}
          />
          <MenuItem
            label="Close"
            onPick={() => {
              close(menu.tab.tabKey);
              setMenu(null);
            }}
          />
          <MenuItem
            label="Close others"
            onPick={() => {
              closeOthers(menu.tab.tabKey);
              setMenu(null);
            }}
          />
          <MenuItem
            label="Close all"
            onPick={() => {
              closeAll(true);
              setMenu(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({ label, onPick }: { label: string; onPick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onPick}
      style={{
        all: 'unset',
        display: 'block',
        width: '100%',
        padding: '6px 10px',
        cursor: 'pointer',
        color: 'var(--color-text)',
        borderRadius: 4,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--color-surface-3)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {label}
    </button>
  );
}
