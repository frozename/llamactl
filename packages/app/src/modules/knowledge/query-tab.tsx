import * as React from "react";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Badge, Button, Input } from "@/ui";
import { CollectionHeader } from "./components";
import { formatScore, truncateContent } from "./helpers";
import type { EmbedderBinding, RagProviderKind, SearchResponse } from "./types";

function QueryForm(props: {
  query: string;
  onQueryChange: (v: string) => void;
  topK: number;
  onTopKChange: (v: number) => void;
  collection: string;
  onCollectionChange: (v: string) => void;
  isSearching: boolean;
  onSubmit: () => void;
}): React.JSX.Element {
  const { query, onQueryChange, topK, onTopKChange, collection, onCollectionChange } = props;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
      style={{
        marginTop: 12,
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        background: "var(--color-surface-1)",
        padding: 16,
      }}
    >
      <label style={{ display: "block", fontSize: 14 }}>
        <span
          style={{
            marginBottom: 4,
            display: "block",
            color: "var(--color-text-secondary)",
            fontSize: 12,
          }}
        >
          Query
        </span>
        <textarea
          value={query}
          onChange={(e) => {
            onQueryChange(e.target.value);
          }}
          placeholder="Ask the knowledge base…"
          rows={3}
          style={{
            width: "100%",
            borderRadius: "var(--r-md)",
            border: "1px solid var(--color-border)",
            background: "var(--color-surface-2)",
            padding: "4px 8px",
            fontFamily: "var(--font-mono)",
            color: "var(--color-text)",
            fontSize: 12,
          }}
        />
      </label>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
          gap: 12,
          marginTop: 12,
        }}
      >
        <label style={{ gridColumn: "span 4 / span 4" }}>
          <span
            style={{
              marginBottom: 4,
              display: "block",
              color: "var(--color-text-secondary)",
              fontSize: 12,
            }}
          >
            topK ({topK})
          </span>
          <Input
            type="range"
            min={1}
            max={100}
            value={topK}
            onChange={(e) => {
              onTopKChange(parseInt(e.target.value, 10));
            }}
            style={{ width: "100%" }}
          />
        </label>
        <label style={{ gridColumn: "span 4 / span 4" }}>
          <span
            style={{
              marginBottom: 4,
              display: "block",
              color: "var(--color-text-secondary)",
              fontSize: 12,
            }}
          >
            Collection
          </span>
          <Input
            type="text"
            value={collection}
            onChange={(e) => {
              onCollectionChange(e.target.value);
            }}
            style={{ width: "100%" }}
          />
        </label>
        <div style={{ gridColumn: "span 4 / span 4", display: "flex", alignItems: "flex-end" }}>
          <Button variant="primary" size="sm" type="submit" disabled={props.isSearching}>
            {props.isSearching ? "Searching…" : "Search"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function ResultsList(props: { lastResponse: SearchResponse | null }): React.JSX.Element {
  const { lastResponse } = props;
  const [openResult, setOpenResult] = useState<string | null>(null);
  return (
    <div style={{ marginTop: 16 }}>
      {lastResponse?.results.map((r) => (
        <div
          key={r.document.id}
          style={{
            marginBottom: 8,
            padding: 12,
            borderRadius: "var(--r-md)",
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span
                style={{
                  fontSize: 10,
                  padding: "2px 4px",
                  borderRadius: 4,
                  background: "var(--color-surface-2)",
                }}
              >
                {formatScore(r.score)}
              </span>
              <Badge variant="default">{r.document.id}</Badge>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpenResult(openResult === r.document.id ? null : r.document.id);
              }}
            >
              {openResult === r.document.id ? "Hide meta" : "Show meta"}
            </Button>
          </div>
          <div style={{ marginTop: 8, fontSize: 14 }}>{truncateContent(r.document.content)}</div>
          {openResult === r.document.id && (
            <pre
              style={{
                marginTop: 8,
                padding: 8,
                borderRadius: 4,
                background: "var(--color-surface-2)",
                fontSize: 10,
                overflowX: "auto",
              }}
            >
              {JSON.stringify(r.document.metadata, null, 2)}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

export function QueryTab(props: {
  nodeName: string;
  collection: string;
  onCollectionChange: (v: string) => void;
  embedder: EmbedderBinding | null;
  provider: RagProviderKind | null;
}): React.JSX.Element {
  const { nodeName, collection, onCollectionChange, embedder, provider } = props;
  const utils = trpc.useUtils();
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(10);
  const [filterText, setFilterText] = useState("");
  const [filterError, setFilterError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [lastResponse, setLastResponse] = useState<SearchResponse | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  async function onSubmit(): Promise<void> {
    setSubmitError(null);
    setFilterError(null);
    if (!query.trim()) {
      setSubmitError("Query text is required.");
      return;
    }
    let filter: Record<string, unknown> | undefined;
    if (filterText.trim()) {
      try {
        const parsed: unknown = JSON.parse(filterText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("Must be an object.");
        filter = parsed as Record<string, unknown>;
      } catch (e) {
        setFilterError(`Invalid JSON: ${(e as Error).message}`);
        return;
      }
    }
    setIsSearching(true);
    try {
      const res = await utils.ragSearch.fetch({
        node: nodeName,
        query: query.trim(),
        topK,
        collection: collection.trim() || undefined,
        filter,
      });
      setLastResponse(res);
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setIsSearching(false);
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <CollectionHeader
        nodeName={nodeName}
        collection={collection}
        embedder={embedder}
        provider={provider}
      />
      <QueryForm
        query={query}
        onQueryChange={setQuery}
        topK={topK}
        onTopKChange={setTopK}
        collection={collection}
        onCollectionChange={onCollectionChange}
        isSearching={isSearching}
        onSubmit={() => {
          void onSubmit();
        }}
      />
      {filterError && (
        <div style={{ marginTop: 8, color: "var(--color-err)", fontSize: 12 }}>{filterError}</div>
      )}
      {submitError && (
        <div style={{ marginTop: 12, color: "var(--color-err)", fontSize: 14 }}>
          Failed: {submitError}
        </div>
      )}
      <ResultsList lastResponse={lastResponse} />
    </div>
  );
}
