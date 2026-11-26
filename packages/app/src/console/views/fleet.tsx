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
    <div data-testid={`console-fleet-node-${name}`} className="console-panel">
      <span className="console-item-title">{name}</span>
      <span className="console-caption">{kind}</span>
      <StatusDot tone={reach.tone} label={reach.label} />
      {isDefault ? <Badge variant="brand">default</Badge> : null}
      {newTabHref !== null ? (
        <a
          href={newTabHref}
          target="_blank"
          rel="noopener noreferrer"
          className="console-caption"
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
    <main data-testid="console-view-fleet" className="console-page">
      <h1>Fleet</h1>
      <section className="console-panel">
        <h2>Nodes</h2>
        <div data-testid="console-fleet-node-map" className="console-card-grid">
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
      </section>
      <section className="console-panel">
        <h2>Exposed workloads</h2>
        {exposed.length === 0 ? (
          <p data-testid="console-fleet-exposed" className="console-caption">
            No workloads currently serving.
          </p>
        ) : (
          <ul data-testid="console-fleet-exposed" className="console-list">
            {exposed.map((workload) => (
              <li key={`${workload.node}/${workload.name}`} className="console-list-row">
                <span className="console-item-title">{workload.name}</span>
                <span className="console-caption">{workload.node}</span>
                <a
                  href={workload.endpoint}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="console-readout"
                >
                  {workload.endpoint}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="console-panel">
        <h2>This tab&apos;s node</h2>
        <div data-testid="console-fleet-tab-node" className="console-list">
          {card.facts.map((entry) => (
            <div key={`fact-${entry.key}`} className="console-kv">
              <span className="console-caption">{entry.key}</span>
              <span className="console-readout">{entry.value}</span>
            </div>
          ))}
          {card.env.map((entry) => (
            <div key={`env-${entry.key}`} className="console-kv">
              <span className="console-readout">{entry.key}</span>
              <span className="console-readout">{entry.value}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
