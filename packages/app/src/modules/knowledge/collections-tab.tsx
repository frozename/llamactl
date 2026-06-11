import * as React from "react";

import { trpc } from "@/lib/trpc";
import { Button } from "@/ui";

import type { ListCollectionsResponse } from "./types";

export function CollectionsTab(props: {
  nodeName: string;
  onPick: (collection: string) => void;
}): React.JSX.Element {
  const { nodeName, onPick } = props;
  const list = trpc.ragListCollections.useQuery(
    { node: nodeName },
    { enabled: !!nodeName, retry: false },
  );

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
        Loading collections…
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
        Failed to reach {nodeName}: {list.error.message}
      </div>
    );

  const data = list.data as ListCollectionsResponse | undefined;
  const rows = data?.collections ?? [];
  if (rows.length === 0)
    return (
      <div
        style={{
          borderRadius: "var(--r-md)",
          border: "1px dashed var(--color-border)",
          padding: 16,
          color: "var(--color-text-secondary)",
          fontSize: 14,
        }}
      >
        No collections yet on {nodeName}.
      </div>
    );

  return (
    <div
      style={{
        overflow: "hidden",
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
      }}
      data-testid="knowledge-collections-table"
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
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Count</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Dimensions</th>
            <th style={{ width: 112, padding: "8px 12px" }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr
              key={c.name}
              style={{
                borderTop: "1px solid var(--color-border)",
                background: "var(--color-surface-1)",
              }}
            >
              <td style={{ padding: "8px 12px", color: "var(--color-ok)", wordBreak: "break-all" }}>
                {c.name}
              </td>
              <td style={{ padding: "8px 12px", color: "var(--color-text)" }}>{c.count ?? "—"}</td>
              <td style={{ padding: "8px 12px", color: "var(--color-text)" }}>
                {c.dimensions ?? "—"}
              </td>
              <td style={{ padding: "8px 12px", textAlign: "right" }}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onPick(c.name);
                  }}
                >
                  Use in Query
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
