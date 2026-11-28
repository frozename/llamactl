// #410 P5a-3b, console workloads view: the tab node's rows only, with
// a describe drawer, the safe stop action and an other-nodes footer
// whose links carry the target node. Deep links (?/workloads/<name>)
// classify via workloadLocation: here opens that drawer, elsewhere
// offers a switch link, missing says so. No ApplyPanel and no
// reconciler toolbar here — those stay in modules/workloads.

import * as React from "react";
import * as YAML from "yaml";

import { StatusDot } from "@/ui";

import type { WorkerManifest } from "../../modules/workloads/workers-panel";
import type { ConsoleRoute } from "../router";
import type {
  ConsoleWorkloadRow,
  WorkloadLocationResult,
  WorkloadResidencyStatus,
} from "../workloads-scope";

import { WorkersPanel } from "../../modules/workloads/workers-panel";
import { StopServerAction } from "../actions/stop-server";
import { useConsoleNode, useNodeTrpc } from "../node-trpc";
import {
  openWorkloadName,
  phaseTone,
  residencyForNode,
  workloadCardKey,
  workloadLocation,
  workloadResidencyOf,
  workloadsForTab,
} from "../workloads-scope";

type DeepLink = WorkloadLocationResult<ConsoleWorkloadRow>;

function phaseOf(row: ConsoleWorkloadRow): string {
  const phase = row["phase"];
  return typeof phase === "string" ? phase : "Unknown";
}

function workersOf(manifest: unknown): WorkerManifest[] {
  if (typeof manifest !== "object" || manifest === null) return [];
  const spec = (manifest as { spec?: unknown }).spec;
  if (typeof spec !== "object" || spec === null) return [];
  const workers = (spec as { workers?: unknown }).workers;
  return Array.isArray(workers) ? (workers as WorkerManifest[]) : [];
}

function normaliseRows(data: unknown): ConsoleWorkloadRow[] {
  if (!Array.isArray(data)) return [];
  return (data as ConsoleWorkloadRow[]).map((row) => ({
    ...row,
    workerNodes: Array.isArray(row.workerNodes) ? row.workerNodes : [],
  }));
}

function DescribeDrawer({ data }: { data: unknown }): React.JSX.Element {
  if (typeof data !== "object" || data === null) {
    return <p className="console-caption">Describe pending.</p>;
  }
  const record = data as Record<string, unknown>;
  const manifest = record["manifest"];
  const liveStatus = record["liveStatus"];
  return (
    <div className="console-panel">
      <h3>Manifest</h3>
      <pre className="console-code">{YAML.stringify(manifest)}</pre>
      <h3>Live status</h3>
      <pre className="console-code">
        {liveStatus === undefined ? "null" : JSON.stringify(liveStatus, null, 2)}
      </pre>
      <WorkersPanel workers={workersOf(manifest)} />
    </div>
  );
}

