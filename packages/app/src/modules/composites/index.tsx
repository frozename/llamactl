import * as React from "react";
import { useState } from "react";

import type { TabId } from "./types";

import { ApplyTab } from "./apply-tab";
import { TabBar } from "./components";
import { DetailTab } from "./detail-tab";
import { useCompositeParam } from "./hooks";
import { ListTab } from "./list-tab";

export default function Composites(): React.JSX.Element {
  const [tab, setTab] = useState<TabId>("list");
  const [selected, setSelected] = useCompositeParam();

  return (
    <div
      style={{ height: "100%", overflow: "auto", padding: 24 }}
      data-testid="workloads-composites-root"
    >
      <div
        style={{
          marginBottom: 4,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--color-text-secondary)",
          fontSize: 12,
        }}
      >
        Composites
      </div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600, color: "var(--color-text)" }}>
        Declarative multi-component applies
      </h1>
      <p style={{ marginBottom: 24, color: "var(--color-text-secondary)", fontSize: 12 }}>
        Bundle services, workloads, RAG nodes, and gateways into one manifest. The applier orders
        components via the dependency DAG and rolls back on failure.
      </p>
      <TabBar
        active={tab}
        onChange={(id) => {
          setTab(id as TabId);
        }}
      />
      <div data-testid={`composites-panel-${tab}`}>
        {tab === "list" && (
          <ListTab
            onPick={(name) => {
              setSelected(name);
              setTab("detail");
            }}
            onCreate={() => {
              setSelected(null);
              setTab("apply");
            }}
          />
        )}
        {tab === "apply" && (
          <ApplyTab
            selectedName={selected}
            onSelect={setSelected}
            onApplied={(name) => {
              setSelected(name);
              setTab("detail");
            }}
          />
        )}
        {tab === "detail" && (
          <DetailTab
            name={selected}
            onSelectNone={() => {
              setSelected(null);
              setTab("list");
            }}
            onPickFromList={() => {
              setTab("list");
            }}
          />
        )}
      </div>
    </div>
  );
}
