import { APP_MODULES } from '@/modules/registry';
import { useUIStore } from '@/stores/ui-store';
import { NodeSelector } from './node-selector';

/**
 * Top chrome. macOS uses `titleBarStyle: 'hiddenInset'` in the main
 * process, so we leave a draggable strip on the left for the stoplights
 * and wrap the rest of the bar in `app-region: no-drag` so clicks land
 * on the contents.
 *
 * The center slot shows `llamactl — {Active Module}` as a lightweight
 * breadcrumb: matches macOS title-bar convention and gives the
 * otherwise-empty space one job.
 */
export function TitleBar(): React.JSX.Element {
  const activeModule = useUIStore((s) => s.activeModule);
  const active = APP_MODULES.find((m) => m.id === activeModule);
  return (
    <div
      className="flex h-10 shrink-0 select-none items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface-1)]"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      data-testid="title-bar"
    >
      <div className="pl-20" />
      <div className="text-xs text-[color:var(--color-fg-muted)]" data-testid="title-bar-breadcrumb">
        <span className="mono">llamactl</span>
        {active && (
          <>
            <span className="mx-1.5 opacity-60">—</span>
            <span className="text-[color:var(--color-fg)]">{active.labelKey}</span>
          </>
        )}
      </div>
      <div
        className="flex items-center gap-2 pr-3"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <NodeSelector />
      </div>
    </div>
  );
}
