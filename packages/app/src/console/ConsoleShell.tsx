// #410 P5a-3b, the console shell: four-view nav carrying the tab node,
// a dispatchable-node tab selector fed by nodeList from inside the
// provider, the invalid-session banner, the rejected-node notice, the
// unknown-path notice and a timer-free toast host. Location is read
// through the cast pattern from node-scope so SSR stays type-safe; no
// Electron import reaches this tree.

import type { MouseEvent } from "react";

import * as React from "react";

import { Button } from "@/ui";

import type { ConsoleViewId } from "./console-manifest";
import type { ConsoleNodeEntry, ConsoleNodeList } from "./node-scope";
import type { ConsoleRoute } from "./router";

import { CONSOLE_MODULES } from "./console-manifest";
import { dispatchableNodes, useTabNode } from "./node-scope";
import { NodeScopedProvider } from "./node-scoped-provider";
import { useNodeTrpc } from "./node-trpc";
import { consoleHref, parseConsoleRoute } from "./router";
import { INVALID_SESSION_MESSAGE, useInvalidSession } from "./session-store";
import { WorkloadsView } from "./views/workloads";

interface ShellLocation {
  pathname: string;
  route: ConsoleRoute;
}

function readLocation(): ShellLocation {
  const location = (globalThis as { location?: { pathname: string; search: string } }).location;
  const pathname = location?.pathname ?? "/";
  const search = location?.search ?? "";
  return { pathname, route: parseConsoleRoute(pathname, search) };
}

// Placeholder testids are console-placeholder-*, never console-view-*:
// the console-view-* id is emitted only by the real view modules, so a
// routing regression to a placeholder cannot pass a view-content test.
function PlaceholderView({ id, label }: { id: ConsoleViewId; label: string }): React.JSX.Element {
  return (
    <section data-testid={`console-placeholder-${id}`} style={{ padding: 16 }}>
      <h1 style={{ fontSize: 16, margin: 0 }}>{label}</h1>
    </section>
  );
}

function RoutedView({
  route,
  onSuccessToast,
}: {
  route: ConsoleRoute;
  onSuccessToast: (text: string) => void;
}): React.JSX.Element {
  switch (route.view) {
    case "workloads":
      return <WorkloadsView route={route} onSuccessToast={onSuccessToast} />;
    case "fleet":
      return <PlaceholderView id="fleet" label="Fleet" />;
    case "nodes":
      return <PlaceholderView id="nodes" label="Nodes" />;
    case "logs":
      return <PlaceholderView id="logs" label="Logs" />;
  }
}

function ConsoleTitleBar({
  route,
  tabNode,
  onSelectNode,
  onNodeList,
  onNavigate,
}: {
  route: ConsoleRoute;
  tabNode: string;
  onSelectNode: (name: string) => void;
  onNodeList: (list: ConsoleNodeList) => void;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, route: ConsoleRoute) => void;
}): React.JSX.Element {
  const nodesQuery = useNodeTrpc().nodeList.useQuery();
  const data = nodesQuery.data as ConsoleNodeList | undefined;
  React.useEffect(() => {
    if (data !== undefined) {
      onNodeList(data);
    }
  }, [data, onNodeList]);
  const options = dispatchableNodes(data ?? { nodes: [] });
  return (
    <header style={{ display: "flex", alignItems: "center", gap: 16, padding: "8px 16px" }}>
      <span style={{ fontWeight: 600 }}>llamactl console</span>
      <select
        aria-label="Tab node"
        value={tabNode}
        onChange={(event) => {
          onSelectNode(event.target.value);
        }}
      >
        {options.map((entry: ConsoleNodeEntry) => (
          <option key={entry.name} value={entry.name}>
            {entry.name}
          </option>
        ))}
      </select>
      <nav style={{ display: "flex", gap: 12 }}>
        {CONSOLE_MODULES.map((module) => (
          <a
            key={module.id}
            href={consoleHref({ view: module.id, node: tabNode })}
            {...(route.view === module.id ? { "aria-current": "page" as const } : {})}
            onClick={(event) => {
              onNavigate(event, { view: module.id, node: tabNode });
            }}
            style={{ textDecoration: "none" }}
          >
            {module.label}
          </a>
        ))}
      </nav>
    </header>
  );
}

export function ConsoleShell(): React.JSX.Element {
  const [location, setLocation] = React.useState<ShellLocation>(() => readLocation());
  const [nodeList, setNodeList] = React.useState<ConsoleNodeList | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);
  const tab = useTabNode(nodeList);
  const invalid = useInvalidSession();

  React.useEffect(() => {
    const onPopState = (): void => {
      setLocation(readLocation());
    };
    globalThis.addEventListener("popstate", onPopState);
    return (): void => {
      globalThis.removeEventListener("popstate", onPopState);
    };
  }, []);

  function onNavigate(event: MouseEvent<HTMLAnchorElement>, next: ConsoleRoute): void {
    event.preventDefault();
    const href = consoleHref({
      view: next.view,
      ...(next.workload !== undefined ? { workload: next.workload } : {}),
      ...(next.node !== undefined ? { node: next.node } : {}),
    });
    globalThis.history.pushState(null, "", href);
    const [pathname = "/"] = href.split("?");
    setLocation({ pathname, route: next });
  }

  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <NodeScopedProvider node={tab.node}>
        <ConsoleTitleBar
          route={location.route}
          tabNode={tab.node}
          onSelectNode={tab.setNode}
          onNodeList={setNodeList}
          onNavigate={onNavigate}
        />
        {tab.notice !== undefined ? (
          <div data-testid="console-node-notice" style={{ padding: "0 16px", fontSize: 12 }}>
            {`Node "${tab.notice.name}" was rejected (${tab.notice.reason}). Using "${tab.node}".`}
          </div>
        ) : null}
        {location.route.notFound === true ? (
          <p style={{ padding: "0 16px", fontSize: 12 }}>
            {`No console view at ${location.pathname}`}
          </p>
        ) : null}
        {invalid ? (
          <div role="alert" style={{ padding: "0 16px", color: "var(--color-err)" }}>
            {INVALID_SESSION_MESSAGE}
          </div>
        ) : null}
        {toast !== null ? (
          <div
            role="status"
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 16px" }}
          >
            <span>{toast}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setToast(null);
              }}
            >
              Dismiss
            </Button>
          </div>
        ) : null}
        <RoutedView route={location.route} onSuccessToast={setToast} />
      </NodeScopedProvider>
    </div>
  );
}
