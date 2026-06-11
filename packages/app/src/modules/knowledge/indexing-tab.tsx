import * as React from "react";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Badge, Button, Input } from "@/ui";
import { parseIndexInput } from "./helpers";
import type { StoreResponse } from "./types";

function CollectionRow(props: {
  collection: string;
  onChange: (v: string) => void;
  busy: boolean;
}): React.JSX.Element {
  const { collection, onChange, busy } = props;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
        gap: 12,
        marginTop: 12,
      }}
    >
      <label style={{ gridColumn: "span 8 / span 8" }}>
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
            onChange(e.target.value);
          }}
          style={{ width: "100%" }}
        />
      </label>
      <div style={{ gridColumn: "span 4 / span 4", display: "flex", alignItems: "flex-end" }}>
        <Button variant="primary" size="sm" type="submit" disabled={busy}>
          {busy ? "Storing…" : "Store"}
        </Button>
      </div>
    </div>
  );
}

export function IndexingTab(props: { nodeName: string }): React.JSX.Element {
  const { nodeName } = props;
  const [text, setText] = useState("");
  const [collection, setCollection] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<StoreResponse | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const storeMut = trpc.ragStore.useMutation({
    onSuccess: (data) => {
      setLastResult(data);
      setSubmitError(null);
      setText("");
    },
    onError: (err) => {
      setLastResult(null);
      setSubmitError(err.message);
    },
  });

  function onSubmit(): void {
    setParseError(null);
    setSubmitError(null);
    const { documents, error } = parseIndexInput(text);
    if (error) {
      setParseError(error);
      return;
    }
    storeMut.mutate({ node: nodeName, documents, collection: collection.trim() || undefined });
  }

  return (
    <div style={{ marginTop: 16 }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
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
            Documents (JSON or paragraphs)
          </span>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setParseError(null);
            }}
            rows={10}
            style={{
              width: "100%",
              borderRadius: "var(--r-md)",
              border: "1px solid var(--color-border)",
              background: "var(--color-surface-2)",
              padding: "8px 12px",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          />
        </label>
        <CollectionRow collection={collection} onChange={setCollection} busy={storeMut.isPending} />
        {parseError && <div style={{ color: "var(--color-err)", fontSize: 12 }}>{parseError}</div>}
      </form>
      {submitError && (
        <div style={{ marginTop: 12, color: "var(--color-err)", fontSize: 14 }}>
          Failed: {submitError}
        </div>
      )}
      {lastResult && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            borderRadius: "var(--r-md)",
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-ok)",
          }}
        >
          Stored {lastResult.ids.length} docs in{" "}
          <Badge variant="default">{lastResult.collection}</Badge>
        </div>
      )}
    </div>
  );
}
