import { useEffect, useMemo, useRef, useState } from "react";

import { APP_MODULES, type AppModule } from "@/modules/registry";
import { useTabStore } from "@/stores/tab-store";

import type { Command } from "./command-palette";

export interface UseCommandPaletteLogicReturn {
  query: string;
  setQuery: (v: string) => void;
  highlight: number;
  setHighlight: (v: number) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  filtered: Command[];
  commands: Command[];
}

export function useCommandPaletteLogic(
  open: boolean,
  onClose: () => void,
  extraCommands: Command[],
): UseCommandPaletteLogicReturn {
  const [query, setQuery] = useState("");
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
        const text = [c.label, c.group, ...(c.keywords ?? [])].join(" ");
        return { c, score: fuzzyScore(query, text) };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.c);
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      // Use setTimeout to avoid synchronous setState in effect.
      const handle = setTimeout(() => {
        setQuery("");
        setHighlight(0);
        inputRef.current?.focus();
      }, 0);
      return (): void => {
        clearTimeout(handle);
      };
    }
    return undefined;
  }, [open]);

  const updateQuery = (v: string): void => {
    setQuery(v);
    setHighlight(0);
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const cmd = filtered[highlight];
        if (cmd) {
          cmd.run();
          onClose();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return (): void => {
      window.removeEventListener("keydown", handler, { capture: true });
    };
  }, [open, filtered, highlight, onClose]);

  return { query, setQuery: updateQuery, highlight, setHighlight, inputRef, filtered, commands };
}

function modulesToCommands(): Command[] {
  return APP_MODULES.map((m: AppModule) => ({
    id: `go:${m.id}`,
    label: `Open ${m.labelKey}`,
    group: groupLabel(m.group),
    hint: m.shortcut ? `⌘${String(m.shortcut)}` : undefined,
    keywords: m.aliases ?? [],
    run: (): void => {
      useTabStore.getState().open({
        tabKey: `module:${m.id}`,
        title: m.labelKey,
        kind: "module",
        openedAt: Date.now(),
      });
    },
  }));
}

function groupLabel(g: AppModule["group"]): string {
  switch (g) {
    case "core":
      return "Core";
    case "models":
      return "Models";
    case "ops":
      return "Ops";
    case "observability":
      return "Observability";
    case undefined:
      return "Other";
    default:
      return "Other";
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
      const bonus = lastMatch === hi - 1 ? 3 : 1;
      score += bonus;
      lastMatch = hi;
      qi += 1;
    }
  }
  if (qi < q.length) return 0;
  return score - haystack.length * 0.01;
}
