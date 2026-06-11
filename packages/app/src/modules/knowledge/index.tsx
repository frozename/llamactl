import * as React from "react";
import { useMemo, useState } from "react";

import { trpc } from "@/lib/trpc";
import { Button } from "@/ui";

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
        <label style={{ gridColumn: "span 6" }}>
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
            style={{
              width: "100%",
              padding: "4px",
              borderRadius: 4,
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {ragNodes.map((n) => (
              <option key={n.name} value={n.name}>
                {n.name} — {n.provider}
              </option>
            ))}
          </select>
        </label>
      </div>
      <EmbedderPanel node={selected} agentNodes={agentNodes} />
    </>
  );
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
        }}
      >
        {(["query", "collections", "indexing", "pipelines", "quality"] as TabId[]).map((id) => (
          <Button
            key={id}
            onClick={() => {
              setActiveTab(id);
            }}
            style={{
              padding: "8px 12px",
              borderBottom: id === activeTab ? "2px solid var(--color-brand)" : "none",
              color: id === activeTab ? "var(--color-text)" : "var(--color-text-secondary)",
            }}
          >
            {id.charAt(0).toUpperCase() + id.slice(1)}
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

function KnowledgeView({
  selected,
  agentNodes,
  ragNodes,
  setSelectedNode,
  activeTab,
  setActiveTab,
  queryCollection,
  setQueryCollection,
}: {
  selected: RagNodeSummary;
  agentNodes: AgentNodeSummary[];
  ragNodes: RagNodeSummary[];
  setSelectedNode: (name: string) => void;
  activeTab: TabId;
  setActiveTab: (id: TabId) => void;
  queryCollection: string;
  setQueryCollection: (c: string) => void;
}): React.JSX.Element {
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
      </p>
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
    </div>
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
          provider: n.rag?.provider as RagProviderKind,
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

  if (nodes.isLoading) {
    return (
      <div style={{ height: "100%", overflow: "auto", padding: 24 }}>
        <div style={{ padding: 16 }}>Loading nodes…</div>
      </div>
    );
  }

  if (ragNodes.length === 0) {
    return (
      <div style={{ height: "100%", overflow: "auto", padding: 24 }}>
        <div style={{ padding: 24, border: "1px dashed var(--color-border)" }}>
          No knowledge bases registered.
        </div>
      </div>
    );
  }

  if (!selected) return <></>;

  return (
    <KnowledgeView
      activeTab={activeTab}
      agentNodes={agentNodes}
      queryCollection={queryCollection}
      ragNodes={ragNodes}
      selected={selected}
      setActiveTab={setActiveTab}
      setQueryCollection={setQueryCollection}
      setSelectedNode={setSelectedNode}
    />
  );
}
