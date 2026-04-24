import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import {
  Brain,
  Coins,
  Database,
  FolderKanban,
  LayoutDashboard,
  Layers,
  MessageSquare,
  Network,
  ScrollText,
  Settings,
  Terminal,
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

  /** Beacon (P2+). Where this leaf renders in the Explorer tree.
   *  Parallel to `group`; required for every leaf the Beacon Explorer
   *  shows. Legacy IDELayout ignores it. */
  beaconGroup?:
    | 'workspace'
    | 'ops'
    | 'models'
    | 'knowledge'
    | 'observability'
    | 'settings'
    | 'hidden';

  /** Beacon kind — `static` leaves are 1:1 with a tab; `dynamic-group`
   *  leaves are containers whose children come from a runtime
   *  query (workloads, nodes, ops sessions). Legacy shell ignores. */
  beaconKind?: 'static' | 'dynamic-group';

  /** Ordering hint inside the beaconGroup — lower values come first.
   *  Ties fall back to the order in the registry array. */
  beaconOrder?: number;
}

const LazyDashboard = lazy(() => import('./dashboard/index'));
const LazyNodes = lazy(() => import('./nodes/index'));
const LazyChat = lazy(() => import('./chat/index'));
const LazyLogs = lazy(() => import('./logs/index'));
const LazyProjects = lazy(() => import('./projects/index'));
const LazyCost = lazy(() => import('./cost/index'));
const LazySettings = lazy(() => import('./settings/index'));
const LazyUIPrimitives = lazy(() => import('./ui-primitives/index'));

// Tabbed grouped pages — each bundles several formerly-top-level
// modules into tabs. Activity bar shows only the group; the
// palette jumps to the group + the chosen tab is sticky per-user.
const LazyModelsPage = lazy(() => import('./models-tabbed/index'));
const LazyKnowledgePage = lazy(() => import('./knowledge-tabbed/index'));
const LazyWorkloadsPage = lazy(() => import('./workloads-tabbed/index'));
const LazyOpsChat = lazy(() => import('./ops-chat/index'));
const LazyPlan = lazy(() => import('./plan/index'));

/**
 * Registry — sharp distinction between "activity bar items" (always
 * visible in the sidebar — the 8 modules an operator reaches for
 * daily) and "command-palette-only" modules (still fully mounted,
 * still stateful, just not taking up sidebar real estate).
 *
 * Rough triage:
 *   always visible: dashboard, chat, ops-chat, projects, knowledge,
 *                   workloads, nodes, logs + settings (bottom)
 *   palette only:   plan, pipelines (into knowledge later),
 *                   composites (into workloads later),
 *                   models/presets/pulls/bench/lmstudio (all about
 *                   managing the catalog — unify later),
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
    beaconGroup: 'workspace',
    beaconKind: 'static',
    beaconOrder: 10,
  },
  {
    id: 'chat',
    labelKey: 'Chat',
    icon: MessageSquare,
    Component: LazyChat,
    shortcut: 2,
    activityBar: true,
    group: 'core',
    beaconGroup: 'workspace',
    beaconKind: 'static',
    beaconOrder: 20,
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
    beaconGroup: 'ops',
    beaconKind: 'static',
    beaconOrder: 10,
  },
  {
    id: 'plan',
    labelKey: 'Planner',
    icon: Terminal,
    Component: LazyPlan,
    activityBar: false,
    group: 'ops',
    aliases: ['plan', 'planner'],
    beaconGroup: 'ops',
    beaconKind: 'static',
    beaconOrder: 15,
  },
  {
    id: 'projects',
    labelKey: 'Projects',
    icon: FolderKanban,
    Component: LazyProjects,
    shortcut: 4,
    activityBar: true,
    group: 'core',
    beaconGroup: 'workspace',
    beaconKind: 'static',
    beaconOrder: 30,
  },
  {
    id: 'knowledge',
    labelKey: 'Knowledge',
    icon: Brain,
    Component: LazyKnowledgePage,
    shortcut: 5,
    activityBar: true,
    group: 'core',
    aliases: ['rag', 'retrieval', 'pipelines', 'ingest'],
    beaconGroup: 'knowledge',
    beaconKind: 'static',
    beaconOrder: 10,
  },
  {
    id: 'workloads',
    labelKey: 'Workloads',
    icon: Layers,
    Component: LazyWorkloadsPage,
    shortcut: 6,
    activityBar: true,
    group: 'ops',
    aliases: ['modelruns', 'composites'],
    beaconGroup: 'ops',
    beaconKind: 'dynamic-group',
    beaconOrder: 20,
  },
  {
    id: 'models',
    labelKey: 'Models',
    icon: Database,
    Component: LazyModelsPage,
    shortcut: 7,
    activityBar: true,
    group: 'models',
    aliases: ['catalog', 'presets', 'pulls', 'bench', 'lmstudio'],
    beaconGroup: 'models',
    beaconKind: 'static',
    beaconOrder: 10,
  },
  {
    id: 'nodes',
    labelKey: 'Nodes',
    icon: Network,
    Component: LazyNodes,
    shortcut: 8,
    activityBar: true,
    group: 'ops',
    aliases: ['cluster', 'fleet'],
    beaconGroup: 'ops',
    beaconKind: 'dynamic-group',
    beaconOrder: 30,
  },
  {
    id: 'logs',
    labelKey: 'Logs',
    icon: ScrollText,
    Component: LazyLogs,
    shortcut: 9,
    activityBar: true,
    group: 'observability',
    beaconGroup: 'observability',
    beaconKind: 'static',
    beaconOrder: 10,
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
    beaconGroup: 'hidden',
    beaconKind: 'static',
  },
  {
    id: 'settings',
    labelKey: 'Settings',
    icon: Settings,
    Component: LazySettings,
    activityBar: true,
    position: 'bottom',
    group: 'core',
    beaconGroup: 'hidden',
    beaconKind: 'static',
  },
  {
    id: 'ui-primitives',
    labelKey: 'UI Primitives',
    icon: FolderKanban, // reused — P2/P3 will swap this when the registry schema changes
    Component: LazyUIPrimitives,
    activityBar: false,
    group: 'core',
    aliases: ['sandbox', 'components', 'primitives', 'beacon'],
    beaconGroup: 'hidden',
    beaconKind: 'static',
  },
];
