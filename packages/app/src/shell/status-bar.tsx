import * as React from 'react';
import { Command } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { useUIStore } from '@/stores/ui-store';
import { useStatusBarStore, type StatusBarItem } from '@/stores/status-bar-store';
import { useThemeStore } from '@/stores/theme-store';
import { getTheme } from '@/themes';
import { useCommandPaletteOpen } from './command-palette';

/**
 * VSCode-style status bar. Three lanes:
 *
 *   left   — permanent, always-on fleet indicators (nodes, workloads,
 *            local server state). Read from cheap polled queries.
 *   center — module-scoped contributions. Any module can push items
 *            via useStatusBarStore().setModuleItems(moduleId, [...]).
 *            The shell shows whichever module is active.
 *   right  — permanent, theme + command-palette shortcut.
 *
 * Everything is compact by design — the bar is 22px tall; individual
 * items use a glyph + 1-3 words. Click-handlers on left/right items
 * open contextual panels (e.g. clicking "workloads" jumps to the
 * Workloads module).
 */

function toneColor(tone: StatusBarItem['tone']): string {
  switch (tone) {
    case 'accent':
      return 'var(--color-accent)';
    case 'warn':
      return 'var(--color-warn, var(--color-warning))';
    case 'danger':
      return 'var(--color-danger)';
    case 'muted':
      return 'var(--color-fg-muted)';
    case 'fg':
    default:
      return 'var(--color-fg)';
  }
}

function Cell({
  item,
  testId,
}: {
  item: StatusBarItem;
  testId?: string;
}): React.JSX.Element {
  const color = toneColor(item.tone);
  const content = (
    <>
      {item.glyph && <span style={{ color }}>{item.glyph}</span>}
      <span style={{ color }}>{item.text}</span>
    </>
  );
  if (item.onClick) {
    return (
      <button
        type="button"
        onClick={item.onClick}
        title={item.title}
        data-testid={testId}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--color-surface-2)]"
      >
        {content}
      </button>
    );
  }
  return (
    <span
      title={item.title}
      data-testid={testId}
      className="flex items-center gap-1 px-1.5 py-0.5"
    >
      {content}
    </span>
  );
}

function useFleetItems(): StatusBarItem[] {
  const nodeList = trpc.nodeList.useQuery(undefined, { refetchInterval: 30_000 });
  const workloads = trpc.workloadList.useQuery(undefined, { refetchInterval: 10_000 });
  const server = trpc.serverStatus.useQuery(undefined, { refetchInterval: 5_000 });
  const setActiveModule = useUIStore((s) => s.setActiveModule);

  const total = nodeList.data?.nodes.length ?? 0;
  const agents = (nodeList.data?.nodes ?? []).filter(
    (n) => (n.effectiveKind ?? 'agent') === 'agent',
  ).length;
  const workloadRows = (workloads.data ?? []) as Array<{ phase: string }>;
  const running = workloadRows.filter((w) => w.phase === 'Running').length;
  const serverUp = server.data?.state === 'up';

  return [
    {
      id: 'fleet',
      glyph: '\u25C9',
      text: `${agents}/${total}`,
      title: `${agents} agent nodes \u00B7 ${total} total in the fleet (click to open Nodes)`,
      tone: total > 0 ? 'accent' : 'muted',
      onClick: () => setActiveModule('nodes'),
    },
    {
      id: 'workloads',
      glyph: '\u22A1',
      text: `${running} running`,
      title: 'Running workloads across the fleet (click to open Workloads)',
      tone: running > 0 ? 'accent' : 'muted',
      onClick: () => setActiveModule('workloads'),
    },
    {
      id: 'local-server',
      glyph: serverUp ? '\u25CF' : '\u25CB',
      text: serverUp ? 'local up' : 'local idle',
      title: serverUp
        ? `Local llama-server listening on ${server.data?.endpoint ?? ''}`
        : 'Local llama-server not running (open palette \u2192 Server)',
      tone: serverUp ? 'accent' : 'muted',
    },
  ];
}

export function StatusBar(): React.JSX.Element {
  const activeModule = useUIStore((s) => s.activeModule);
  const contributions = useStatusBarStore((s) => s.contributions);
  const themeId = useThemeStore((s) => s.themeId);
  const [, setPaletteOpen] = useCommandPaletteOpen();

  const leftItems = useFleetItems();
  const moduleItems = contributions[activeModule] ?? [];

  const theme = getTheme(themeId);

  return (
    <div
      className="flex h-[22px] shrink-0 items-center gap-1 border-t text-[11px]"
      style={{
        borderColor: 'var(--color-border)',
        background: 'var(--color-surface-1)',
        color: 'var(--color-fg-muted)',
      }}
      data-testid="status-bar"
    >
      {/* left — fleet permanent */}
      <div className="flex items-center gap-0.5 pl-1.5">
        {leftItems.map((item) => (
          <Cell key={item.id} item={item} testId={`status-bar-left-${item.id}`} />
        ))}
      </div>

      {/* center — module contributions */}
      {moduleItems.length > 0 && (
        <>
          <Divider />
          <div
            className="flex items-center gap-0.5"
            data-testid="status-bar-module-items"
          >
            {moduleItems.map((item) => (
              <Cell key={item.id} item={item} testId={`status-bar-mod-${item.id}`} />
            ))}
          </div>
        </>
      )}

      <div className="ml-auto flex items-center gap-0.5 pr-1.5">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--color-surface-2)]"
          title="Open command palette (\u2318\u21E7P)"
          data-testid="status-bar-cmd-palette"
        >
          <Command size={10} />
          <span>\u2318\u21E7P</span>
        </button>
        <span
          className="px-1.5 py-0.5"
          data-testid="status-bar-theme"
          title={`theme: ${theme.label} \u2014 ${theme.tagline}`}
        >
          {theme.label.toLowerCase()}
        </span>
      </div>
    </div>
  );
}

function Divider(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="mx-0.5 h-3 w-px"
      style={{ background: 'var(--color-border)' }}
    />
  );
}
