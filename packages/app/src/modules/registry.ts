import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import {
  Activity,
  Database,
  Download,
  LayoutDashboard,
  Layers,
  Network,
  PackagePlus,
  Server as ServerIcon,
  Settings,
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
const LazyWorkloads = lazy(() => import('./workloads/index'));
const LazyModels = lazy(() => import('./models/index'));
const LazyPulls = lazy(() => import('./pulls/index'));
const LazyBench = lazy(() => import('./bench/index'));
const LazyServer = lazy(() => import('./server/index'));
const LazyLMStudio = lazy(() => import('./lmstudio/index'));
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
    id: 'workloads',
    labelKey: 'Workloads',
    icon: Layers,
    Component: LazyWorkloads,
    shortcut: 3,
  },
  {
    id: 'models',
    labelKey: 'Models',
    icon: Database,
    Component: LazyModels,
    shortcut: 4,
  },
  {
    id: 'pulls',
    labelKey: 'Pulls',
    icon: Download,
    Component: LazyPulls,
    shortcut: 5,
  },
  {
    id: 'bench',
    labelKey: 'Bench',
    icon: Activity,
    Component: LazyBench,
    shortcut: 6,
  },
  {
    id: 'server',
    labelKey: 'Server',
    icon: ServerIcon,
    Component: LazyServer,
    shortcut: 7,
  },
  {
    id: 'lmstudio',
    labelKey: 'LM Studio',
    icon: PackagePlus,
    Component: LazyLMStudio,
    shortcut: 8,
  },
  {
    id: 'settings',
    labelKey: 'Settings',
    icon: Settings,
    Component: LazySettings,
    position: 'bottom',
  },
];
