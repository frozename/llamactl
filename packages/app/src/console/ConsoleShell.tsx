import type { MouseEvent } from "react";

import * as React from "react";

import { Button } from "@/ui";

import type { ConsoleNodeEntry, ConsoleNodeList } from "./node-scope";
import type { ConsoleRoute } from "./router";

import { CONSOLE_MODULES } from "./console-manifest";
import { dispatchableNodes, useTabNode } from "./node-scope";
import { NodeScopedProvider } from "./node-scoped-provider";
import { useNodeTrpc } from "./node-trpc";
import { consoleHref, parseConsoleRoute } from "./router";
import { INVALID_SESSION_MESSAGE, useInvalidSession } from "./session-store";
import { DashboardView } from "./views/dashboard";
import { FleetView } from "./views/fleet";
import { LogsView } from "./views/logs";
import { NodesView } from "./views/nodes";
import { ObservabilityView } from "./views/observability";
import { WorkloadsView } from "./views/workloads";
import "./console.css";

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

function RoutedView({
  route,
  tabNode,
  onSuccessToast,
  navigate,
}: {
  route: ConsoleRoute;
  tabNode: string;
  onSuccessToast: (text: string) => void;
  navigate: (next: ConsoleRoute) => void;
}): React.JSX.Element {
  switch (route.view) {
    case "dashboard":
      return <DashboardView />;
    case "workloads":
      return <WorkloadsView route={route} onSuccessToast={onSuccessToast} />;
    case "fleet":
      return <FleetView />;
    case "nodes":
      return <NodesView />;
    case "stats":
    case "runs":
      return <ObservabilityView mode={route.view} />;
    case "logs":
      return (
        <LogsView
          route={route}
          onSelectWorkload={(name) => {
            navigate({ view: "logs", workload: name, node: tabNode });
          }}
        />
      );
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
    <header className="console-topbar">
      <a
        className="console-brand"
        href={consoleHref({ view: "dashboard", node: tabNode })}
        onClick={(event) => {
          onNavigate(event, { view: "dashboard", node: tabNode });
        }}
      >
        llamactl
      </a>
      <nav className="console-nav" aria-label="Console pages">
        {CONSOLE_MODULES.map((module) => (
          <a
            key={module.id}
            href={consoleHref({ view: module.id, node: tabNode })}
            {...(route.view === module.id ? { "aria-current": "page" as const } : {})}
            onClick={(event) => {
              onNavigate(event, { view: module.id, node: tabNode });
            }}
          >
            {module.label}
          </a>
        ))}
      </nav>
      <label className="console-tab-node">
        <span className="console-caption">Tab node</span>
        <select
          aria-label="Tab node"
          className="console-select"
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
      </label>
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

  function navigate(next: ConsoleRoute): void {
    const href = consoleHref({
      view: next.view,
      ...(next.workload !== undefined ? { workload: next.workload } : {}),
      ...(next.node !== undefined ? { node: next.node } : {}),
    });
    globalThis.history.pushState(null, "", href);
    const [pathname = "/"] = href.split("?");
    setLocation({ pathname, route: next });
  }

  function onNavigate(event: MouseEvent<HTMLAnchorElement>, next: ConsoleRoute): void {
    event.preventDefault();
    navigate(next);
  }

  return (
    <div className="console-shell">
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
        <RoutedView
          route={location.route}
          tabNode={tab.node}
          onSuccessToast={setToast}
          navigate={navigate}
        />
      </NodeScopedProvider>
    </div>
  );
}
