import * as React from 'react';
import { Suspense, useEffect, useRef, useState } from 'react';

/**
 * Reusable tab strip for a grouped module. Each tab mounts lazily
 * on first visit + stays mounted afterward (same hidden-but-mounted
 * pattern the shell uses for top-level modules), so switching a
 * Models sub-tab preserves scroll/state on the others.
 *
 * Tabs are defined declaratively; each `Component` is rendered as
 * a child under an absolute-positioned div so their own layout
 * stays untouched. Modules that already have a full-height flex
 * root + internal overflow-auto continue to work unchanged.
 */

export interface ModuleTab {
  id: string;
  label: string;
  Component: React.ComponentType;
}

interface TabbedModuleProps {
  /** Short id used in data-testid / local storage key. */
  moduleId: string;
  /** Tabs in order; the first is the default. */
  tabs: readonly ModuleTab[];
  /** Optional title rendered above the tab strip. */
  title?: string;
  /** Optional subtitle rendered below the title. */
  subtitle?: string;
  /** Optional extras rendered on the right side of the tab strip.
   *  Used by Ops Console to surface its shared node + model picker
   *  so both tabs share one executor config instead of each tab
   *  owning its own inputs. */
  headerRight?: React.ReactNode;
}

export function TabbedModule({
  moduleId,
  tabs,
  title,
  subtitle,
  headerRight,
}: TabbedModuleProps): React.JSX.Element {
  const [active, setActive] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(`llamactl-tab-${moduleId}`);
      if (stored && tabs.some((t) => t.id === stored)) return stored;
    }
    return tabs[0]?.id ?? '';
  });
  const visitedRef = useRef<Set<string>>(new Set([active]));
  useEffect(() => {
    visitedRef.current.add(active);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(`llamactl-tab-${moduleId}`, active);
    }
  }, [active, moduleId]);

  return (
    <div className="flex h-full flex-col" data-testid={`${moduleId}-root`} data-active-tab={active}>
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-1)]">
        {(title || subtitle) && (
          <div className="px-6 pt-4 pb-1">
            {title && (
              <h1 className="text-lg font-semibold text-[color:var(--color-fg)]">{title}</h1>
            )}
            {subtitle && (
              <p className="text-xs text-[color:var(--color-fg-muted)]">{subtitle}</p>
            )}
          </div>
        )}
        <div
          className="flex items-center gap-0.5 overflow-x-auto px-4"
          role="tablist"
          data-testid={`${moduleId}-tabs`}
        >
          {tabs.map((tab) => {
            const isActive = tab.id === active;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActive(tab.id)}
                data-testid={`${moduleId}-tab-${tab.id}`}
                className="relative px-3 py-2 text-xs transition-colors"
                style={{
                  color: isActive ? 'var(--color-fg)' : 'var(--color-fg-muted)',
                  borderBottom: isActive
                    ? '2px solid var(--color-accent)'
                    : '2px solid transparent',
                  marginBottom: -1,
                }}
              >
                {tab.label}
              </button>
            );
          })}
          {headerRight && (
            <div className="ml-auto flex items-center gap-2 py-1.5 pr-2">
              {headerRight}
            </div>
          )}
        </div>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <Suspense
          fallback={
            <div className="p-6 text-xs text-[color:var(--color-fg-muted)]">Loading…</div>
          }
        >
          {tabs.map((tab) => {
            if (!visitedRef.current.has(tab.id)) return null;
            const isActive = tab.id === active;
            const Component = tab.Component;
            return (
              <div
                key={tab.id}
                data-tab-id={tab.id}
                aria-hidden={!isActive}
                className="absolute inset-0 overflow-auto"
                style={{ display: isActive ? 'block' : 'none' }}
              >
                <Component />
              </div>
            );
          })}
        </Suspense>
      </div>
    </div>
  );
}
