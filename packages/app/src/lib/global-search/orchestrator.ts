import type { NodeItem } from "./surfaces/nodes";
import type { PresetItem } from "./surfaces/presets";
import type { TabHistoryState } from "./surfaces/tab-history";
import type { WorkloadItem } from "./surfaces/workloads";
// packages/app/src/lib/global-search/orchestrator.ts
import type { GroupedResults, Hit, ParsedQuery, SurfaceGroup, SurfaceKind } from "./types";

import { applySurfaceBias, sortGroups } from "./ranking";
import { matchModules } from "./surfaces/modules";
import { matchNodes } from "./surfaces/nodes";
import { matchPresets } from "./surfaces/presets";
import { matchTabHistory } from "./surfaces/tab-history";
import { matchWorkloads } from "./surfaces/workloads";

export interface ClientPhaseInput {
  query: ParsedQuery;
  tabState: TabHistoryState;
  workloads: WorkloadItem[];
  nodes: NodeItem[];
  presets: PresetItem[];
}

const SERVER_SURFACES: SurfaceKind[] = ["session", "logs"];

function groupHits(hits: Hit[]): SurfaceGroup[] {
  const groups = new Map<SurfaceKind, SurfaceGroup>();
  for (const h of hits) {
    let g = groups.get(h.surface);
    if (!g) {
      g = { surface: h.surface, hits: [], topScore: 0 };
      groups.set(h.surface, g);
    }
    g.hits.push(h);
    const final = applySurfaceBias(h);
    if (final > g.topScore) g.topScore = final;
  }
  for (const surface of SERVER_SURFACES) {
    if (!groups.has(surface)) {
      groups.set(surface, { surface, hits: [], topScore: 0, pending: true });
    }
  }
  return sortGroups([...groups.values()]);
}

export function runClientPhase(input: ClientPhaseInput): GroupedResults {
  const { needle, surfaceFilter } = input.query;
  if (!needle) return [];
  const allow = (s: SurfaceKind): boolean => !surfaceFilter || surfaceFilter === s;
  const hits: Hit[] = [];
  if (allow("module")) hits.push(...matchModules(needle));
  if (allow("tab-history")) hits.push(...matchTabHistory(needle, input.tabState));
  if (allow("workload")) hits.push(...matchWorkloads(needle, input.workloads));
  if (allow("node")) hits.push(...matchNodes(needle, input.nodes));
  if (allow("preset")) hits.push(...matchPresets(needle, input.presets));
  const groups = groupHits(hits);
  if (surfaceFilter) return groups.filter((g) => g.surface === surfaceFilter);
  return groups;
}

export interface MergeServerHitsOpts {
  append?: boolean;
  error?: string;
  unreachableNodes?: string[];
}

function hitKey(h: Hit): string {
  return `${h.parentId}\x00${h.match?.where ?? ""}\x00${h.match?.snippet ?? ""}`;
}

function dedupeHits(existing: Hit[], incoming: Hit[]): Hit[] {
  const seen = new Map<string, number>();
  const result: Hit[] = [];
  for (const h of existing) {
    seen.set(hitKey(h), result.length);
    result.push(h);
  }
  for (const h of incoming) {
    const k = hitKey(h);
    const idx = seen.get(k);
    if (idx !== undefined) {
      const prev = result[idx];
      if (prev !== undefined) {
        const matchKind =
          prev.matchKind === "semantic" || h.matchKind === "semantic" ? "semantic" : "exact";
        result[idx] = { ...prev, matchKind, score: Math.max(prev.score, h.score) };
      }
    } else {
      seen.set(k, result.length);
      result.push(h);
    }
  }
  return result;
}

export function mergeServerHits(
  current: GroupedResults,
  surface: SurfaceKind,
  hits: Hit[],
  opts: MergeServerHitsOpts = {},
): GroupedResults {
  const out = current.map((g) => {
    if (g.surface !== surface) return g;
    const merged = opts.append ? dedupeHits(g.hits, hits) : hits;
    let top = 0;
    for (const h of merged) {
      const f = applySurfaceBias(h);
      if (f > top) top = f;
    }
    return {
      surface: g.surface,
      hits: merged,
      topScore: top,
      pending: false,
      error: opts.error,
      ...(opts.unreachableNodes || g.unreachableNodes
        ? { unreachableNodes: opts.unreachableNodes ?? g.unreachableNodes }
        : {}),
    };
  });
  if (!current.some((g) => g.surface === surface)) {
    let top = 0;
    for (const h of hits) {
      const f = applySurfaceBias(h);
      if (f > top) top = f;
    }
    out.push({
      surface,
      hits,
      topScore: top,
      pending: false,
      error: opts.error,
      ...(opts.unreachableNodes ? { unreachableNodes: opts.unreachableNodes } : {}),
    });
  }
  return sortGroups(out);
}
