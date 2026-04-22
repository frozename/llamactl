import * as React from 'react';
import { Suspense, useEffect, useRef } from 'react';
import { ActivityBar } from './activity-bar';
import { TitleBar } from './title-bar';
import { StatusBar } from './status-bar';
import { CommandPaletteMount } from './command-palette';
import { APP_MODULES } from '@/modules/registry';
import { useUIStore } from '@/stores/ui-store';

/**
 * Keep every module mounted once it's been opened; toggle visibility
 * via `display:none` on the inactive siblings. Without this, every
 * module switch unmounts the previous view and discards its entire
 * state — scroll position, uncommitted form values, in-flight
 * streaming subscriptions, everything. VSCode has the same problem
 * before you open a second editor; keeping the DOM alive is the
 * same fix.
 *
 * Modules are still lazy-loaded (React.lazy in registry.ts) so an
 * unvisited module's bundle never loads. The "visited" set grows
 * monotonically for the session — we accept that a module that
 * crashed would still be in the tree on next visit; that's better
 * than losing state for the common healthy case, and the module
 * authors already handle their own error boundaries.
 */
export function IDELayout(): React.JSX.Element {
  const activeModule = useUIStore((s) => s.activeModule);
  const visitedRef = useRef(new Set<string>([activeModule]));
  useEffect(() => {
    visitedRef.current.add(activeModule);
  }, [activeModule]);
  visitedRef.current.add(activeModule);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <ActivityBar />
        <main className="relative flex-1 overflow-hidden bg-[var(--color-surface-0)]">
          <Suspense
            fallback={
              <div className="p-6 text-[color:var(--color-fg-muted)]">Loading\u2026</div>
            }
          >
            {APP_MODULES.map((m) => {
              if (!visitedRef.current.has(m.id)) return null;
              const isActive = m.id === activeModule;
              const Component = m.Component;
              return (
                <div
                  key={m.id}
                  data-module-id={m.id}
                  aria-hidden={!isActive}
                  className="absolute inset-0 overflow-auto"
                  style={{ display: isActive ? 'block' : 'none' }}
                >
                  <Component />
                </div>
              );
            })}
          </Suspense>
        </main>
      </div>
      <StatusBar />
      <CommandPaletteMount />
    </div>
  );
}
