import { useMemo } from "react";

import { useTabStore } from "@/stores/tab-store";
import { useThemeStore } from "@/stores/theme-store";
import { type ThemeId, THEMES } from "@/themes";

import type { Command } from "./command-palette";

/**
 * Supplemental command palette entries — real actions plus curated
 * View/New synonyms.
 */
export function useAppCommands(): Command[] {
  const themeId = useThemeStore((s) => s.themeId);
  const setThemeId = useThemeStore((s) => s.setThemeId);

  return useMemo<Command[]>(() => {
    return [
      ...buildThemeCommands(themeId, setThemeId),
      ...buildViewCommands(),
      ...buildNewCommands(),
      ...buildDevCommands(),
    ];
  }, [themeId, setThemeId]);
}

function openTab(id: string, title: string): void {
  useTabStore.getState().open({
    tabKey: `module:${id}`,
    title,
    kind: "module",
    openedAt: Date.now(),
  });
}

function buildThemeCommands(themeId: ThemeId, setThemeId: (id: ThemeId) => void): Command[] {
  const out: Command[] = THEMES.map(
    (t): Command => ({
      id: `theme:set:${t.id}`,
      label: `Theme: ${t.label}`,
      group: "Preferences",
      hint: themeId === t.id ? "current" : undefined,
      keywords: ["theme", "color", "palette", t.id, ...t.tagline.split(/\W+/)],
      run: (): void => {
        setThemeId(t.id);
      },
    }),
  );

  out.push({
    id: "theme:cycle",
    label: "Theme: Cycle",
    group: "Preferences",
    keywords: ["next theme", "switch theme"],
    run: (): void => {
      const idx = THEMES.findIndex((t) => t.id === themeId);
      const next = THEMES[(idx + 1) % THEMES.length] ?? THEMES[0];
      setThemeId(next.id);
    },
  });
  return out;
}

function buildViewCommands(): Command[] {
  return [
    {
      id: "view:dashboard:map",
      label: "View: Cluster map",
      group: "View",
      keywords: ["nodes", "map", "topology", "cluster"],
      run: (): void => {
        openTab("dashboard", "Dashboard");
      },
    },
    {
      id: "view:models:catalog",
      label: "View: Model catalog",
      group: "View",
      keywords: ["models", "catalog"],
      run: (): void => {
        openTab("models.catalog", "Catalog");
      },
    },
    {
      id: "view:models:pulls",
      label: "View: Pulls",
      group: "View",
      keywords: ["huggingface", "download", "pulls"],
      run: (): void => {
        openTab("models.pulls", "Pulls");
      },
    },
    {
      id: "view:models:bench",
      label: "View: Benchmarks",
      group: "View",
      keywords: ["bench", "benchmark", "tokens/sec"],
      run: (): void => {
        openTab("models.bench", "Bench");
      },
    },
    {
      id: "view:models:presets",
      label: "View: Preset promotions",
      group: "View",
      keywords: ["presets", "promote"],
      run: (): void => {
        openTab("models.presets", "Presets");
      },
    },
    {
      id: "view:knowledge:retrieval",
      label: "View: Retrieval",
      group: "View",
      keywords: ["rag", "retrieval", "knowledge"],
      run: (): void => {
        openTab("knowledge.retrieval", "Retrieval");
      },
    },
    {
      id: "view:knowledge:pipelines",
      label: "View: RAG pipelines",
      group: "View",
      keywords: ["rag", "pipelines", "ingestion", "crawl"],
      run: (): void => {
        openTab("knowledge.pipelines", "Pipelines");
      },
    },
    {
      id: "view:workloads:modelruns",
      label: "View: Model runs",
      group: "View",
      keywords: ["workloads", "modelruns", "apply"],
      run: (): void => {
        openTab("workloads.model-runs", "Model Runs");
      },
    },
    {
      id: "view:workloads:composites",
      label: "View: Composites",
      group: "View",
      keywords: ["composite", "compose", "multi-workload"],
      run: (): void => {
        openTab("workloads.composites", "Composites");
      },
    },
    {
      id: "view:ops:plan",
      label: "View: Planner",
      group: "View",
      keywords: ["plan", "planner", "operator plan"],
      run: (): void => {
        openTab("plan", "Planner");
      },
    },
  ];
}

function buildNewCommands(): Command[] {
  return [
    {
      id: "new:project",
      label: "New: Project",
      group: "New",
      keywords: ["project", "add", "create"],
      run: (): void => {
        openTab("projects", "Projects");
      },
    },
    {
      id: "new:workload",
      label: "New: Workload",
      group: "New",
      keywords: ["workload", "modelrun", "apply", "start server"],
      run: (): void => {
        openTab("workloads.model-runs", "Model Runs");
      },
    },
    {
      id: "new:chat",
      label: "New: Chat",
      group: "New",
      keywords: ["chat", "conversation"],
      run: (): void => {
        openTab("chat", "Chat");
      },
    },
    {
      id: "new:ops-chat",
      label: "New: Ops Chat session",
      group: "New",
      keywords: ["ops", "operator", "tool calling"],
      run: (): void => {
        openTab("ops-chat", "Ops Chat");
      },
    },
    {
      id: "new:pipeline",
      label: "New: RAG pipeline",
      group: "New",
      keywords: ["pipeline", "ingestion", "crawl", "index"],
      run: (): void => {
        openTab("knowledge.pipelines", "Pipelines");
      },
    },
  ];
}

function buildDevCommands(): Command[] {
  return [
    {
      id: "dev:reload",
      label: "Developer: Reload window",
      group: "Developer",
      keywords: ["reload", "refresh"],
      run: (): void => {
        window.location.reload();
      },
    },
    {
      id: "dev:devtools",
      label: "Developer: Toggle DevTools",
      group: "Developer",
      keywords: ["devtools", "inspector", "debug"],
      run: (): void => {
        try {
          const bridge = window as Window & { electron?: { toggleDevTools?: () => void } };
          bridge.electron?.toggleDevTools?.();
        } catch {
          /* ignore */
        }
      },
    },
  ];
}
