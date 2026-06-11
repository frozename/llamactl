import * as React from "react";
import { useMemo } from "react";

import { trpc } from "@/lib/trpc";
import { Button } from "@/ui";

import { CAPABILITY_TAGS, type CapabilityTag, type Stage } from "./types";

export function StageCard(props: {
  stage: Stage;
  index: number;
  output: string;
  running: boolean;
  nodes: { name: string }[];
  onUpdate: (patch: Partial<Stage>) => void;
  onToggleCapability: (tag: CapabilityTag) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const modelList = trpc.nodeModels.useQuery({ name: props.stage.node }, { staleTime: 60_000 });
  const models = useMemo(
    () =>
      (modelList.data?.models as { id?: string }[] | undefined)
        ?.map((m) => m.id)
        .filter((id): id is string => typeof id === "string") ?? [],
    [modelList.data],
  );

  return (
    <div
      style={{
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        borderColor: "var(--color-border)",
        background: "var(--color-surface-1)",
      }}
    >
      <StageCardHeader
        index={props.index}
        stage={props.stage}
        nodes={props.nodes}
        models={models}
        onUpdate={props.onUpdate}
        onRemove={props.onRemove}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12 }}>
        <textarea
          value={props.stage.systemPrompt}
          onChange={(e) => {
            props.onUpdate({ systemPrompt: e.target.value });
          }}
          placeholder="System prompt (optional)…"
          style={{
            height: 64,
            resize: "none",
            borderRadius: "var(--r-md)",
            border: "1px solid var(--color-border)",
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            paddingLeft: 12,
            paddingRight: 12,
            paddingTop: 8,
            paddingBottom: 8,
            color: "var(--color-text)",
            fontSize: 14,
          }}
        />
        <StageCapabilities
          capabilities={props.stage.capabilities}
          onToggle={props.onToggleCapability}
        />
        <StageOutput output={props.output} running={props.running} />
      </div>
    </div>
  );
}

function StageCardHeader({
  index,
  stage,
  nodes,
  models,
  onUpdate,
  onRemove,
}: {
  index: number;
  stage: Stage;
  nodes: { name: string }[];
  models: string[];
  onUpdate: (patch: Partial<Stage>) => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        borderBottom: "1px solid var(--color-border)",
        borderColor: "var(--color-border)",
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 8,
        paddingBottom: 8,
        fontSize: 12,
      }}
    >
      <span
        style={{
          borderRadius: "var(--r-md)",
          background: "var(--color-surface-2)",
          paddingLeft: 6,
          paddingRight: 6,
          paddingTop: 2,
          paddingBottom: 2,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--color-text-secondary)",
        }}
      >
        #{index + 1}
      </span>
      <span style={{ color: "var(--color-text-secondary)" }}>node</span>
      <select
        value={stage.node}
        onChange={(e) => {
          onUpdate({ node: e.target.value });
        }}
        style={{
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          borderColor: "var(--color-border)",
          background: "var(--color-surface-2)",
          paddingLeft: 8,
          paddingRight: 8,
          paddingTop: 2,
          paddingBottom: 2,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--color-text)",
        }}
      >
        {nodes.map((n) => (
          <option key={n.name} value={n.name}>
            {n.name}
          </option>
        ))}
      </select>
      <span style={{ marginLeft: 8, color: "var(--color-text-secondary)" }}>model</span>
      <select
        value={stage.model}
        onChange={(e) => {
          onUpdate({ model: e.target.value });
        }}
        style={{
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          borderColor: "var(--color-border)",
          background: "var(--color-surface-2)",
          paddingLeft: 8,
          paddingRight: 8,
          paddingTop: 2,
          paddingBottom: 2,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--color-text)",
        }}
      >
        {models.length === 0 && <option value={stage.model}>{stage.model || "(none)"}</option>}
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <Button variant="secondary" size="sm" type="button" onClick={onRemove} title="remove stage">
        × remove
      </Button>
    </header>
  );
}

function StageCapabilities({
  capabilities,
  onToggle,
}: {
  capabilities: CapabilityTag[];
  onToggle: (tag: CapabilityTag) => void;
}): React.JSX.Element {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, fontSize: 10 }}>
      <span style={{ color: "var(--color-text-secondary)" }}>capabilities:</span>
      {CAPABILITY_TAGS.map((tag) => {
        const active = capabilities.includes(tag);
        return (
          <Button
            key={tag}
            type="button"
            onClick={() => {
              onToggle(tag);
            }}
            style={{
              borderRadius: 9999,
              border: "1px solid",
              paddingLeft: 8,
              paddingRight: 8,
              paddingTop: 2,
              paddingBottom: 2,
              fontFamily: "var(--font-mono)",
              transitionProperty:
                "color, background-color, border-color, text-decoration-color, fill, stroke",
              transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
              transitionDuration: "150ms",
              ...(active
                ? {
                    borderColor: "var(--color-brand)",
                    background: "var(--color-brand)",
                    color: "var(--color-brand-contrast)",
                  }
                : {
                    borderColor: "var(--color-border)",
                    background: "var(--color-surface-2)",
                    color: "var(--color-text-secondary)",
                  }),
            }}
          >
            {tag.replace("_", "-")}
          </Button>
        );
      })}
    </div>
  );
}

function StageOutput({ output, running }: { output: string; running: boolean }): React.JSX.Element {
  return (
    <div
      style={{
        minHeight: "3rem",
        whiteSpace: "pre-wrap",
        borderRadius: 4,
        border: "1px dashed var(--color-border)",
        backgroundColor: "var(--color-surface-0)",
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 8,
        paddingBottom: 8,
        fontSize: 12,
        ...(output ? { color: "var(--color-text)" } : { color: "var(--color-text-secondary)" }),
      }}
    >
      {output || (running ? "streaming…" : "no output yet")}
    </div>
  );
}
