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
    <div data-testid={`console-node-row-${row.name}`} className="console-list-row">
      <span className="console-item-title">{row.name}</span>
      <span className="console-caption">{row.kind}</span>
      {row.endpoint === null ? null : row.endpointHref !== null ? (
        <a
          href={row.endpointHref}
          target="_blank"
          rel="noopener noreferrer"
          className="console-readout"
        >
          {row.endpoint}
        </a>
      ) : (
        <span className="console-readout">{row.endpoint}</span>
      )}
      {row.isDefault ? <Badge variant="brand">default</Badge> : null}
      <span className="console-list-actions">
        <NodeReachDot name={row.name} />
      </span>
    </div>
  );
}

export function NodesView(): React.JSX.Element {
  const trpc = useNodeTrpc();
  const tabNode = useConsoleNode();
  const nodeListQuery = trpc.nodeList.useQuery();
  const [search, setSearch] = React.useState("");
  const rows = consoleNodeRows(nodeListQuery.data, tabNode);
  const needle = search.trim().toLowerCase();
  const visible = rows.filter((row) =>
    [row.name, row.kind, row.endpoint ?? ""].some((value) => value.toLowerCase().includes(needle)),
  );
  return (
    <main data-testid="console-view-nodes" className="console-page">
      <h1>Nodes</h1>
      <section className="console-panel">
        <div className="console-filterbar">
          <label className="console-caption">
            Search nodes
            <input
              className="console-select"
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </label>
          <span className="console-caption">
            {visible.length} of {rows.length} nodes
          </span>
        </div>
        {visible.map((row) => (
          <NodeRow key={row.name} row={row} />
        ))}
      </section>
    </main>
  );
}
