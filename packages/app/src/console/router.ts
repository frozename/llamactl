// #410 P5a, console path router: four views, optional deep-link on
// workloads and logs, ?node= validation against the console node-name
// rule, unknown paths degrade to fleet notFound.

import type { ConsoleViewId } from "./console-manifest";

import { CONSOLE_MODULES } from "./console-manifest";
import { isConsoleNodeName } from "./node-scope";

const VIEW_ROUTES: ReadonlyMap<string, ConsoleViewId> = new Map([
  ["fleet", "fleet"],
  ["workloads", "workloads"],
  ["nodes", "nodes"],
  ["logs", "logs"],
]);

export interface ConsoleRoute {
  view: ConsoleViewId;
  workload?: string;
  node?: string;
  invalidNode?: string;
  notFound?: true;
}

function parsePathname(pathname: string): { view: ConsoleViewId | null; workload: string | null } {
  const segments = pathname.split("/").filter((s) => s.length > 0);

  // Root path "/" → empty segments → fleet.
  if (segments.length === 0) return { view: "fleet", workload: null };

  const [first, second, third] = segments;

  const viewId = first === undefined ? undefined : VIEW_ROUTES.get(first);
  if (viewId === undefined) return { view: null, workload: null };
  if (viewId === "fleet") return { view: "fleet", workload: null };

  // For workloads and logs: 1 segment = view only, 2 segments = view + workload,
  // 3+ segments = notFound (handled by caller).
  // For nodes: only 1 segment is valid; 2+ = notFound.
  if (third !== undefined) return { view: null, workload: null };
  if (viewId === "nodes" && second !== undefined) return { view: null, workload: null };
  if (viewId === "nodes") return { view: "nodes", workload: null };
  if (second === undefined) return { view: viewId, workload: null };

  // Second segment is the workload name (workloads or logs).
  try {
    const decoded = decodeURIComponent(second);
    return { view: viewId, workload: decoded };
  } catch {
    return { view: null, workload: null };
  }
}

function parseNodeParam(search: string): string | null {
  try {
    return new URLSearchParams(search).get("node");
  } catch {
    return null;
  }
}

export function parseConsoleRoute(pathname: string, search: string): ConsoleRoute {
  try {
    const { view, workload } = parsePathname(pathname);

    const nodeParam = parseNodeParam(search);
    const nodeResult: { node?: string; invalidNode?: string } =
      nodeParam === null
        ? {}
        : isConsoleNodeName(nodeParam)
          ? { node: nodeParam }
          : { invalidNode: nodeParam };

    if (view === null) {
      return { view: "fleet", notFound: true, ...nodeResult };
    }

    const base: ConsoleRoute = { view, ...nodeResult };
    if (workload !== null) {
      return { ...base, workload };
    }
    return base;
  } catch {
    return { view: "fleet", notFound: true };
  }
}

export function consoleHref(route: Pick<ConsoleRoute, "view" | "workload" | "node">): string {
  const module = CONSOLE_MODULES.find((m) => m.id === route.view);
  let path = module?.path ?? "/";

  // Only workloads and logs views get a workload deep link.
  if (route.workload !== undefined && (route.view === "workloads" || route.view === "logs")) {
    path += `/${encodeURIComponent(route.workload)}`;
  }

  if (route.node !== undefined) {
    path += `?node=${encodeURIComponent(route.node)}`;
  }

  return path;
}
