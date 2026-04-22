import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import {
  Activity,
  Boxes,
  Brain,
  BrainCircuit,
  Coins,
  Database,
  Download,
  FolderKanban,
  LayoutDashboard,
  Layers,
  MessageSquare,
  Network,
  PackagePlus,
  ScrollText,
  Server as ServerIcon,
  Settings,
  Star,
  Terminal,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

/**
 * Activity-bar module descriptor. To add a new module:
 *   1. Create `src/modules/<id>/` with an `index.tsx` that default-exports
 *      a React component for the main view.
 *   2. Add a registry entry below.
 *   3. Optionally pin to `position: 'bottom'` for the lower edge of the
 *      activity bar (used today for settings).
 */
export interface AppModule {
  id: string;
  labelKey: string;
  icon: LucideIcon;
  Component: LazyExoticComponent<ComponentType>;
  /** Top (default) or pinned to the bottom of the activity bar. */
  position?: 'top' | 'bottom';
  /** 1..9 keyboard shortcut when we wire the palette in later. */
  shortcut?: number;
  /**
   * Module grouping — used by the command palette to organize + search.
   * Hidden from the activity bar unless explicitly shown via
   * `activityBar: true`. Modules without activityBar:true are still
   * reachable via the command palette (⌘⇧P).
   */
  activityBar?: boolean;
  group?: 'core' | 'models' | 'ops' | 'observability';
  aliases?: string[];
}

const LazyDashboard = lazy(() => import('./dashboard/index'));
const LazyNodes = lazy(() => import('./nodes/index'));
const LazyChat = lazy(() => import('./chat/index'));
const LazyPipelines = lazy(() => import('./pipelines/index'));
const LazyWorkloads = lazy(() => import('./workloads/index'));
const LazyComposites = lazy(() => import('./composites/index'));
const LazyModels = lazy(() => import('./models/index'));
const LazyPresets = lazy(() => import('./presets/index'));
const LazyPulls = lazy(() => import('./pulls/index'));
const LazyBench = lazy(() => import('./bench/index'));
const LazyServer = lazy(() => import('./server/index'));
const LazyLogs = lazy(() => import('./logs/index'));
const LazyLMStudio = lazy(() => import('./lmstudio/index'));
const LazyPlan = lazy(() => import('./plan/index'));
const LazyKnowledge = lazy(() => import('./knowledge/index'));
const LazyProjects = lazy(() => import('./projects/index'));
const LazyOpsChat = lazy(() => import('./ops-chat/index'));
const LazyCost = lazy(() => import('./cost/index'));
const LazySettings = lazy(() => import('./settings/index'));

/**
 * Registry — sharp distinction between "activity bar items" (always
 * visible in the sidebar — the 8 modules an operator reaches for
 * daily) and "command-palette-only" modules (still fully mounted,
 * still stateful, just not taking up sidebar real estate).
 *
 * Rough triage:
 *   always visible: dashboard, chat, ops-chat, projects, knowledge,
 *                   workloads, nodes, logs + settings (bottom)
 *   palette only:   plan (subsumed by ops-chat), pipelines (into
 *                   knowledge later), composites (into workloads
 *                   later), models/presets/pulls/bench/lmstudio
 *                   (all about managing the catalog — unify later),
 *                   server (local-only legacy), cost (→ bottom)
 */
export const APP_MODULES: AppModule[] = [
  // ── Activity bar: top ─────────────────────────────────────
  {
    id: 'dashboard',
    labelKey: 'Dashboard',
    icon: LayoutDashboard,
    Component: LazyDashboard,
    shortcut: 1,
    activityBar: true,
    group: 'core',
    aliases: ['home', 'overview'],
  },
  {
    id: 'chat',
    labelKey: 'Chat',
    icon: MessageSquare,
    Component: LazyChat,
    shortcut: 2,
    activityBar: true,
    group: 'core',
  },
  {
    id: 'ops-chat',
    labelKey: 'Ops Chat',
    icon: Terminal,
    Component: LazyOpsChat,
    shortcut: 3,
    activityBar: true,
    group: 'ops',
    aliases: ['operator console', 'operator'],
  },
  {
    id: 'projects',
    labelKey: 'Projects',
    icon: FolderKanban,
    Component: LazyProjects,
    shortcut: 4,
    activityBar: true,
    group: 'core',
  },
  {
    id: 'knowledge',
    labelKey: 'Knowledge',
    icon: Brain,
    Component: LazyKnowledge,
    shortcut: 5,
    activityBar: true,
    group: 'core',
    aliases: ['rag', 'retrieval'],
  },
  {
    id: 'workloads',
    labelKey: 'Workloads',
    icon: Layers,
    Component: LazyWorkloads,
    shortcut: 6,
    activityBar: true,
    group: 'ops',
  },
  {
    id: 'nodes',
    labelKey: 'Nodes',
    icon: Network,
    Component: LazyNodes,
    shortcut: 7,
    activityBar: true,
    group: 'ops',
    aliases: ['cluster', 'fleet'],
  },
  {
    id: 'logs',
    labelKey: 'Logs',
    icon: ScrollText,
    Component: LazyLogs,
    shortcut: 8,
    activityBar: true,
    group: 'observability',
  },
  // ── Activity bar: bottom ──────────────────────────────────
  {
    id: 'cost',
    labelKey: 'Cost',
    icon: Coins,
    Component: LazyCost,
    activityBar: true,
    position: 'bottom',
    group: 'observability',
  },
  {
    id: 'settings',
    labelKey: 'Settings',
    icon: Settings,
    Component: LazySettings,
    activityBar: true,
    position: 'bottom',
    group: 'core',
  },
  // ── Command palette only ──────────────────────────────────
  {
    id: 'models',
    labelKey: 'Models',
    icon: Database,
    Component: LazyModels,
    group: 'models',
    aliases: ['catalog'],
  },
  {
    id: 'presets',
    labelKey: 'Presets',
    icon: Star,
    Component: LazyPresets,
    group: 'models',
  },
  {
    id: 'pulls',
    labelKey: 'Pulls',
    icon: Download,
    Component: LazyPulls,
    group: 'models',
    aliases: ['hf', 'huggingface', 'download'],
  },
  {
    id: 'bench',
    labelKey: 'Bench',
    icon: Activity,
    Component: LazyBench,
    group: 'models',
    aliases: ['benchmark'],
  },
  {
    id: 'lmstudio',
    labelKey: 'LM Studio Import',
    icon: PackagePlus,
    Component: LazyLMStudio,
    group: 'models',
  },
  {
    id: 'pipelines',
    labelKey: 'RAG Pipelines',
    icon: Workflow,
    Component: LazyPipelines,
    group: 'core',
    aliases: ['ingestion'],
  },
  {
    id: 'composites',
    labelKey: 'Composites',
    icon: Boxes,
    Component: LazyComposites,
    group: 'ops',
  },
  {
    id: 'plan',
    labelKey: 'Plan',
    icon: BrainCircuit,
    Component: LazyPlan,
    group: 'ops',
    aliases: ['planner', 'operator plan'],
  },
  {
    id: 'server',
    labelKey: 'Local Server',
    icon: ServerIcon,
    Component: LazyServer,
    group: 'models',
    aliases: ['llama-server'],
  },
];
