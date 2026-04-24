import * as React from 'react';
import { CommandBar, Lockup, ThemeOrbs } from '@/ui';
import { useThemeStore } from '@/stores/theme-store';
import { useTabStore } from '@/stores/tab-store';
import { NodeSelector } from '@/shell/node-selector';
import { useCommandPaletteOpen } from '@/shell/command-palette';
import { Bell } from 'lucide-react';

/**
 * Layout B — macOS traffic lights (handled by main process), a
 * ⌘K breadcrumb/command bar, NodeSelector, ThemeOrbs, notifications
 * icon, avatar. No File/Edit/View menu — macOS provides its own.
 */
export function TitleBar(): React.JSX.Element {
  const themeId = useThemeStore((s) => s.themeId);
  const setThemeId = useThemeStore((s) => s.setThemeId);
  const activeKey = useTabStore((s) => s.activeKey);
  const tabs = useTabStore((s) => s.tabs);
  const [, setPaletteOpen] = useCommandPaletteOpen();

  const activeTab = tabs.find((t) => t.tabKey === activeKey);
  // The leftmost slot is now the Lockup (wordmark + orb), so the
  // breadcrumb no longer repeats "beacon" — it starts at the active
  // tab and trails from there.
  const crumbs = activeTab ? [{ label: activeTab.title, current: true }] : [];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto auto 1fr auto auto auto auto',
        alignItems: 'center',
        gap: 14,
        height: 44,
        padding: '0 14px',
        background: 'var(--color-surface-1)',
        borderBottom: '1px solid var(--color-border-subtle)',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      {/* Traffic-light space — reserved so the drag region starts here,
           and the macOS lights overlay at `titleBarStyle: 'hiddenInset'`. */}
      <div style={{ width: 72 }} />

      {/* Beacon lockup — leftmost product mark, not draggable so it
           receives clicks (future: opens an "about" overlay). */}
      <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <Lockup />
      </div>

      <div
        style={{ justifySelf: 'start', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <CommandBar crumbs={crumbs} onClick={() => setPaletteOpen(true)} />
      </div>

      <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <NodeSelector />
      </div>

      <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <ThemeOrbs activeId={themeId} onPick={setThemeId} />
      </div>

      <button
        type="button"
        style={{
          all: 'unset',
          width: 28,
          height: 28,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 'var(--r-md)',
          color: 'var(--color-text-tertiary)',
          cursor: 'pointer',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
        title="Notifications (P3)"
      >
        <Bell size={14} strokeWidth={1.75} />
      </button>

      <div
        aria-hidden="true"
        style={{
          width: 26,
          height: 26,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, var(--color-brand), #f59e0b)',
          border: '1.5px solid var(--color-surface-1)',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      />
    </div>
  );
}
