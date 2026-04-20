import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import {
  Activity,
  Boxes,
  Brain,
  BrainCircuit,
  Coins,
  Database,
  Download,
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
const LazyOpsChat = lazy(() => import('./ops-chat/index'));
const LazyCost = lazy(() => import('./cost/index'));
const LazySettings = lazy(() => import('./settings/index'));

export const APP_MODULES: AppModule[] = [
  {
    id: 'dashboard',
    labelKey: 'Dashboard',
    icon: LayoutDashboard,
    Component: LazyDashboard,
    shortcut: 1,
  },
  {
    id: 'nodes',
    labelKey: 'Nodes',
    icon: Network,
    Component: LazyNodes,
    shortcut: 2,
  },
  {
    id: 'chat',
    labelKey: 'Chat',
    icon: MessageSquare,
    Component: LazyChat,
    shortcut: 3,
  },
  {
    id: 'plan',
    labelKey: 'Plan',
    icon: BrainCircuit,
    Component: LazyPlan,
  },
  {
    id: 'knowledge',
    labelKey: 'Knowledge',
    icon: Brain,
    Component: LazyKnowledge,
  },
  {
    id: 'ops-chat',
    labelKey: 'Operator Console',
    icon: Terminal,
    Component: LazyOpsChat,
  },
  {
    id: 'cost',
    labelKey: 'Cost',
    icon: Coins,
    Component: LazyCost,
  },
  {
    id: 'pipelines',
    labelKey: 'Pipelines',
    icon: Workflow,
    Component: LazyPipelines,
  },
  {
    id: 'workloads',
    labelKey: 'Workloads',
    icon: Layers,
    Component: LazyWorkloads,
    shortcut: 4,
  },
  {
    id: 'composites',
    labelKey: 'Composites',
    icon: Boxes,
    Component: LazyComposites,
  },
  {
    id: 'models',
    labelKey: 'Models',
    icon: Database,
    Component: LazyModels,
    shortcut: 5,
  },
  {
    id: 'presets',
    labelKey: 'Presets',
    icon: Star,
    Component: LazyPresets,
  },
  {
    id: 'pulls',
    labelKey: 'Pulls',
    icon: Download,
    Component: LazyPulls,
    shortcut: 6,
  },
  {
    id: 'bench',
    labelKey: 'Bench',
    icon: Activity,
    Component: LazyBench,
    shortcut: 7,
  },
  {
    id: 'server',
    labelKey: 'Server',
    icon: ServerIcon,
    Component: LazyServer,
    shortcut: 8,
  },
  {
    id: 'logs',
    labelKey: 'Logs',
    icon: ScrollText,
    Component: LazyLogs,
    shortcut: 9,
  },
  {
    id: 'lmstudio',
    labelKey: 'LM Studio',
    icon: PackagePlus,
    Component: LazyLMStudio,
  },
  {
    id: 'settings',
    labelKey: 'Settings',
    icon: Settings,
    Component: LazySettings,
    position: 'bottom',
  },
];
