import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useThemeStore } from '@/stores/theme-store';
import { THEMES, type ThemeId } from '@/themes';
import { ThemeProvider } from './theme-provider';

/**
 * VSCode-style theme picker. Cmd+K Cmd+T opens it (VSCode's default),
 * arrow keys move the highlight + LIVE-PREVIEW the whole app, Enter
 * commits, Escape cancels and restores the prior selection.
 *
 * The live-preview path re-mounts the app's ThemeProvider with the
 * highlighted theme id — so everything downstream (NodeMap variant,
 * chrome, fonts, scanlines) flips instantly without touching the
 * persisted store. Only Enter writes to zustand.
 *
 * Also rendered as a small button in the title bar so mouse users
 * don't have to guess the shortcut.
 */

export function useThemePickerOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let waitingForT = false;
    let waitTimer: ReturnType<typeof setTimeout> | null = null;
    const handler = (e: KeyboardEvent): void => {
      // Esc closes.
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
        return;
      }
      // VSCode's chord: Cmd+K, then Cmd+T within ~1s.
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) {
        waitingForT = false;
        return;
      }
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        waitingForT = true;
        if (waitTimer) clearTimeout(waitTimer);
        waitTimer = setTimeout(() => {
          waitingForT = false;
        }, 1200);
        return;
      }
      if (waitingForT && e.key.toLowerCase() === 't') {
        e.preventDefault();
        waitingForT = false;
        setOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      if (waitTimer) clearTimeout(waitTimer);
    };
  }, [open]);
  return [open, setOpen];
}

interface ThemePickerProps {
  open: boolean;
  onClose: () => void;
}

export function ThemePicker({ open, onClose }: ThemePickerProps): React.JSX.Element | null {
  const { themeId, setThemeId } = useThemeStore();
  const [highlight, setHighlight] = useState<ThemeId>(themeId);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) setHighlight(themeId);
  }, [open, themeId]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = THEMES.findIndex((t) => t.id === highlight);
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const next = THEMES[(idx + delta + THEMES.length) % THEMES.length]!;
        setHighlight(next.id);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        setThemeId(highlight);
        onClose();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setHighlight(themeId);
        onClose();
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [open, highlight, themeId, setThemeId, onClose]);

  const committed = themeId;
  const previewing = highlight !== committed;

  if (!open) return null;
  return (
    <>
      {/* Re-mount ThemeProvider invisibly with the highlighted id so
          the whole app paints the preview in real time. */}
      <InvisibleThemeApplier themeId={highlight} />
      <div
        aria-modal="true"
        role="dialog"
        data-testid="theme-picker"
        className="fixed inset-0 z-[1100] flex items-start justify-center pt-24"
        style={{ background: 'rgba(0,0,0,0.5)' }}
        onClick={onClose}
      >
        <div
          ref={listRef}
          onClick={(e) => e.stopPropagation()}
          className="w-[480px] rounded-lg border shadow-2xl"
          style={{
            borderColor: 'var(--color-border)',
            background: 'var(--color-surface-1)',
          }}
        >
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
            <div className="text-xs uppercase tracking-widest text-[color:var(--color-fg-muted)]">
              Color Theme
            </div>
            <div className="text-[10px] text-[color:var(--color-fg-muted)]">
              ↑↓ preview · ↵ apply · esc cancel
            </div>
          </div>
          <div className="py-1">
            {THEMES.map((t) => {
              const isHighlight = t.id === highlight;
              const isCommitted = t.id === committed;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setThemeId(t.id);
                    onClose();
                  }}
                  onMouseEnter={() => setHighlight(t.id)}
                  data-testid={`theme-picker-row-${t.id}`}
                  data-highlighted={isHighlight ? 'true' : 'false'}
                  className="flex w-full items-center justify-between px-4 py-2 text-left"
                  style={{
                    background: isHighlight ? 'color-mix(in srgb, var(--color-accent) 14%, transparent)' : 'transparent',
                    borderLeft: isHighlight ? '2px solid var(--color-accent)' : '2px solid transparent',
                  }}
                >
                  <div>
                    <div className="flex items-baseline gap-2">
                      <span
                        className="text-sm"
                        style={{
                          color: isHighlight ? 'var(--color-fg)' : 'var(--color-fg-muted)',
                          fontWeight: isHighlight ? 500 : 400,
                        }}
                      >
                        {t.label}
                      </span>
                      {isCommitted && (
                        <span className="text-[9px] uppercase tracking-widest text-[color:var(--color-accent)]">
                          active
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-[color:var(--color-fg-muted)]">
                      {t.tagline}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    {Object.values(t.vars)
                      .filter((v) => typeof v === 'string' && v.startsWith('#'))
                      .slice(5, 10)
                      .map((color, i) => (
                        <span
                          key={i}
                          className="h-4 w-1 rounded-sm"
                          style={{ background: color }}
                        />
                      ))}
                  </div>
                </button>
              );
            })}
          </div>
          {previewing && (
            <div className="border-t border-[var(--color-border)] px-4 py-1.5 text-[10px] text-[color:var(--color-fg-muted)]">
              previewing — press ↵ to apply, esc to revert to <span className="font-medium text-[color:var(--color-fg)]">{committed}</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** Remounts ThemeProvider invisibly with a preview id to drive the
 *  live-preview. The visible ThemeProvider at the app root still
 *  wraps the children; this one just overrides :root vars on top
 *  so the preview paints through. */
function InvisibleThemeApplier({ themeId }: { themeId: ThemeId }): React.JSX.Element {
  return <ThemeProvider previewThemeId={themeId}>{null}</ThemeProvider>;
}

export function ThemePickerButton(): React.JSX.Element {
  const [open, setOpen] = useThemePickerOpen();
  const themeId = useThemeStore((s) => s.themeId);
  const current = useMemo(() => THEMES.find((t) => t.id === themeId) ?? THEMES[0]!, [themeId]);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="theme-picker-button"
        className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[color:var(--color-fg)] hover:border-[var(--color-accent)]"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title="Color theme (⌘K ⌘T)"
      >
        <span className="text-[10px] text-[color:var(--color-fg-muted)]">theme</span>
        <span className="font-mono text-[11px]">{current.label.toLowerCase()}</span>
      </button>
      <ThemePicker open={open} onClose={() => setOpen(false)} />
    </>
  );
}
