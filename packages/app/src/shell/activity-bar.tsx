import * as React from 'react';
import { APP_MODULES, type AppModule } from '@/modules/registry';
import { useUIStore } from '@/stores/ui-store';

function IconButton({ module }: { module: AppModule }): React.JSX.Element {
  const activeModule = useUIStore((s) => s.activeModule);
  const setActiveModule = useUIStore((s) => s.setActiveModule);
  const Icon = module.icon;
  const active = activeModule === module.id;
  return (
    <button
      type="button"
      className="activity-icon"
      data-active={active}
      title={module.labelKey}
      aria-label={module.labelKey}
      aria-current={active ? 'page' : undefined}
      onClick={() => setActiveModule(module.id)}
    >
      <Icon size={18} />
    </button>
  );
}

export function ActivityBar(): React.JSX.Element {
  // Only modules flagged `activityBar: true` show up in the sidebar.
  // The rest are reachable via the command palette (⌘⇧P); this keeps
  // the left edge focused on the ~8 modules an operator uses daily
  // without dropping access to the long tail of administrative views.
  const visibleModules = APP_MODULES.filter((m) => m.activityBar === true);
  const topModules = visibleModules.filter((m) => m.position !== 'bottom');
  const bottomModules = visibleModules.filter((m) => m.position === 'bottom');

  return (
    <div className="flex h-full w-12 shrink-0 flex-col items-center border-r border-[var(--color-border)] bg-[var(--color-surface-1)]">
      <div className="flex h-12 w-full items-center justify-center">
        <div className="flex h-6 w-6 items-center justify-center rounded bg-[var(--color-brand)] text-[10px] font-bold text-[color:var(--color-surface-0)]">
          L
        </div>
      </div>
      <nav className="flex flex-1 flex-col items-center gap-0.5 pt-1">
        {topModules.map((m) => (
          <IconButton key={m.id} module={m} />
        ))}
      </nav>
      <div className="flex flex-col items-center gap-0.5 pb-2">
        {bottomModules.map((m) => (
          <IconButton key={m.id} module={m} />
        ))}
      </div>
    </div>
  );
}
