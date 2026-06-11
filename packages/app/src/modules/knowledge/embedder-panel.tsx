import * as React from "react";
import { useState } from "react";

import { trpc } from "@/lib/trpc";
import { Badge, Button, Input } from "@/ui";

import type { RagNodeSummary, AgentNodeSummary, EmbedderBinding } from "./types";

function EmbedderEditForm(props: {
  draftNode: string;
  draftModel: string;
  onDraftNodeChange: (v: string) => void;
  onDraftModelChange: (v: string) => void;
  agentNodes: AgentNodeSummary[];
  busy: boolean;
  onSave: () => void;
}): React.JSX.Element {
  const { draftNode, draftModel, onDraftNodeChange, onDraftModelChange, agentNodes, busy, onSave } =
    props;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
      style={{
        marginTop: 12,
        display: "grid",
        gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
        gap: 12,
      }}
    >
      <div style={{ gridColumn: "span 5" }}>
        <select
          value={draftNode}
          onChange={(e) => {
            onDraftNodeChange(e.target.value);
          }}
          style={{
            width: "100%",
            padding: "4px",
            borderRadius: 4,
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border)",
          }}
        >
          <option value="">(pick a node)</option>
          {agentNodes.map((n) => (
            <option key={n.name} value={n.name}>
              {n.name}
            </option>
          ))}
        </select>
      </div>
      <div style={{ gridColumn: "span 5" }}>
        <Input
          type="text"
          value={draftModel}
          onChange={(e) => {
            onDraftModelChange(e.target.value);
          }}
          placeholder="model name"
          style={{ width: "100%" }}
        />
      </div>
      <div style={{ gridColumn: "span 2" }}>
        <Button size="sm" variant="primary" type="submit" disabled={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}

export function EmbedderPanel(props: {
  node: RagNodeSummary;
  agentNodes: AgentNodeSummary[];
}): React.JSX.Element {
  const { node, agentNodes } = props;
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [draftNode, setDraftNode] = useState(node.embedder?.node ?? "");
  const [draftModel, setDraftModel] = useState(node.embedder?.model ?? "");
  const [optimistic, setOptimistic] = useState<EmbedderBinding | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    queueMicrotask(() => {
      setDraftNode(node.embedder?.node ?? "");
      setDraftModel(node.embedder?.model ?? "");
      setOptimistic(undefined);
      setEditing(false);
      setError(null);
    });
  }, [node.name, node.embedder]);

  const mutation = trpc.nodeUpdateRagBinding.useMutation({
    onSuccess: async () => {
      setError(null);
      setEditing(false);
      await utils.nodeList.invalidate();
      setOptimistic(undefined);
    },
    onError: (err) => {
      setError(err.message);
      setOptimistic(undefined);
    },
  });

  const shown = optimistic !== undefined ? optimistic : node.embedder;

  function onSave(): void {
    if (!draftNode.trim() || !draftModel.trim()) {
      setError("Both required.");
      return;
    }
    const next = { node: draftNode.trim(), model: draftModel.trim() };
    setOptimistic(next);
    mutation.mutate({ node: node.name, embedder: next });
  }

  return (
    <div
      style={{
        marginBottom: 16,
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        background: "var(--color-surface-1)",
        padding: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              color: "var(--color-text-secondary)",
            }}
          >
            Embedder
          </div>
          {shown ? (
            <div style={{ marginTop: 4 }}>
              <Badge variant="default">{shown.node}</Badge> ·{" "}
              <Badge variant="default">{shown.model}</Badge>
            </div>
          ) : (
            <div style={{ color: "var(--color-text-secondary)", marginTop: 4 }}>none</div>
          )}
          {node.provider === "chroma" && (
            <div style={{ marginTop: 4, fontSize: 10, color: "var(--color-text-secondary)" }}>
              Chroma embeds internally — binding is ignored but persists for visibility.
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setEditing(!editing);
            }}
          >
            {editing ? "Cancel" : "Edit"}
          </Button>
          {shown && !editing && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setOptimistic(null);
                mutation.mutate({ node: node.name, embedder: null });
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>
      {editing && (
        <EmbedderEditForm
          draftNode={draftNode}
          draftModel={draftModel}
          onDraftNodeChange={setDraftNode}
          onDraftModelChange={setDraftModel}
          agentNodes={agentNodes}
          busy={mutation.isPending}
          onSave={onSave}
        />
      )}
      {error && (
        <div style={{ marginTop: 8, color: "var(--color-err)", fontSize: 12 }}>{error}</div>
      )}
    </div>
  );
}
