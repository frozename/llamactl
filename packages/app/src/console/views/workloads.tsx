// #410 P5a-3b, console workloads view: the tab node's rows only, with
// a describe drawer, the safe stop action and an other-nodes footer
// whose links carry the target node. Deep links (?/workloads/<name>)
// classify via workloadLocation: here opens that drawer, elsewhere
// offers a switch link, missing says so. No ApplyPanel and no
// reconciler toolbar here — those stay in modules/workloads.

import * as React from "react";
import * as YAML from "yaml";

import type { StatusDotTone } from "@/ui";
import { StatusDot } from "@/ui";

import type { WorkerManifest } from "../../modules/workloads/workers-panel";
import type { ConsoleRoute } from "../router";
import type { ConsoleWorkloadRow, WorkloadLocationResult } from "../workloads-scope";

import { WorkersPanel } from "../../modules/workloads/workers-panel";
import { StopServerAction } from "../actions/stop-server";
import { useConsoleNode, useNodeTrpc } from "../node-trpc";
import { workloadLocation, workloadsForTab } from "../workloads-scope";

type DeepLink = WorkloadLocationResult<ConsoleWorkloadRow>;

const sectionStyle: React.CSSProperties = { display: "grid", gap: 8, padding: 16 };
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: 8,
  border: "1px solid var(--color-border)",
  borderRadius: "var(--r-md, 6px)",
};
const codeStyle: React.CSSProperties = {
  margin: 0,
  padding: 8,
  overflowX: "auto",
  fontSize: 11,
  background: "var(--color-surface-2)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--r-md, 6px)",
};
const secondaryStyle: React.CSSProperties = { fontSize: 12, color: "var(--color-text-secondary)" };

function phaseOf(row: ConsoleWorkloadRow): string {
  const phase = row["phase"];
  return typeof phase === "string" ? phase : "Unknown";
}

function phaseTone(phase: string): StatusDotTone {
  if (phase === "Running") return "ok";
  if (phase === "Mismatch") return "warn";
  if (phase === "Unreachable" || phase === "Foreign") return "err";
  return "idle";
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
    return <p style={secondaryStyle}>Describe pending.</p>;
  }
  const record = data as Record<string, unknown>;
  const manifest = record["manifest"];
  const liveStatus = record["liveStatus"];
  return (
    <div style={{ display: "grid", gap: 8, paddingLeft: 12 }}>
      <pre style={codeStyle}>{YAML.stringify(manifest)}</pre>
      <pre style={codeStyle}>
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
}: {
  row: ConsoleWorkloadRow;
  initiallyOpen: boolean;
  onSuccessToast: (text: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(initiallyOpen);
  const describe = useNodeTrpc().workloadDescribe.useQuery({ name: row.name }, { enabled: open });
  const phase = phaseOf(row);
  return (
    <div data-testid={`console-workload-row-${row.name}`} style={{ display: "grid", gap: 4 }}>
      <div style={rowStyle}>
        <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 13 }}>{row.name}</span>
        <span style={secondaryStyle}>{row.kind}</span>
        <StatusDot tone={phaseTone(phase)} label={phase} />
        {row.endpoint !== null ? (
          <a
            href={row.endpoint}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)" }}
          >
            {row.endpoint}
          </a>
        ) : null}
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center" }}>
          <StopServerAction row={row} onSuccessToast={onSuccessToast} />
          <button
            type="button"
            onClick={() => {
              setOpen((current) => !current);
            }}
          >
            {open ? "Hide" : "Describe"}
          </button>
        </span>
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
      <div style={secondaryStyle}>
        <p style={{ margin: 0 }}>{deepLink.message}</p>
        <a href={deepLink.href}>{`Open ${workload} on ${deepLink.node}`}</a>
      </div>
    );
  }
  if (deepLink.kind === "missing") {
    return <p style={secondaryStyle}>{`No workload named ${workload} on any node`}</p>;
  }
  return null;
}

function OtherNodesFooter({
  others,
}: {
  others: { node: string; count: number; href: string }[];
}): React.JSX.Element {
  return (
    <footer data-testid="console-workloads-other-nodes" style={{ display: "flex", gap: 12 }}>
      {others.map((other) => (
        <a key={other.node} href={other.href} style={{ fontSize: 12 }}>
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
  const listQuery = useNodeTrpc().workloadList.useQuery();
  const tabNode = useConsoleNode();
  const rows = normaliseRows(listQuery.data);
  const scope = workloadsForTab(rows, tabNode);
  const workload = route.workload;
  const deepLink = workload === undefined ? null : workloadLocation(rows, workload, tabNode);
  const openName = deepLink !== null && deepLink.kind === "here" ? deepLink.row.name : null;
  return (
    <section data-testid="console-view-workloads" style={sectionStyle}>
      {workload !== undefined && deepLink !== null ? (
        <DeepLinkNotice deepLink={deepLink} workload={workload} />
      ) : null}
      {scope.rows.map((row) => (
        <ConsoleWorkloadRowCard
          key={row.name}
          row={row}
          initiallyOpen={openName !== null && row.name === openName}
          onSuccessToast={onSuccessToast}
        />
      ))}
      <OtherNodesFooter others={scope.others} />
    </section>
  );
}
