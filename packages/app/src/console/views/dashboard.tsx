import type { AppRouter } from "@llamactl/remote";
import type { inferRouterOutputs } from "@trpc/server";
import type * as React from "react";

import { StatusDot } from "@/ui";

import type { NodeReachability } from "../fleet-scope";

import { NODE_TEST_INTERVAL_MS, nodeReachability } from "../fleet-scope";
import { dispatchableNodes } from "../node-scope";
import { useConsoleNode, useNodeTrpc } from "../node-trpc";
import { consoleHref } from "../router";
import "./dashboard.css";

type Workload = inferRouterOutputs<AppRouter>["workloadList"][number];
type DashboardAgent = { name: string; reach: NodeReachability };

const poll = { refetchInterval: NODE_TEST_INTERVAL_MS, retry: false } as const;
const issuePhases = new Set(["Unreachable", "Foreign", "Mismatch"]);

interface DashboardStatus {
  tone: "ok" | "warn" | "idle";
  label: string;
}

function fleetStatus(
  agents: DashboardAgent[],
  issues: Workload[],
  inventory: "loading" | "ready" | "unavailable",
): DashboardStatus {
  if (agents.some(({ reach }) => reach.tone === "err") || issues.length > 0) {
    return { tone: "warn", label: "Attention needed" };
  }
  if (inventory === "unavailable") return { tone: "warn", label: "Status incomplete" };
  if (inventory === "loading" || agents.some(({ reach }) => reach.tone === "idle")) {
    return { tone: "idle", label: "Checking status" };
  }
  if (agents.length === 0) return { tone: "idle", label: "No agents registered" };
  return { tone: "ok", label: "Fleet reachable" };
}

function AgentOverview({
  agents,
  running,
}: {
  agents: DashboardAgent[];
  running: Workload[] | undefined;
}): React.JSX.Element {
  return (
    <section className="console-panel overview-agents">
      <h2>Agent nodes</h2>
      {agents.length === 0 ? <p className="console-caption">No agent status available.</p> : null}
      <ul className="console-list">
        {agents.map(({ name, reach }) => (
          <li className="console-list-row overview-agent-row" key={name}>
            <div>
              <a className="console-item-title" href={consoleHref({ view: "fleet", node: name })}>
                {name}
              </a>
              {running !== undefined ? (
                <p className="console-caption">
                  {running.filter((row) => row.node === name).length} managed workloads running
                </p>
              ) : null}
            </div>
            <StatusDot tone={reach.tone} label={reach.label} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function WorkloadOverview({
  title,
  workloads,
  empty,
}: {
  title: string;
  workloads: Workload[] | undefined;
  empty: string;
}): React.JSX.Element {
  return (
    <section className="console-panel overview-workloads">
      <h2>{title}</h2>
      {workloads?.length ? (
        <ul className="console-list">
          {workloads.map((row) => (
            <li className="console-list-row overview-workload-row" key={`${row.node}/${row.name}`}>
              <div>
                <a
                  className="console-item-title"
                  href={consoleHref({ view: "workloads", workload: row.name, node: row.node })}
                >
                  {row.name}
                </a>
                <p className="console-caption">
                  {row.node} · {row.kind}
                </p>
              </div>
              <span className="overview-workload-phase">{row.phase}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="console-caption">{empty}</p>
      )}
    </section>
  );
}

function OverviewMetrics({
  agents,
  runningCount,
  declaredCount,
  hasAgentInventory,
  workloadIssues,
}: {
  agents: DashboardAgent[];
  runningCount: number | undefined;
  declaredCount: number | undefined;
  hasAgentInventory: boolean;
  workloadIssues: number;
}): React.JSX.Element {
  const available = agents.filter(({ reach }) => reach.tone === "ok").length;
  const offline = agents.filter(({ reach }) => reach.tone === "err").length;
  const issueTotal = offline + workloadIssues;
  const hasIssueInventory = declaredCount !== undefined && hasAgentInventory;
  return (
    <dl className="overview-metrics">
      <div>
        <dt>Reachable agents</dt>
        <dd>{hasAgentInventory ? `${String(available)} / ${String(agents.length)}` : "—"}</dd>
        {agents.length > 0 ? (
          <div className="overview-agent-status" aria-hidden="true">
            {agents.map(({ name, reach }) => (
              <span key={name} data-tone={reach.tone} />
            ))}
          </div>
        ) : null}
      </div>
      <div>
        <dt>Running workloads</dt>
        <dd>{runningCount ?? "—"}</dd>
        {declaredCount !== undefined ? <span>{declaredCount} declared</span> : null}
      </div>
      <div data-attention={issueTotal > 0}>
        <dt>Needs attention</dt>
        <dd>{hasIssueInventory ? issueTotal : "—"}</dd>
        {hasIssueInventory ? (
          <span>
            {offline} unreachable agents · {workloadIssues} workload issues
          </span>
        ) : null}
      </div>
    </dl>
  );
}

export function DashboardView(): React.JSX.Element {
  const node = useConsoleNode();
  const trpc = useNodeTrpc();
  const catalog = trpc.nodeList.useQuery(undefined, poll);
  const workloads = trpc.workloadList.useQuery(undefined, poll);
  const agents = catalog.data ? dispatchableNodes(catalog.data) : [];
  const reachability = trpc.useQueries((queries) =>
    agents.map(({ name }) => queries.nodeTest({ name }, poll)),
  );
  const statuses = agents.map(({ name }, index) => ({
    name,
    reach: nodeReachability(reachability[index]),
  }));
  const rows = workloads.isError ? undefined : workloads.data;
  const running = rows?.filter((row) => row.phase === "Running");
  const issues = rows?.filter((row) => issuePhases.has(row.phase)) ?? [];
  const status = fleetStatus(
    statuses,
    issues,
    catalog.isError || workloads.isError
      ? "unavailable"
      : catalog.isPending || workloads.isPending
        ? "loading"
        : "ready",
  );

  return (
    <main className="console-page overview" data-testid="console-view-dashboard">
      <header className="overview-header">
        <div className="overview-header-top">
          <div>
            <h1>Dashboard</h1>
            <p className="console-caption">Fleet health and serving status</p>
          </div>
          <div className="overview-status" data-tone={status.tone} role="status">
            <StatusDot tone={status.tone} label={status.label} />
          </div>
        </div>
        <div className="overview-links">
          <a href={consoleHref({ view: "stats", node })}>
            Fleet Stats <span aria-hidden="true">↗</span>
          </a>
          <a href={consoleHref({ view: "runs", node })}>
            Runs <span aria-hidden="true">↗</span>
          </a>
        </div>
      </header>

      <OverviewMetrics
        agents={statuses}
        runningCount={running?.length}
        declaredCount={rows?.length}
        hasAgentInventory={catalog.data !== undefined && !catalog.isError}
        workloadIssues={issues.length}
      />

      {catalog.isError ? <p role="alert">Agent inventory unavailable.</p> : null}
      {workloads.isError ? <p role="alert">Workload inventory unavailable.</p> : null}

      <div className="overview-grid">
        <AgentOverview agents={statuses} running={running} />
        <WorkloadOverview
          title="Managed workloads serving now"
          workloads={running}
          empty={rows ? "No workloads are running." : "Workload status unavailable."}
        />
        {issues.length > 0 ? (
          <WorkloadOverview title="Workload issues" workloads={issues} empty="" />
        ) : null}
      </div>
    </main>
  );
}
