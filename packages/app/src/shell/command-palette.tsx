import * as React from "react";
import { useEffect } from "react";

import { useCommandPaletteOpen } from "./command-palette-state";
import { useAppCommands } from "./commands";
import { useCommandPaletteLogic } from "./use-command-palette-logic";

/**
 * VSCode-style command palette.
 */

export interface Command {
  id: string;
  label: string;
  group: string;
  hint?: string;
  keywords?: string[];
  run: () => void;
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
  const { query, setQuery, highlight, setHighlight, inputRef, filtered, commands } =
    useCommandPaletteLogic(open, onClose, extraCommands);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="command-palette"
      className="fixed inset-0 z-[1200] flex items-start justify-center pt-20"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={() => {
        onClose();
      }}
    >
      <div
        onClick={(e) => {
          e.stopPropagation();
        }}
        className="w-[600px] max-w-[90vw] rounded-lg border shadow-2xl"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-1)" }}
      >
        <div className="border-b border-[var(--color-border)] p-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            placeholder="Type a command…"
            data-testid="command-palette-input"
            className="w-full bg-transparent px-2 py-1.5 text-sm text-[color:var(--color-text)] outline-none placeholder:text-[color:var(--color-text-secondary)]"
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-1" data-testid="command-palette-results">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-[color:var(--color-text-secondary)]">
              No matches for “{query}”
            </div>
          ) : (
            filtered.map((cmd, idx) => (
              <CommandRow
                key={cmd.id}
                cmd={cmd}
                active={idx === highlight}
                onHighlight={() => {
                  setHighlight(idx);
                }}
                onRun={() => {
                  cmd.run();
                  onClose();
                }}
              />
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t border-[var(--color-border)] px-4 py-1.5 text-[10px] text-[color:var(--color-text-secondary)]">
          <span>↑↓ navigate · ↵ run · esc close</span>
          <span>
            {filtered.length} of {commands.length}
          </span>
        </div>
      </div>
    </div>
  );
}

function CommandRow({
  cmd,
  active,
  onHighlight,
  onRun,
}: {
  cmd: Command;
  active: boolean;
  onHighlight: () => void;
  onRun: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onMouseEnter={() => {
        onHighlight();
      }}
      onClick={() => {
        onRun();
      }}
      data-testid={`command-palette-row-${cmd.id}`}
      data-highlighted={active ? "true" : "false"}
      className="flex w-full items-center justify-between px-4 py-1.5 text-left"
      style={{
        background: active ? "color-mix(in srgb, var(--color-ok) 14%, transparent)" : "transparent",
        borderLeft: active ? "2px solid var(--color-ok)" : "2px solid transparent",
      }}
    >
      <div className="flex items-baseline gap-2">
        <span
          className="text-sm"
          style={{ color: active ? "var(--color-text)" : "var(--color-text-secondary)" }}
        >
          {cmd.label}
        </span>
        <span className="text-[10px] uppercase tracking-widest text-[color:var(--color-text-secondary)] opacity-60">
          {cmd.group}
        </span>
      </div>
      {cmd.hint && (
        <span className="font-mono text-[10px] text-[color:var(--color-text-secondary)]">
          {cmd.hint}
        </span>
      )}
    </button>
  );
}

/** Mounts the palette + its single ⌘⇧P / ⌘K keydown listener. */
export function CommandPaletteMount(): React.JSX.Element {
  const [open, setOpen] = useCommandPaletteOpen();
  const extras = useAppCommands();

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && open) {
        setOpen(false);
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (e.shiftKey && k === "p") {
        e.preventDefault();
        setOpen(!open);
      } else if (!e.shiftKey && k === "k") {
        e.preventDefault();
        setOpen(!open);
      }
    };
    window.addEventListener("keydown", handler);
    return (): void => {
      window.removeEventListener("keydown", handler);
    };
  }, [open, setOpen]);

  return (
    <CommandPalette
      open={open}
      onClose={() => {
        setOpen(false);
      }}
      extraCommands={extras}
    />
  );
}
