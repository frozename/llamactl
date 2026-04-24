import { useMemo } from 'react';
import { useTabStore } from '@/stores/tab-store';
import { useThemeStore } from '@/stores/theme-store';
import { THEMES, type ThemeId } from '@/themes';
import type { Command } from './command-palette';

/**
 * Supplemental command palette entries — real actions plus curated
 * View/New synonyms. Per-module "Open X" commands are generated
 * directly from APP_MODULES in the palette itself; these commands
 * cover the verbs that don't map 1:1 with a registry entry (theme
 * switches, developer tools, creation flows that land on a specific
 * module).
 */
export function useAppCommands(): Command[] {
  const themeId = useThemeStore((s) => s.themeId);
  const setThemeId = useThemeStore((s) => s.setThemeId);

  return useMemo<Command[]>(() => {
    const out: Command[] = [];
    const openTab = (id: string, title: string): void => {
      useTabStore.getState().open({
        tabKey: `module:${id}`,
        title,
        kind: 'module',
        openedAt: Date.now(),
      });
    };

    for (const t of THEMES) {
      out.push({
        id: `theme:set:${t.id}`,
        label: `Theme: ${t.label}`,
        group: 'Preferences',
        hint: themeId === t.id ? 'current' : undefined,
        keywords: ['theme', 'color', 'palette', t.id, ...t.tagline.split(/\W+/)],
        run: () => setThemeId(t.id as ThemeId),
      });
    }
    out.push({
      id: 'theme:cycle',
      label: 'Theme: Cycle',
      group: 'Preferences',
      keywords: ['next theme', 'switch theme'],
      run: () => {
        const idx = THEMES.findIndex((t) => t.id === themeId);
        const next = THEMES[(idx + 1) % THEMES.length]!;
        setThemeId(next.id as ThemeId);
      },
    });

    out.push(
      {
        id: 'view:dashboard:map',
        label: 'View: Cluster map',
        group: 'View',
        keywords: ['nodes', 'map', 'topology', 'cluster'],
        run: () => openTab('dashboard', 'Dashboard'),
      },
      {
        id: 'view:models:catalog',
        label: 'View: Model catalog',
        group: 'View',
        keywords: ['models', 'catalog'],
        run: () => openTab('models.catalog', 'Catalog'),
      },
      {
        id: 'view:models:pulls',
        label: 'View: Pulls',
        group: 'View',
        keywords: ['huggingface', 'download', 'pulls'],
        run: () => openTab('models.pulls', 'Pulls'),
      },
      {
        id: 'view:models:bench',
        label: 'View: Benchmarks',
        group: 'View',
        keywords: ['bench', 'benchmark', 'tokens/sec'],
        run: () => openTab('models.bench', 'Bench'),
      },
      {
        id: 'view:models:presets',
        label: 'View: Preset promotions',
        group: 'View',
        keywords: ['presets', 'promote'],
        run: () => openTab('models.presets', 'Presets'),
      },
      {
        id: 'view:knowledge:retrieval',
        label: 'View: Retrieval',
        group: 'View',
        keywords: ['rag', 'retrieval', 'knowledge'],
        run: () => openTab('knowledge.retrieval', 'Retrieval'),
      },
      {
        id: 'view:knowledge:pipelines',
        label: 'View: RAG pipelines',
        group: 'View',
        keywords: ['rag', 'pipelines', 'ingestion', 'crawl'],
        run: () => openTab('knowledge.pipelines', 'Pipelines'),
      },
      {
        id: 'view:workloads:modelruns',
        label: 'View: Model runs',
        group: 'View',
        keywords: ['workloads', 'modelruns', 'apply'],
        run: () => openTab('workloads.model-runs', 'Model Runs'),
      },
      {
        id: 'view:workloads:composites',
        label: 'View: Composites',
        group: 'View',
        keywords: ['composite', 'compose', 'multi-workload'],
        run: () => openTab('workloads.composites', 'Composites'),
      },
      {
        id: 'view:ops:plan',
        label: 'View: Planner',
        group: 'View',
        keywords: ['plan', 'planner', 'operator plan'],
        run: () => openTab('plan', 'Planner'),
      },
    );

    out.push(
      {
        id: 'new:project',
        label: 'New: Project',
        group: 'New',
        keywords: ['project', 'add', 'create'],
        run: () => openTab('projects', 'Projects'),
      },
      {
        id: 'new:workload',
        label: 'New: Workload',
        group: 'New',
        keywords: ['workload', 'modelrun', 'apply', 'start server'],
        run: () => openTab('workloads.model-runs', 'Model Runs'),
      },
      {
        id: 'new:chat',
        label: 'New: Chat',
        group: 'New',
        keywords: ['chat', 'conversation'],
        run: () => openTab('chat', 'Chat'),
      },
      {
        id: 'new:ops-chat',
        label: 'New: Ops Chat session',
        group: 'New',
        keywords: ['ops', 'operator', 'tool calling'],
        run: () => openTab('ops-chat', 'Ops Chat'),
      },
      {
        id: 'new:pipeline',
        label: 'New: RAG pipeline',
        group: 'New',
        keywords: ['pipeline', 'ingestion', 'crawl', 'index'],
        run: () => openTab('knowledge.pipelines', 'Pipelines'),
      },
    );

    out.push(
      {
        id: 'dev:reload',
        label: 'Developer: Reload window',
        group: 'Developer',
        keywords: ['reload', 'refresh'],
        run: () => window.location.reload(),
      },
      {
        id: 'dev:devtools',
        label: 'Developer: Toggle DevTools',
        group: 'Developer',
        keywords: ['devtools', 'inspector', 'debug'],
        run: () => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).electron?.toggleDevTools?.();
          } catch {
            /* electron bridge may not expose this; no-op */
          }
        },
      },
    );

    return out;
  }, [themeId, setThemeId]);
}
