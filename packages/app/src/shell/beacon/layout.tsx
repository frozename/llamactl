import * as React from 'react';
import { Suspense, useEffect, useRef, useState } from 'react';
import { APP_MODULES } from '@/modules/registry';
import { useTabStore } from '@/stores/tab-store';
import { CommandPaletteMount } from '@/shell/command-palette';
import { TitleBar } from './title-bar';
import { ActivityRail } from './activity-rail';
import { ExplorerPanel } from './explorer-panel';
import { TabBar } from './tab-bar';
import { StatusBar } from './status-bar';
import { TokensPanel } from './tokens-panel';
import { FirstRunTip } from './first-run-tip';
import { DynamicTabRouter } from './dynamic-tab-router';
import type { RailViewId } from './rail-views';

const RAIL_KEY = 'beacon.rail.view';

/**
 * Beacon shell root. Manages the rail-view selection (local state,
 * persisted to localStorage), mounts every tab's module component
 * lazily via APP_MODULES, and toggles visibility with display:none
 * so each module's state is preserved across tab switches.
 */
export function BeaconLayout(): React.JSX.Element {
  const tabs = useTabStore((s) => s.tabs);
  const activeKey = useTabStore((s) => s.activeKey);
  const open = useTabStore((s) => s.open);
  const close = useTabStore((s) => s.close);
  const reopen = useTabStore((s) => s.reopen);
  const setActive = useTabStore((s) => s.setActive);

  const [railView, setRailView] = useState<RailViewId>(() => {
    if (typeof localStorage === 'undefined') return 'explorer';
    return ((localStorage.getItem(RAIL_KEY) as RailViewId) || 'explorer');
  });
  useEffect(() => { localStorage.setItem(RAIL_KEY, railView); }, [railView]);

  // Seed a default tab if none exist.
  useEffect(() => {
    if (tabs.length === 0) {
      open({ tabKey: 'module:dashboard', title: 'Dashboard', kind: 'module', openedAt: Date.now() });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle the Tokens rail view by opening the slide-in panel (it's
  // not a panel-content view, it's an overlay — ExplorerPanel shows
  // a hint, the slide-in does the work).
  const tokensOpen = railView === 'tokens';

  // Tab keyboard shortcuts: ⌘1–⌘9, ⌘W, ⌘⇧T.
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (k === 'w' && !e.shiftKey && activeKey) {
        e.preventDefault();
        close(activeKey);
        return;
      }
      if (k === 't' && e.shiftKey) {
        e.preventDefault();
        reopen();
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= 9) {
        const target = tabs[n - 1];
        if (target) {
          e.preventDefault();
          setActive(target.tabKey);
        }
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [tabs, activeKey, close, reopen, setActive]);

  const visitedRef = useRef(new Set<string>());
  if (activeKey) visitedRef.current.add(activeKey);
  for (const t of tabs) visitedRef.current.add(t.tabKey);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: 'auto 1fr auto',
        height: '100vh',
        position: 'relative',
        zIndex: 1,
      }}
    >
      <TitleBar />

      <div style={{ display: 'grid', gridTemplateColumns: '56px 280px 1fr', overflow: 'hidden', minHeight: 0 }}>
        <ActivityRail activeView={railView} onChange={setRailView} />
        <ExplorerPanel activeView={railView} />
        <main style={{ display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--color-surface-0)' }}>
          <TabBar />
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
            <Suspense fallback={<div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>Loading…</div>}>
              {tabs.map((tab) => {
                if (!visitedRef.current.has(tab.tabKey)) return null;
                const isActive = tab.tabKey === activeKey;
                if (tab.kind === 'module') {
                  const moduleId = tab.tabKey.slice('module:'.length);
                  const mod = APP_MODULES.find((m) => m.id === moduleId);
                  if (!mod) return null;
                  const Component = mod.Component;
                  return (
                    <div
                      key={tab.tabKey}
                      data-module-id={moduleId}
                      aria-hidden={!isActive}
                      style={{ position: 'absolute', inset: 0, overflow: 'auto', display: isActive ? 'block' : 'none' }}
                    >
                      <Component />
                    </div>
                  );
                }
                return (
                  <div
                    key={tab.tabKey}
                    data-tab-key={tab.tabKey}
                    aria-hidden={!isActive}
                    style={{ position: 'absolute', inset: 0, overflow: 'auto', display: isActive ? 'block' : 'none' }}
                  >
                    <DynamicTabRouter tab={tab} />
                  </div>
                );
              })}
            </Suspense>
          </div>
        </main>
      </div>

      <StatusBar />
      <TokensPanel open={tokensOpen} onClose={() => setRailView('explorer')} />
      <CommandPaletteMount />
      <FirstRunTip />
    </div>
  );
}

