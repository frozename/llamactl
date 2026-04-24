import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { APP_MODULES, type AppModule } from '@/modules/registry';
import { useUIStore } from '@/stores/ui-store';
import { useTabStore } from '@/stores/tab-store';
import { useAppCommands } from './commands';

/**
 * VSCode-style command palette. Opens on ⌘⇧P or ⌘K (Ctrl+Shift+P /
 * Ctrl+K on non-mac); type to filter; ↑↓ to move the highlight;
 * Enter to execute; Esc to cancel. Results come from `APP_MODULES`
 * today (every module + its aliases is an "Open <module>" command)
 * — extensibility for ad-hoc commands (New workload…, Switch theme…,
 * Apply manifest…) lands here when those verbs exist.
 *
 * Fuzzy match: each result gets a score by "how many chars of the
 * query appear IN ORDER in label+aliases". Ties break by shorter
 * label (so "Logs" wins over "LM Studio Import" for query "log").
 */

export interface Command {
  id: string;
  label: string;
  group: string;
  hint?: string;
  /** Optional keyword soup the fuzzy matcher considers in addition
   *  to the label. */
  keywords?: string[];
  run: () => void;
}

function modulesToCommands(): Command[] {
  return APP_MODULES.map((m: AppModule) => ({
    id: `go:${m.id}`,
    label: `Open ${m.labelKey}`,
    group: groupLabel(m.group),
    hint: m.shortcut ? `⌘${m.shortcut}` : undefined,
    keywords: m.aliases ?? [],
    run: () => {
      useTabStore.getState().open({
        tabKey: `module:${m.id}`,
        title: m.labelKey,
        kind: 'module',
        openedAt: Date.now(),
      });
    },
  }));
}

function groupLabel(g: AppModule['group']): string {
  switch (g) {
    case 'core': return 'Core';
    case 'models': return 'Models';
    case 'ops': return 'Ops';
    case 'observability': return 'Observability';
    default: return 'Other';
  }
}

function fuzzyScore(query: string, haystack: string): number {
  const q = query.toLowerCase();
  const h = haystack.toLowerCase();
  if (q.length === 0) return 1;
  let qi = 0;
  let score = 0;
  let lastMatch = -1;
  for (let hi = 0; hi < h.length && qi < q.length; hi += 1) {
    if (h[hi] === q[qi]) {
      // Adjacent matches score higher — "ops ch" > "operator console"
      const bonus = lastMatch === hi - 1 ? 3 : 1;
      score += bonus;
      lastMatch = hi;
      qi += 1;
    }
  }
  if (qi < q.length) return 0;
  // Prefer shorter haystacks when scores tie.
  return score - haystack.length * 0.01;
}

/**
 * Shared selector over the palette's open state (in `ui-store`). Any
 * consumer (TitleBar, StatusBar, SearchStub) can call this to drive
 * the same mounted palette. No keydown listener here — exactly one
 * listener is installed in `CommandPaletteMount`.
 */
export function useCommandPaletteOpen(): [boolean, (open: boolean) => void] {
  const open = useUIStore((s) => s.commandPaletteOpen);
  const setOpen = useUIStore((s) => s.setCommandPaletteOpen);
  return [open, setOpen];
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  extraCommands?: Command[];
}

export function CommandPalette({
  open,
  onClose,
  extraCommands = [],
}: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const commands = useMemo<Command[]>(
    () => [...modulesToCommands(), ...extraCommands],
    [extraCommands],
  );

  const filtered = useMemo(() => {
    if (query.trim().length === 0) return commands;
    return commands
      .map((c) => {
        const text = [c.label, c.group, ...(c.keywords ?? [])].join(' ');
        return { c, score: fuzzyScore(query, text) };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.c);
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setHighlight(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filtered[highlight];
        if (cmd) {
          cmd.run();
          onClose();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [open, filtered, highlight, onClose]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="command-palette"
      className="fixed inset-0 z-[1200] flex items-start justify-center pt-20"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[600px] max-w-[90vw] rounded-lg border shadow-2xl"
        style={{
          borderColor: 'var(--color-border)',
          background: 'var(--color-surface-1)',
        }}
      >
        <div className="border-b border-[var(--color-border)] p-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command…"
            data-testid="command-palette-input"
            className="w-full bg-transparent px-2 py-1.5 text-sm text-[color:var(--color-fg)] outline-none placeholder:text-[color:var(--color-fg-muted)]"
          />
        </div>
        <div
          className="max-h-[60vh] overflow-y-auto py-1"
          data-testid="command-palette-results"
        >
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-[color:var(--color-fg-muted)]">
              No matches for “{query}”
            </div>
          ) : (
            filtered.map((cmd, idx) => {
              const isActive = idx === highlight;
              return (
                <button
                  key={cmd.id}
                  type="button"
                  onMouseEnter={() => setHighlight(idx)}
                  onClick={() => {
                    cmd.run();
                    onClose();
                  }}
                  data-testid={`command-palette-row-${cmd.id}`}
                  data-highlighted={isActive ? 'true' : 'false'}
                  className="flex w-full items-center justify-between px-4 py-1.5 text-left"
                  style={{
                    background: isActive
                      ? 'color-mix(in srgb, var(--color-accent) 14%, transparent)'
                      : 'transparent',
                    borderLeft: isActive
                      ? '2px solid var(--color-accent)'
                      : '2px solid transparent',
                  }}
                >
                  <div className="flex items-baseline gap-2">
                    <span
                      className="text-sm"
                      style={{
                        color: isActive ? 'var(--color-fg)' : 'var(--color-fg-muted)',
                      }}
                    >
                      {cmd.label}
                    </span>
                    <span className="text-[10px] uppercase tracking-widest text-[color:var(--color-fg-muted)] opacity-60">
                      {cmd.group}
                    </span>
                  </div>
                  {cmd.hint && (
                    <span className="font-mono text-[10px] text-[color:var(--color-fg-muted)]">
                      {cmd.hint}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
        <div className="flex items-center justify-between border-t border-[var(--color-border)] px-4 py-1.5 text-[10px] text-[color:var(--color-fg-muted)]">
          <span>↑↓ navigate · ↵ run · esc close</span>
          <span>{filtered.length} of {commands.length}</span>
        </div>
      </div>
    </div>
  );
}

/** Mounts the palette + its single ⌘⇧P / ⌘K keydown listener. Drop
 *  once in the app root; the component itself is invisible when
 *  closed. */
export function CommandPaletteMount(): React.JSX.Element {
  const [open, setOpen] = useCommandPaletteOpen();
  const extras = useAppCommands();

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && open) {
        setOpen(false);
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      // ⌘⇧P toggles.
      if (e.shiftKey && k === 'p') {
        e.preventDefault();
        setOpen(!open);
        return;
      }
      // ⌘K toggles.
      if (!e.shiftKey && k === 'k') {
        e.preventDefault();
        setOpen(!open);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, setOpen]);

  return <CommandPalette open={open} onClose={() => setOpen(false)} extraCommands={extras} />;
}
