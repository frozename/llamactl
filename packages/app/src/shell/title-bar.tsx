import { NodeSelector } from './node-selector';

/**
 * Top chrome. macOS uses `titleBarStyle: 'hiddenInset'` in the main
 * process, so we leave a draggable strip on the left for the stoplights
 * and wrap the rest of the bar in `app-region: no-drag` so clicks land
 * on the contents.
 */
export function TitleBar(): React.JSX.Element {
  return (
    <div
      className="flex h-10 shrink-0 select-none items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface-1)]"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="pl-20" />
      <div className="text-xs text-[color:var(--color-fg-muted)]">
        <span className="mono">llamactl</span>
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
