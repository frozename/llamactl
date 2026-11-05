// #410 P5a-3c, console fleet view: a node map with per-node nodeTest
// reachability on a 30s refetch (polled by react-query, never by a
// timer), "open in new tab" fleet deep links for dispatchable non-tab
// nodes only, the exposed-workloads list behind blank-target links and
// the tab-node card whose env secrets render through tabNodeCard. The
// legacy modules/dashboard/NodeMap is deliberately not reused: it
// imports the IPC link and ui-store, which would drag Electron back
// into the web console graph.

import * as React from "react";

import { Badge, StatusDot } from "@/ui";

import {
  consoleNodeRows,
  exposedWorkloads,
  NODE_TEST_INTERVAL_MS,
  nodeReachability,
  tabNodeCard,
} from "../fleet-scope";
import { useConsoleNode, useNodeTrpc } from "../node-trpc";

const sectionStyle: React.CSSProperties = { display: "grid", gap: 16, padding: 16 };
const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
  gap: 8,
};
const tileStyle: React.CSSProperties = {
  display: "grid",
  gap: 6,
  padding: 12,
  border: "1px solid var(--color-border)",
  borderRadius: "var(--r-md, 6px)",
};
const headingStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600, margin: 0 };
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
const cardRowStyle: React.CSSProperties = { display: "flex", gap: 8, fontSize: 12 };

function FleetNodeTile({
  name,
  kind,
  isDefault,
  newTabHref,
}: {
  name: string;
  kind: string;
  isDefault: boolean;
  newTabHref: string | null;
}): React.JSX.Element {
  const testQuery = useNodeTrpc().nodeTest.useQuery(
    { name },
    { refetchInterval: NODE_TEST_INTERVAL_MS, retry: false },
  );
  const reach = nodeReachability({ data: testQuery.data, isError: testQuery.isError });
  return (
    <div data-testid={`console-fleet-node-${name}`} style={tileStyle}>
      <span style={nameStyle}>{name}</span>
      <span style={secondaryStyle}>{kind}</span>
      <StatusDot tone={reach.tone} label={reach.label} />
      {isDefault ? <Badge variant="brand">default</Badge> : null}
      {newTabHref !== null ? (
        <a
          href={newTabHref}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 12 }}
        >{`Open in new tab on ${name}`}</a>
      ) : null}
    </div>
  );
}

export function FleetView(): React.JSX.Element {
  const trpc = useNodeTrpc();
  const tabNode = useConsoleNode();
  const nodeListQuery = trpc.nodeList.useQuery();
  const workloadListQuery = trpc.workloadList.useQuery();
  const envQuery = trpc.env.useQuery();
  const nodeFactsQuery = trpc.nodeFacts.useQuery();

  const rows = consoleNodeRows(nodeListQuery.data, tabNode);
  const exposed = exposedWorkloads(workloadListQuery.data);
  const card = tabNodeCard(envQuery.data, nodeFactsQuery.data);

  return (
    <section data-testid="console-view-fleet" style={sectionStyle}>
      <div>
        <h2 style={headingStyle}>Nodes</h2>
        <div data-testid="console-fleet-node-map" style={gridStyle}>
          {rows.map((row) => (
            <FleetNodeTile
              key={row.name}
              name={row.name}
              kind={row.kind}
              isDefault={row.isDefault}
              newTabHref={row.newTabHref}
            />
          ))}
        </div>
      </div>
      <div>
        <h2 style={headingStyle}>Exposed workloads</h2>
        {exposed.length === 0 ? (
          <p data-testid="console-fleet-exposed" style={secondaryStyle}>
            No workloads currently serving.
          </p>
        ) : (
          <ul
            data-testid="console-fleet-exposed"
            style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}
          >
            {exposed.map((workload) => (
              <li
                key={`${workload.node}/${workload.name}`}
                style={{ display: "flex", gap: 8, alignItems: "center" }}
              >
                <span style={nameStyle}>{workload.name}</span>
                <span style={secondaryStyle}>{workload.node}</span>
                <a
                  href={workload.endpoint}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={monoStyle}
                >
                  {workload.endpoint}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h2 style={headingStyle}>This tab&apos;s node</h2>
        <div data-testid="console-fleet-tab-node" style={{ display: "grid", gap: 4 }}>
          {card.facts.map((entry) => (
            <div key={`fact-${entry.key}`} style={cardRowStyle}>
              <span style={secondaryStyle}>{entry.key}</span>
              <span style={monoStyle}>{entry.value}</span>
            </div>
          ))}
          {card.env.map((entry) => (
            <div key={`env-${entry.key}`} style={cardRowStyle}>
              <span style={monoStyle}>{entry.key}</span>
              <span style={monoStyle}>{entry.value}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
