import { useMemo } from 'react';
import { useUIStore } from '@/stores/ui-store';
import { useThemeStore } from '@/stores/theme-store';
import { THEMES, type ThemeId } from '@/themes';
import type { Command } from './command-palette';

/**
 * Full palette command set — navigation + real actions, VSCode-style.
 * Actions are grouped by verb (View:, Theme:, Developer:, Open:).
 * Commands with side-effects run immediately; no prompt-input flow
 * yet (that lands when we add the two-step sub-palette pattern for
 * verbs that need a parameter — Pull Model..., Apply Manifest...,
 * Test Node...).
 */

export function useAppCommands(): Command[] {
  const setActiveModule = useUIStore((s) => s.setActiveModule);
  const themeId = useThemeStore((s) => s.themeId);
  const setThemeId = useThemeStore((s) => s.setThemeId);

  return useMemo<Command[]>(() => {
    const out: Command[] = [];

    // Theme commands — every theme gets a "Theme: <name>" verb so
    // the user can switch without opening the sub-picker.
    for (const t of THEMES) {
      out.push({
        id: `theme:set:${t.id}`,
        label: `Theme: ${t.label}`,
        group: 'Preferences',
        hint: themeId === t.id ? 'current' : undefined,
        keywords: ['theme', 'color', 'palette', t.id, ...(t.tagline.split(/\W+/))],
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

    // View actions — jump to a specific page + tab combo.
    out.push(
      {
        id: 'view:dashboard:map',
        label: 'View: Cluster Map',
        group: 'View',
        keywords: ['nodes', 'map', 'topology', 'cluster'],
        run: () => setActiveModule('dashboard'),
      },
      {
        id: 'view:models:catalog',
        label: 'View: Model Catalog',
        group: 'View',
        keywords: ['models', 'catalog'],
        run: () => {
          localStorage.setItem('llamactl-tab-models-page', 'catalog');
          setActiveModule('models');
        },
      },
      {
        id: 'view:models:pulls',
        label: 'View: Pulls (HF Downloads)',
        group: 'View',
        keywords: ['huggingface', 'download', 'pulls'],
        run: () => {
          localStorage.setItem('llamactl-tab-models-page', 'pulls');
          setActiveModule('models');
        },
      },
      {
        id: 'view:models:bench',
        label: 'View: Benchmarks',
        group: 'View',
        keywords: ['bench', 'benchmark', 'tokens/sec'],
        run: () => {
          localStorage.setItem('llamactl-tab-models-page', 'bench');
          setActiveModule('models');
        },
      },
      {
        id: 'view:models:presets',
        label: 'View: Preset Promotions',
        group: 'View',
        keywords: ['presets', 'promote'],
        run: () => {
          localStorage.setItem('llamactl-tab-models-page', 'presets');
          setActiveModule('models');
        },
      },
      {
        id: 'view:knowledge:retrieval',
        label: 'View: Retrieval (RAG)',
        group: 'View',
        keywords: ['rag', 'retrieval', 'knowledge'],
        run: () => {
          localStorage.setItem('llamactl-tab-knowledge-page', 'retrieval');
          setActiveModule('knowledge');
        },
      },
      {
        id: 'view:knowledge:pipelines',
        label: 'View: RAG Pipelines',
        group: 'View',
        keywords: ['rag', 'pipelines', 'ingestion', 'crawl'],
        run: () => {
          localStorage.setItem('llamactl-tab-knowledge-page', 'pipelines');
          setActiveModule('knowledge');
        },
      },
      {
        id: 'view:workloads:modelruns',
        label: 'View: Model Runs',
        group: 'View',
        keywords: ['workloads', 'modelruns', 'apply'],
        run: () => {
          localStorage.setItem('llamactl-tab-workloads-page', 'workloads');
          setActiveModule('workloads');
        },
      },
      {
        id: 'view:workloads:composites',
        label: 'View: Composites',
        group: 'View',
        keywords: ['composite', 'compose', 'multi-workload'],
        run: () => {
          localStorage.setItem('llamactl-tab-workloads-page', 'composites');
          setActiveModule('workloads');
        },
      },
      {
        id: 'view:ops:plan',
        label: 'View: Planner',
        group: 'View',
        keywords: ['plan', 'planner', 'operator plan'],
        run: () => {
          localStorage.setItem('llamactl-tab-ops-page', 'plan');
          setActiveModule('ops-chat');
        },
      },
    );

    // New / creation flows — jump to the tab + the form mounts in
    // focus. Actual focus management is the module's job; this
    // command just routes the operator there.
    out.push(
      {
        id: 'new:project',
        label: 'New: Project',
        group: 'New',
        keywords: ['project', 'add', 'create'],
        run: () => setActiveModule('projects'),
      },
      {
        id: 'new:workload',
        label: 'New: Workload (ModelRun)',
        group: 'New',
        keywords: ['workload', 'modelrun', 'apply', 'start server'],
        run: () => {
          localStorage.setItem('llamactl-tab-workloads-page', 'workloads');
          setActiveModule('workloads');
        },
      },
      {
        id: 'new:chat',
        label: 'New: Chat',
        group: 'New',
        keywords: ['chat', 'conversation'],
        run: () => setActiveModule('chat'),
      },
      {
        id: 'new:ops-chat',
        label: 'New: Ops Chat Session',
        group: 'New',
        keywords: ['ops', 'operator', 'tool calling'],
        run: () => {
          localStorage.setItem('llamactl-tab-ops-page', 'chat');
          setActiveModule('ops-chat');
        },
      },
      {
        id: 'new:pipeline',
        label: 'New: RAG Pipeline',
        group: 'New',
        keywords: ['pipeline', 'ingestion', 'crawl', 'index'],
        run: () => {
          localStorage.setItem('llamactl-tab-knowledge-page', 'pipelines');
          setActiveModule('knowledge');
        },
      },
    );

    // Developer / window actions
    out.push(
      {
        id: 'dev:reload',
        label: 'Developer: Reload Window',
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
  }, [setActiveModule, themeId, setThemeId]);
}
