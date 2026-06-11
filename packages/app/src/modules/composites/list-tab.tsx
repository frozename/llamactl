import * as React from "react";

import { trpc } from "@/lib/trpc";
import { Button, StatusDot } from "@/ui";

import type { CompositeShape } from "./types";

import { countComponents, formatTimestamp } from "./helpers";

function ListEmptyState({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  return (
    <div
      style={{
        borderRadius: "var(--r-md)",
        border: "1px dashed var(--color-border)",
        background: "var(--color-surface-1)",
        padding: 24,
      }}
      data-testid="composites-empty-state"
    >
      <div style={{ color: "var(--color-text)", fontSize: 14 }}>No composites yet.</div>
      <p style={{ marginTop: 8, color: "var(--color-text-secondary)", fontSize: 12 }}>
        A composite bundles services, workloads, RAG nodes, and gateways into one declarative unit.
      </p>
      <pre
        style={{
          marginTop: 4,
          overflowX: "auto",
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          background: "var(--color-surface-2)",
          padding: 8,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--color-text)",
        }}
      >{`llamactl composite apply -f <file>.yaml`}</pre>
      <Button
        variant="primary"
        size="sm"
        type="button"
        onClick={() => {
          onCreate();
        }}
        data-testid="composites-empty-apply"
      >
        Open Apply tab
      </Button>
    </div>
  );
}

export function ListTab(props: {
  onPick: (name: string) => void;
  onCreate: () => void;
}): React.JSX.Element {
  const { onPick, onCreate } = props;
  const list = trpc.compositeList.useQuery();

  if (list.isLoading)
    return (
      <div
        style={{
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          background: "var(--color-surface-1)",
          padding: 16,
          color: "var(--color-text-secondary)",
          fontSize: 14,
        }}
      >
        Loading composites...
      </div>
    );
  if (list.error)
    return (
      <div
        style={{
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          borderColor: "var(--color-err)",
          background: "var(--color-surface-1)",
          padding: "8px 12px",
          color: "var(--color-err)",
          fontSize: 14,
        }}
      >
        Failed to load composites: {list.error.message}
      </div>
    );

  const rows = (list.data ?? []) as CompositeShape[];
  if (rows.length === 0) {
    return <ListEmptyState onCreate={onCreate} />;
  }

  return (
    <div
      style={{
        overflow: "hidden",
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
      }}
      data-testid="composites-list-table"
    >
      <table style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 14 }}>
        <thead
          style={{
            background: "var(--color-surface-1)",
            textAlign: "left",
            color: "var(--color-text-secondary)",
          }}
        >
          <tr>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Name</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Components</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Last applied</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Phase</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const phase = c.status?.phase;
            const count = countComponents(c.spec);
            const tone =
              phase === "Ready" || phase === "Pending" || phase === "Applying"
                ? "ok"
                : phase === "Failed"
                  ? "err"
                  : phase === "Degraded"
                    ? "warn"
                    : "idle";
            return (
              <tr
                key={c.metadata.name}
                onClick={() => {
                  onPick(c.metadata.name);
                }}
                data-testid={`composites-row-${c.metadata.name}`}
                style={{
                  cursor: "pointer",
                  borderTop: "1px solid var(--color-border)",
                  background: "var(--color-surface-1)",
                }}
              >
                <td
                  style={{ padding: "8px 12px", color: "var(--color-ok)", wordBreak: "break-all" }}
                >
                  {c.metadata.name}
                </td>
                <td style={{ padding: "8px 12px", color: "var(--color-text)" }}>{count}</td>
                <td style={{ padding: "8px 12px", color: "var(--color-text-secondary)" }}>
                  {formatTimestamp(c.status?.appliedAt)}
                </td>
                <td style={{ padding: "8px 12px" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10 }}>
                    <StatusDot tone={tone} />
                    {phase ?? "Unapplied"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
