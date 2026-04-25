import * as React from 'react';
import { Command } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { useTabStore } from '@/stores/tab-store';
import { useStatusBarStore } from '@/stores/status-bar-store';
import { useThemeStore } from '@/stores/theme-store';
import { useCommandPaletteOpen } from '@/shell/command-palette';
import { getTheme } from '@/themes';

/**
 * Beacon status bar. Three lanes preserved from the legacy shell:
 *   left:   fleet indicators (permanent)
 *   center: per-module contributions (via useStatusBarStore)
 *   right:  command palette shortcut + theme name
 *
 * Contributions are still keyed on "active module id", but with tabs
 * the active module is the kind + source of the active tab. A module
 * tab publishes contributions keyed by its leaf id.
 */
export function StatusBar(): React.JSX.Element {
  const activeKey = useTabStore((s) => s.activeKey);
  const contributions = useStatusBarStore((s) => s.contributions);
  const themeId = useThemeStore((s) => s.themeId);
  const [, setPaletteOpen] = useCommandPaletteOpen();

  const moduleId = activeKey?.startsWith('module:') ? activeKey.slice('module:'.length) : null;
  const moduleItems = moduleId ? (contributions[moduleId] ?? []) : [];

  const workloads = trpc.workloadList.useQuery(undefined, { refetchInterval: 10_000 });

  const running = (workloads.data ?? []).filter((w: { phase?: string }) => w.phase === 'Running').length;

  const theme = getTheme(themeId);

  return (
    <div
      data-testid="beacon-status-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 26,
        padding: '0 12px',
        background: 'var(--color-surface-1)',
        borderTop: '1px solid var(--color-border-subtle)',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--color-text-tertiary)',
        gap: 14,
        flexWrap: 'nowrap',
        overflow: 'hidden',
      }}
    >
      <SBItem glyph="⊡" text={`${running} running`} tone={running > 0 ? 'ok' : 'muted'} />

      {moduleItems.length > 0 && (
        <>
          <Divider />
          {moduleItems.map((it) => (
            <SBItem
              key={it.id}
              glyph={it.glyph}
              text={it.text}
              tone={mapContributionTone(it.tone)}
            />
          ))}
        </>
      )}

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          style={{
            all: 'unset',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 6px',
            borderRadius: 'var(--r-sm)',
            color: 'var(--color-text-secondary)',
          }}
          title="Command palette (⌘⇧P)"
        >
          <Command size={10} />
          <span>⌘⇧P</span>
        </button>
        <span style={{ color: 'var(--color-text-tertiary)' }}>{theme.label.toLowerCase()}</span>
      </div>
    </div>
  );
}

function Divider(): React.JSX.Element {
  return <span aria-hidden="true" style={{ width: 1, height: 12, background: 'var(--color-border)' }} />;
}

type SBTone = 'ok' | 'warn' | 'err' | 'muted';

/** Map a status-bar-store contribution tone to the Beacon SB tone set. */
function mapContributionTone(t?: string): SBTone {
  // The store uses 'fg' | 'muted' | 'accent' | 'warn' | 'danger'.
  if (t === 'warn') return 'warn';
  if (t === 'danger') return 'err';
  if (t === 'accent' || t === 'fg') return 'ok';
  return 'muted';
}

interface SBItemProps { glyph?: string; text: string; tone: SBTone }
function SBItem({ glyph, text, tone }: SBItemProps): React.JSX.Element {
  const color =
    tone === 'ok' ? 'var(--color-ok)' :
    tone === 'warn' ? 'var(--color-warn)' :
    tone === 'err' ? 'var(--color-err)' :
    'var(--color-text-tertiary)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color }}>
      {glyph && <span aria-hidden="true">{glyph}</span>}
      <span>{text}</span>
    </span>
  );
}
