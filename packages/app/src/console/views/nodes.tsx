// #410 P5a-3c, console nodes view: one row per nodeList entry with
// kind, a default badge, the endpoint (blank-target link only for
// http(s); the server projection already strips userinfo, so the
// endpoint is never re-parsed) and a per-row nodeTest reachability dot
// on a 30s react-query refetch — no timers in this file.

import * as React from "react";

import { Badge, StatusDot } from "@/ui";

import {
  type ConsoleNodeRow,
  consoleNodeRows,
  NODE_TEST_INTERVAL_MS,
  nodeReachability,
} from "../fleet-scope";
import { useConsoleNode, useNodeTrpc } from "../node-trpc";

const sectionStyle: React.CSSProperties = { display: "grid", gap: 8, padding: 16 };
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: 8,
  border: "1px solid var(--color-border)",
  borderRadius: "var(--r-md, 6px)",
};
const nameStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 13,
  fontWeight: 600,
};
const secondaryStyle: React.CSSProperties = { fontSize: 12, color: "var(--color-text-secondary)" };
const monoStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 11,
};

function NodeReachDot({ name }: { name: string }): React.JSX.Element {
  const testQuery = useNodeTrpc().nodeTest.useQuery(
    { name },
    { refetchInterval: NODE_TEST_INTERVAL_MS, retry: false },
  );
  const reach = nodeReachability({ data: testQuery.data, isError: testQuery.isError });
  return <StatusDot tone={reach.tone} label={reach.label} />;
}

function NodeRow({ row }: { row: ConsoleNodeRow }): React.JSX.Element {
  return (
    <div data-testid={`console-node-row-${row.name}`} style={rowStyle}>
      <span style={nameStyle}>{row.name}</span>
      <span style={secondaryStyle}>{row.kind}</span>
      {row.endpoint === null ? null : row.endpointHref !== null ? (
        <a href={row.endpointHref} target="_blank" rel="noopener noreferrer" style={monoStyle}>
          {row.endpoint}
        </a>
      ) : (
        <span style={monoStyle}>{row.endpoint}</span>
      )}
      {row.isDefault ? <Badge variant="brand">default</Badge> : null}
      <span style={{ marginLeft: "auto" }}>
        <NodeReachDot name={row.name} />
      </span>
    </div>
  );
}

export function NodesView(): React.JSX.Element {
  const trpc = useNodeTrpc();
  const tabNode = useConsoleNode();
  const nodeListQuery = trpc.nodeList.useQuery();
  const rows = consoleNodeRows(nodeListQuery.data, tabNode);
  return (
    <section data-testid="console-view-nodes" style={sectionStyle}>
      {rows.map((row) => (
        <NodeRow key={row.name} row={row} />
      ))}
    </section>
  );
}
