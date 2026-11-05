// #410 P5a, workloads tab scoping: rows for the current tab, per-node
// counts for the rest, and deep-link classification (here / elsewhere /
// missing) without making a network call. The open-drawer selection is
// pure so a route change (popstate from /workloads/a to /workloads/b)
// can be pinned without a mounted component.

import type { StatusDotTone } from "@/ui";

import { consoleHref } from "./router";

export interface ConsoleWorkloadRow {
  name: string;
  kind: "ModelRun" | "ModelHost";
  node: string;
  endpoint: string | null;
  workerNodes: string[];
  [k: string]: unknown;
}

export function workloadsForTab<R extends ConsoleWorkloadRow>(
  rows: readonly R[],
  tabNode: string,
): { rows: R[]; others: { node: string; count: number; href: string }[] } {
  const tabRows: R[] = [];
  const otherCounts = new Map<string, number>();

  for (const row of rows) {
    if (row.node === tabNode) {
      tabRows.push(row);
    } else {
      otherCounts.set(row.node, (otherCounts.get(row.node) ?? 0) + 1);
    }
  }

  const others = [...otherCounts.entries()]
    .map(([node, count]) => ({
      node,
      count,
      href: consoleHref({ view: "workloads", node }),
    }))
    .sort((a, b) => a.node.localeCompare(b.node));

  return { rows: tabRows, others };
}

export type WorkloadLocationResult<R extends ConsoleWorkloadRow> =
  | { kind: "here"; row: R }
  | { kind: "elsewhere"; node: string; message: string; href: string }
  | { kind: "missing" };

export function workloadLocation<R extends ConsoleWorkloadRow>(
  rows: readonly R[],
  name: string,
  tabNode: string,
): WorkloadLocationResult<R> {
  // Prefer a row on tabNode with that name.
  const onTab = rows.find((row) => row.node === tabNode && row.name === name);
  if (onTab !== undefined) {
    return { kind: "here", row: onTab };
  }

  // Otherwise find the first row with that name elsewhere.
  const elsewhere = rows.find((row) => row.name === name && row.node !== tabNode);
  if (elsewhere !== undefined) {
    return {
      kind: "elsewhere",
      node: elsewhere.node,
      message: `This workload runs on ${elsewhere.node}. Switch this tab or open a new one`,
      href: consoleHref({ view: "workloads", workload: name, node: elsewhere.node }),
    };
  }

  return { kind: "missing" };
}

export function openWorkloadName(
  rows: readonly ConsoleWorkloadRow[],
  workload: string | undefined,
  tabNode: string,
): string | null {
  if (workload === undefined) return null;
  const location = workloadLocation(rows, workload, tabNode);
  return location.kind === "here" ? location.row.name : null;
}

// Card keys must change exactly when a deep-link move toggles a card's
// route membership: remounting on key change is what makes the drawer
// follow /workloads/a → /workloads/b without a state-syncing effect.
export function workloadCardKey(name: string, routeOpen: string | null): string {
  return `${name}#${routeOpen === name ? "open" : "shut"}`;
}

export function phaseTone(phase: string): StatusDotTone {
  if (phase === "Running") return "ok";
  if (phase === "Mismatch") return "warn";
  if (phase === "Unreachable" || phase === "Foreign") return "err";
  return "idle";
}
