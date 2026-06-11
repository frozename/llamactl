import * as React from "react";
import { useMemo, useState } from "react";

import { trpc } from "@/lib/trpc";
import { Badge, Button } from "@/ui";

import type { AgentNodeSummary, RagNodeSummary, RagProviderKind, TabId } from "./types";

import { CollectionsTab } from "./collections-tab";
import { EmbedderPanel } from "./embedder-panel";
import { IndexingTab } from "./indexing-tab";
import { PipelinesTab } from "./pipelines-tab";
import { QualityTab } from "./quality-tab";
import { QueryTab } from "./query-tab";

interface RagNode {
  name: string;
  effectiveKind: string;
  rag?: {
    provider: string;
    embedder?: { node: string; model: string };
  };
}

interface AgentNode {
  name: string;
  effectiveKind: string;
  endpoint: string;
}

/** Root container — always rendered, in every state, so the smoke
 *  affordance `knowledge-retrieval-root` is unconditional. */
function KnowledgeShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{ height: "100%", overflow: "auto", padding: 24 }}
      data-testid="knowledge-retrieval-root"
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
        Knowledge
      </div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600, color: "var(--color-text)" }}>
        Retrieval-Augmented Generation
      </h1>
      <p style={{ marginBottom: 24, color: "var(--color-text-secondary)", fontSize: 12 }}>
        Query, browse, and index documents against the RAG nodes registered in your kubeconfig.
        Supported providers:{" "}
        <Badge variant="default" style={{ fontFamily: "var(--font-mono)" }}>
          chroma
        </Badge>{" "}
        and{" "}
        <Badge variant="default" style={{ fontFamily: "var(--font-mono)" }}>
          pgvector
        </Badge>
        .
      </p>
      {children}
    </div>
  );
}

function KnowledgeLoading(): React.JSX.Element {
  return (
    <div
      style={{
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        borderColor: "var(--color-border)",
        background: "var(--color-surface-1)",
        padding: 16,
        color: "var(--color-text-secondary)",
        fontSize: 14,
      }}
    >
      Loading nodes…
    </div>
  );
}

function KnowledgeEmptyState(): React.JSX.Element {
  return (
    <div
      style={{
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        borderStyle: "dashed",
        borderColor: "var(--color-border)",
        background: "var(--color-surface-1)",
        padding: 24,
      }}
      data-testid="knowledge-empty-state"
    >
      <div style={{ color: "var(--color-text)", fontSize: 14 }}>
        No knowledge bases yet — register one with{" "}
        <Badge variant="default" style={{ fontFamily: "var(--font-mono)" }}>
          llamactl node add …
        </Badge>
        .
      </div>
      <p style={{ marginTop: 8, color: "var(--color-text-secondary)", fontSize: 12 }}>
        Example for a Chroma node backed by the chroma-mcp server:
      </p>
      <pre
        style={{
          marginTop: 4,
          overflowX: "auto",
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          borderColor: "var(--color-border)",
          background: "var(--color-surface-2)",
          padding: 8,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--color-text)",
        }}
      >{`llamactl node add kb-chroma \\
  --rag=chroma \\
  --endpoint="chroma-mcp run --persist-directory /path/to/chroma-data"`}</pre>
      <p style={{ marginTop: 8, color: "var(--color-text-secondary)", fontSize: 12 }}>
        Or a pgvector node against a running Postgres with the{" "}
        <Badge variant="default" style={{ fontFamily: "var(--font-mono)" }}>
          vector
        </Badge>{" "}
        extension:
      </p>
      <pre
        style={{
          marginTop: 4,
          overflowX: "auto",
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          borderColor: "var(--color-border)",
          background: "var(--color-surface-2)",
          padding: 8,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--color-text)",
        }}
      >{`llamactl node add kb-pg \\
  --rag=pgvector \\
  --endpoint="postgres://kb_user:$PG_PASSWORD@db.local:5432/kb_main"`}</pre>
    </div>
  );
}

function KnowledgeConfig({
  selected,
  ragNodes,
  setSelectedNode,
  agentNodes,
}: {
  selected: RagNodeSummary;
  ragNodes: RagNodeSummary[];
  setSelectedNode: (name: string) => void;
  agentNodes: AgentNodeSummary[];
}): React.JSX.Element {
  return (
    <>
      <div
        style={{
          marginBottom: 16,
          display: "grid",
          gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
          gap: 12,
        }}
      >
        <label style={{ gridColumn: "span 6 / span 6", fontSize: 14 }}>
          <span
            style={{
              marginBottom: 4,
              display: "block",
              color: "var(--color-text-secondary)",
              fontSize: 12,
            }}
          >
            RAG node
          </span>
          <select
            value={selected.name}
            onChange={(e) => {
              setSelectedNode(e.target.value);
            }}
            data-testid="knowledge-node-select"
            style={{
              width: "100%",
              borderRadius: "var(--r-md)",
              border: "1px solid var(--color-border)",
              borderColor: "var(--color-border)",
              background: "var(--color-surface-2)",
              paddingLeft: 8,
              paddingRight: 8,
              paddingTop: 4,
              paddingBottom: 4,
              fontFamily: "var(--font-mono)",
              color: "var(--color-text)",
            }}
          >
            {ragNodes.map((n) => (
              <option key={n.name} value={n.name}>
                {n.name}
                {n.provider ? ` — ${n.provider}` : ""}
              </option>
            ))}
          </select>
        </label>
        <div
          style={{
            gridColumn: "span 6 / span 6",
            display: "flex",
            alignItems: "flex-end",
            gap: 8,
            color: "var(--color-text-secondary)",
            fontSize: 12,
          }}
        >
          <span>
            kind{" "}
            <Badge variant="default" style={{ fontFamily: "var(--font-mono)" }}>
              rag
            </Badge>
          </span>
          {selected.provider && (
            <span>
              · provider{" "}
              <Badge variant="default" style={{ fontFamily: "var(--font-mono)" }}>
                {selected.provider}
              </Badge>
            </span>
          )}
        </div>
      </div>
      <EmbedderPanel node={selected} agentNodes={agentNodes} />
    </>
  );
}

