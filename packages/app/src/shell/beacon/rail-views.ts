import {
  Coins,
  Compass,
  Folder,
  Layers3,
  Search,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';

export type RailViewId =
  | 'explorer'
  | 'search'
  | 'sessions'
  | 'fleet'
  | 'cost'
  | 'settings';

export interface RailView {
  id: RailViewId;
  label: string;
  icon: LucideIcon;
  position: 'top' | 'bottom';
  /** P2 stub views render a "coming in P3" placeholder. */
  stub?: boolean;
}

export const RAIL_VIEWS: readonly RailView[] = [
  { id: 'explorer', label: 'Explorer', icon: Folder,  position: 'top' },
  { id: 'search',   label: 'Search',   icon: Search,  position: 'top', stub: true },
  { id: 'sessions', label: 'Sessions', icon: Layers3, position: 'top', stub: true },
  { id: 'fleet',    label: 'Fleet',    icon: Compass, position: 'top', stub: true },
  { id: 'cost',     label: 'Cost',     icon: Coins,   position: 'bottom' },
  { id: 'settings', label: 'Settings', icon: SettingsIcon, position: 'bottom' },
];

export function getRailView(id: RailViewId): RailView {
  return RAIL_VIEWS.find((v) => v.id === id) ?? RAIL_VIEWS[0]!;
}