function ConsoleWorkloadRowCard({
  row,
  initiallyOpen,
  onSuccessToast,
  residency,
}: {
  row: ConsoleWorkloadRow;
  residency: WorkloadResidencyStatus | undefined;
  initiallyOpen: boolean;
  onSuccessToast: (text: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(initiallyOpen);
  const describe = useNodeTrpc().workloadDescribe.useQuery({ name: row.name }, { enabled: open });
  const phase = phaseOf(row);
  const native = residency?.omlxNative?.workloads.find(
    (workload) => workload.workload === row.name,
  );
  const engineState = native?.servingState ?? native?.modelState;
  return (
    <div data-testid={`console-workload-row-${row.name}`} style={{ display: "grid", gap: 4 }}>
      <div className="console-list-row">
        <span className="console-item-title">{row.name}</span>
        <span className="console-caption">{row.kind}</span>
        <StatusDot tone={phaseTone(phase)} label={phase} />
        {row.endpoint !== null ? (
          <a
            href={row.endpoint}
            target="_blank"
            rel="noopener noreferrer"
            className="console-readout"
          >
            {row.endpoint}
          </a>
        ) : null}
        <span className="console-list-actions">
          <StopServerAction row={row} onSuccessToast={onSuccessToast} />
          <button
            type="button"
            className="console-control"
            aria-expanded={open}
            onClick={() => {
              setOpen((current) => !current);
            }}
          >
            {open ? "Hide" : "Describe"}
          </button>
        </span>
      </div>
      <div className="console-caption" data-testid="console-workload-residency">
        {`Residency: ${workloadResidencyOf(residency, row.name)}`}
        {native?.mode === "native" ? " · Native mode" : null}
        {native?.mode === "process-fallback" ? " · Whole-process mode" : null}
        {engineState === undefined ? null : ` · Engine inventory ${engineState}`}
      </div>
      {open ? <DescribeDrawer data={describe.data} /> : null}
    </div>
  );
}

function DeepLinkNotice({
  deepLink,
  workload,
}: {
  deepLink: DeepLink;
  workload: string;
}): React.JSX.Element | null {
  if (deepLink.kind === "elsewhere") {
    return (
      <div className="console-caption">
        <p style={{ margin: 0 }}>{deepLink.message}</p>
        <a href={deepLink.href}>{`Open ${workload} on ${deepLink.node}`}</a>
      </div>
    );
  }
  if (deepLink.kind === "missing") {
    return <p className="console-caption">{`No workload named ${workload} on any node`}</p>;
  }
  return null;
}

function OtherNodesFooter({
  others,
}: {
  others: { node: string; count: number; href: string }[];
}): React.JSX.Element {
  return (
    <footer data-testid="console-workloads-other-nodes" className="console-list-actions">
      {others.map((other) => (
        <a key={other.node} href={other.href} className="console-control">
          {`${other.node} · ${String(other.count)}`}
        </a>
      ))}
    </footer>
  );
}

export function WorkloadsView({
  route,
  onSuccessToast,
}: {
  route: ConsoleRoute;
  onSuccessToast: (text: string) => void;
}): React.JSX.Element {
  const [search, setSearch] = React.useState("");
  const [phase, setPhase] = React.useState("");
  const listQuery = useNodeTrpc().workloadList.useQuery();
  const tabNode = useConsoleNode();
  const residencyQuery = useNodeTrpc().residencyStatus.useQuery(
    { node: tabNode },
    {
      refetchInterval: 5000,
      retry: false,
    },
  );
  const residency = residencyForNode(
    residencyQuery.isSuccess ? residencyQuery.data : null,
    tabNode,
  );
  const store = residency?.store;
  const operations = store?.present === true && "nonterminal" in store ? store.nonterminal : [];
  const rows = normaliseRows(listQuery.data);
  const scope = workloadsForTab(rows, tabNode);
  const workload = route.workload;
  const deepLink = workload === undefined ? null : workloadLocation(rows, workload, tabNode);
  const routeOpen = openWorkloadName(rows, workload, tabNode);
  const phases = [...new Set(scope.rows.map(phaseOf))].sort();
  const selectedPhase = phases.includes(phase) ? phase : "";
  const needle = search.trim().toLowerCase();
  const visible = scope.rows.filter(
    (row) =>
      row.name === routeOpen ||
      (row.name.toLowerCase().includes(needle) &&
        (selectedPhase === "" || selectedPhase === phaseOf(row))),
  );
  return (
    <main data-testid="console-view-workloads" className="console-page">
      <h1>Workloads</h1>
      <section className="console-panel">
        <div className="console-filterbar">
          <label className="console-caption">
            Search workloads
            <input
              className="console-select"
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </label>
          <label className="console-caption">
            Phase
            <select
              className="console-select"
              value={selectedPhase}
              onChange={(event) => {
                setPhase(event.target.value);
              }}
            >
              <option value="">All phases</option>
              {phases.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <span className="console-caption">
            {visible.length} of {scope.rows.length} workloads
          </span>
        </div>
        {workload !== undefined && deepLink !== null ? (
          <DeepLinkNotice deepLink={deepLink} workload={workload} />
        ) : null}
        {residency?.managed === undefined ? null : (
          <ManagedResidencyOverview managed={residency.managed} />
        )}
        {operations.length > 0 ? (
          <ul className="console-caption" aria-label="Active residency operations">
            {operations.map((operation) => (
              <li key={operation.operationId}>
                {`${operation.phase === "committed" ? "In progress" : "Pending"} · ${operation.operationId}`}
              </li>
            ))}
          </ul>
        ) : null}
        {visible.map((row) => (
          <ConsoleWorkloadRowCard
            // Keyed on route membership so a popstate move from
            // /workloads/a to /workloads/b remounts exactly those two
            // cards: b opens, a closes, without an effect.
            key={workloadCardKey(row.name, routeOpen)}
            row={row}
            residency={residency}
            initiallyOpen={routeOpen === row.name}
            onSuccessToast={onSuccessToast}
          />
        ))}
        <OtherNodesFooter others={scope.others} />
      </section>
    </main>
  );
}

function ManagedResidencyOverview({
  managed,
}: {
  managed: NonNullable<WorkloadResidencyStatus["managed"]>;
}): React.JSX.Element {
  const { profile, claims, budgetGiB } = managed;
  const selected = profile.kind === "selected" ? profile.profile : profile.kind;
  const allocated = claims.reduce((total, claim) => total + claim.allocationGiB, 0);
  const pending = claims.filter((claim) => claim.state === "pending").length;
  const unresolved = claims.filter(
    (claim) => claim.inferenceHold === "prior" || claim.inferenceHold === "unknown",
  );
  return (
    <div className="console-caption" aria-label="Managed residency">
      <p>
        {managed.ledger === "available"
          ? `Profile ${selected} · ${allocated.toFixed(1)} / ${budgetGiB?.toFixed(1) ?? "unknown"} GiB · ${String(pending)} pending`
          : "Managed residency ledger unavailable"}
      </p>
      {unresolved.map((claim) => (
        <p key={claim.workload}>{`${claim.workload} · inference completion unconfirmed`}</p>
      ))}
      {(managed.execution ?? []).map((group) => (
        <p key={group.group}>
          {`${group.group} · ${String(group.executing)} active · ${String(group.queued)} queued`}
          {group.oldestQueuedWaitMs === undefined
            ? null
            : ` · oldest ${String(group.oldestQueuedWaitMs)} ms`}
          {group.fenced ? " · fenced" : null}
        </p>
      ))}
    </div>
  );
}