const TAB_DEFS: { id: TabId; label: string }[] = [
  { id: "query", label: "Query" },
  { id: "collections", label: "Collections" },
  { id: "indexing", label: "Indexing" },
  { id: "pipelines", label: "Pipelines" },
  { id: "quality", label: "Quality" },
];

function tabButtonStyle(active: boolean): React.CSSProperties {
  return active
    ? {
        borderBottom: "2px solid var(--color-border)",
        borderColor: "var(--color-brand)",
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 8,
        paddingBottom: 8,
        fontSize: 14,
        fontWeight: 500,
        color: "var(--color-text)",
      }
    : {
        borderBottom: "2px solid var(--color-border)",
        borderColor: "transparent",
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 8,
        paddingBottom: 8,
        fontSize: 14,
        color: "var(--color-text-secondary)",
      };
}

function KnowledgeTabs({
  activeTab,
  setActiveTab,
  selected,
  queryCollection,
  setQueryCollection,
  ragNodes,
}: {
  activeTab: TabId;
  setActiveTab: (id: TabId) => void;
  selected: RagNodeSummary;
  queryCollection: string;
  setQueryCollection: (c: string) => void;
  ragNodes: RagNodeSummary[];
}): React.JSX.Element {
  return (
    <>
      <div
        style={{
          marginBottom: 16,
          display: "flex",
          gap: 4,
          borderBottom: "1px solid var(--color-border)",
          borderColor: "var(--color-border)",
        }}
        data-testid="knowledge-tabs"
      >
        {TAB_DEFS.map((tab) => (
          <Button
            key={tab.id}
            type="button"
            onClick={() => {
              setActiveTab(tab.id);
            }}
            data-testid={`knowledge-tab-${tab.id}`}
            style={tabButtonStyle(tab.id === activeTab)}
          >
            {tab.label}
          </Button>
        ))}
      </div>
      <div data-testid={`knowledge-panel-${activeTab}`}>
        {activeTab === "query" && (
          <QueryTab
            nodeName={selected.name}
            collection={queryCollection}
            onCollectionChange={setQueryCollection}
            embedder={selected.embedder}
            provider={selected.provider}
          />
        )}
        {activeTab === "collections" && (
          <CollectionsTab
            nodeName={selected.name}
            onPick={(c) => {
              setQueryCollection(c);
              setActiveTab("query");
            }}
          />
        )}
        {activeTab === "indexing" && <IndexingTab nodeName={selected.name} />}
        {activeTab === "quality" && (
          <QualityTab nodeName={selected.name} collection={queryCollection} />
        )}
        {activeTab === "pipelines" && (
          <PipelinesTab nodeName={selected.name} availableNodes={ragNodes.map((n) => n.name)} />
        )}
      </div>
    </>
  );
}

export default function Knowledge(): React.JSX.Element {
  const nodes = trpc.nodeList.useQuery();
  const ragNodes = useMemo<RagNodeSummary[]>(() => {
    const rows = (nodes.data?.nodes ?? []) as RagNode[];
    return rows
      .filter((n) => n.effectiveKind === "rag")
      .map((n) => {
        const embedder = n.rag?.embedder;
        return {
          name: n.name,
          provider: (n.rag?.provider ?? null) as RagProviderKind | null,
          kind: "rag" as const,
          embedder: embedder ? { node: embedder.node, model: embedder.model } : null,
        };
      });
  }, [nodes.data]);

  const agentNodes = useMemo<AgentNodeSummary[]>(() => {
    const rows = (nodes.data?.nodes ?? []) as AgentNode[];
    return rows
      .filter((n) => n.effectiveKind === "agent")
      .map((n) => ({ name: n.name, endpoint: n.endpoint }));
  }, [nodes.data]);

  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("query");
  const [queryCollection, setQueryCollection] = useState("");

  React.useEffect(() => {
    const first = ragNodes[0];
    if (!selectedNode && first) {
      queueMicrotask(() => {
        setSelectedNode(first.name);
      });
    } else if (selectedNode && !ragNodes.some((n) => n.name === selectedNode)) {
      queueMicrotask(() => {
        setSelectedNode(first?.name ?? null);
      });
    }
  }, [ragNodes, selectedNode]);

  const selected = ragNodes.find((n) => n.name === selectedNode) ?? null;

  return (
    <KnowledgeShell>
      {nodes.isLoading && <KnowledgeLoading />}
      {!nodes.isLoading && ragNodes.length === 0 && <KnowledgeEmptyState />}
      {ragNodes.length > 0 && selected && (
        <>
          <KnowledgeConfig
            agentNodes={agentNodes}
            ragNodes={ragNodes}
            selected={selected}
            setSelectedNode={setSelectedNode}
          />
          <KnowledgeTabs
            activeTab={activeTab}
            queryCollection={queryCollection}
            ragNodes={ragNodes}
            selected={selected}
            setActiveTab={setActiveTab}
            setQueryCollection={setQueryCollection}
          />
        </>
      )}
    </KnowledgeShell>
  );
}
