import { Suspense } from 'react';
import { ActivityBar } from './activity-bar';
import { TitleBar } from './title-bar';
import { StatusBar } from './status-bar';
import { APP_MODULES } from '@/modules/registry';
import { useUIStore } from '@/stores/ui-store';

export function IDELayout(): JSX.Element {
  const activeModule = useUIStore((s) => s.activeModule);
  const current = APP_MODULES.find((m) => m.id === activeModule) ?? APP_MODULES[0];
  const Active = current?.Component;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <ActivityBar />
        <main className="flex-1 overflow-hidden bg-[var(--color-surface-0)]">
          <Suspense
            fallback={
              <div className="p-6 text-[color:var(--color-fg-muted)]">Loading…</div>
            }
          >
            {Active ? <Active /> : null}
          </Suspense>
        </main>
      </div>
      <StatusBar />
    </div>
  );
}
