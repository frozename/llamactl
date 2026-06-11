import * as React from "react";

import { trpc } from "@/lib/trpc";

import type { EmbedderBinding, ListCollectionsResponse, RagProviderKind } from "./types";

export function CollectionHeader(props: {
  nodeName: string;
  collection: string;
  embedder: EmbedderBinding | null;
  provider: RagProviderKind | null;
}): React.JSX.Element | null {
  const { nodeName, collection, embedder, provider } = props;
  const list = trpc.ragListCollections.useQuery(
    { node: nodeName },
    { enabled: !!nodeName, retry: false },
  );
  const data = list.data as ListCollectionsResponse | undefined;
  const rows = data?.collections ?? [];
  const targeted = collection.trim()
    ? (rows.find((c) => c.name === collection.trim()) ?? null)
    : (rows[0] ?? null);

  if (list.isLoading)
    return (
      <div
        style={{
          borderRadius: "var(--r-md)",
          border: "1px dashed var(--color-border)",
          background: "var(--color-surface-1)",
          padding: 12,
          color: "var(--color-text-secondary)",
          fontSize: 12,
        }}
      >
        Loading collection info…
      </div>
    );
  if (list.error || !targeted) return null;

  const count = typeof targeted.count === "number" ? targeted.count : null;
  const dims = typeof targeted.dimensions === "number" ? targeted.dimensions : null;
  const warnings: string[] = [];
  if (count === 0) warnings.push("collection is empty — index documents before querying");
  if (!embedder && provider === "pgvector")
    warnings.push("no embedder bound on this pgvector node — queries will fail");

  return (
    <div
      style={{
        marginTop: 8,
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        background: "var(--color-surface-1)",
        padding: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          columnGap: 16,
          rowGap: 4,
          color: "var(--color-text-secondary)",
          fontSize: 12,
        }}
      >
        <span>
          collection{" "}
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text)" }}>
            {targeted.name}
          </span>
        </span>
        <span>
          count{" "}
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text)" }}>
            {count !== null ? count.toLocaleString() : "—"}
          </span>
        </span>
        <span>
          dims{" "}
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text)" }}>
            {dims ?? "—"}
          </span>
        </span>
        <span>
          embedder{" "}
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text)" }}>
            {embedder ? `${embedder.node}/${embedder.model}` : "none"}
          </span>
        </span>
      </div>
      {warnings.length > 0 && (
        <ul style={{ marginTop: 2, color: "var(--color-warn)", fontSize: 12 }}>
          {warnings.map((w, i) => (
            <li key={i}>⚠️ {w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
