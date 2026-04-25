// packages/app/src/lib/global-search/types.ts
export type SurfaceKind =
  | 'module'
  | 'tab-history'
  | 'workload'
  | 'node'
  | 'preset'
  | 'session'
  | 'knowledge'
  | 'logs';

export type MatchKind = 'exact' | 'semantic';

export interface MatchExcerpt {
  where: string;
  snippet: string;
  spans: { start: number; end: number }[];
}

export type HitAction =
  | { kind: 'open-tab'; tab: any }
  | { kind: 'command'; id: string };

export interface Hit {
  surface: SurfaceKind;
  parentId: string;
  parentTitle: string;
  score: number;
  matchKind: MatchKind;
  /** Distance metric from semantic search, if applicable. */
  ragDistance?: number;
  match?: MatchExcerpt;
  action: HitAction;
}

export interface SurfaceGroup {
  surface: SurfaceKind;
  hits: Hit[];
  topScore: number;
  /** True if a server fetch for this surface is in flight. */
  pending?: boolean;
  error?: string;
}

export type GroupedResults = SurfaceGroup[];

export interface ParsedQuery {
  needle: string;
  surfaceFilter?: SurfaceKind;
}