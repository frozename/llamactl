import * as React from "react";
import { useState } from "react";

import { trpc } from "@/lib/trpc";
import { Button, EditorialHero } from "@/ui";

import { NodeRow } from "./node-components";
import { RegisterCloudPanel, RegisterPanel } from "./register-panels";

function DiscoverPanel(): React.JSX.Element {
  const disc = trpc.nodeDiscover.useQuery({ timeoutMs: 3000 }, { enabled: false });
  const rows = (disc.data ?? []) as { url: string; nodeName: string }[];
  return (
    <div
      style={{
        marginTop: 16,
        padding: 16,
        borderRadius: 4,
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface-1)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 14, fontWeight: 500 }}>Discover LAN agents</div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            void disc.refetch();
          }}
          disabled={disc.isFetching}
        >
          {disc.isFetching ? "Scanning…" : "Scan"}
        </Button>
      </div>
      {rows.length === 0 && disc.isSuccess && <div style={{ fontSize: 12 }}>No agents found.</div>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {rows.map((r) => (
          <li
            key={r.url}
            style={{
              padding: "8px 12px",
              borderRadius: 4,
              background: "var(--color-surface-2)",
              marginBottom: 4,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontFamily: "monospace" }}>{r.nodeName}</span>
              <span style={{ fontSize: 10 }}>{r.url}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface NodeEntry {
  name: string;
  endpoint: string;
  cloud?: { baseUrl: string };
  effectiveKind: string;
}

export default function Nodes(): React.JSX.Element {
  const list = trpc.nodeList.useQuery();
  const [showReg, setShowReg] = useState(false);
  const [showDisc, setShowDisc] = useState(false);
  const [showCloud, setShowCloud] = useState(false);

  if (list.isLoading) {
    return (
      <div style={{ height: "100%" }} data-testid="nodes-root">
        <div style={{ padding: 24, fontSize: 14, color: "var(--color-text-secondary)" }}>
          Loading…
        </div>
      </div>
    );
  }
  if (list.error) {
    return (
      <div style={{ height: "100%" }} data-testid="nodes-root">
        <div style={{ padding: 24, fontSize: 14, color: "var(--color-err)" }}>
          Failed to load nodes: {list.error.message}
        </div>
      </div>
    );
  }
  const data = list.data ?? { nodes: [], context: "", cluster: "", defaultNode: "" };

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        flexDirection: "column",
        gap: 16,
        overflow: "auto",
        padding: 24,
      }}
      data-testid="nodes-root"
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 600 }}>Nodes</h1>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            context <span style={{ fontFamily: "monospace" }}>{data.context}</span> · default{" "}
            <span style={{ fontFamily: "monospace" }}>{data.defaultNode}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setShowDisc(!showDisc);
            }}
          >
            Discover
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setShowCloud(!showCloud);
            }}
          >
            Cloud
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setShowReg(!showReg);
            }}
          >
            Agent
          </Button>
        </div>
      </div>
      {showDisc && <DiscoverPanel />}
      {showCloud && (
        <RegisterCloudPanel
          onDone={() => {
            setShowCloud(false);
          }}
        />
      )}
      {showReg && (
        <RegisterPanel
          onDone={() => {
            setShowReg(false);
          }}
        />
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {data.nodes.length === 0 ? (
          <EditorialHero title="No nodes" lede="Register one." />
        ) : (
          (data.nodes as NodeEntry[]).map((n) => (
            <NodeRow
              key={n.name}
              name={n.name}
              endpoint={n.endpoint}
              defaultNode={data.defaultNode}
              kind={n.effectiveKind || (n.cloud ? "gateway" : "agent")}
              cloud={n.cloud}
            />
          ))
        )}
      </div>
    </div>
  );
}
