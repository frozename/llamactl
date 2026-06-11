import * as React from "react";
import { useMemo } from "react";

import { Button, Input } from "@/ui";

import type { Pipeline } from "./types";

import { StageCard } from "./stage-card";
import { usePipelinesStore } from "./store";
import { usePipelines, type UsePipelinesReturn } from "./use-pipelines";

/**
 * Pipelines — ordered chains of model calls where stage N's final
 * assistant message becomes stage N+1's user content.
 */

export default function Pipelines(): React.JSX.Element {
  const store = usePipelinesStore();
  const pipelinesObj = usePipelines();
  const { nodeList, active, newPipeline } = pipelinesObj;

  const pipelineList = useMemo(
    () => Object.values(store.pipelines).sort((a, b) => b.id.localeCompare(a.id)),
    [store.pipelines],
  );

  if (nodeList.isLoading) {
    return (
      <div style={{ height: "100%" }} data-testid="knowledge-pipelines-root">
        <div style={{ padding: 24, color: "var(--color-text-secondary)", fontSize: 14 }}>
          Loading…
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100%" }} data-testid="knowledge-pipelines-root">
      <h1
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          borderWidth: 0,
        }}
      >
        Pipelines
      </h1>
      <Sidebar
        activeId={store.activeId}
        pipelines={pipelineList}
        onSelect={store.setActive}
        onNew={newPipeline}
        onDelete={store.remove}
      />
      {active ? <ActivePipeline pipelinesObj={pipelinesObj} /> : <EmptyState onNew={newPipeline} />}
    </div>
  );
}

function Sidebar(props: {
  activeId: string | null;
  pipelines: Pipeline[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}): React.JSX.Element {
  return (
    <aside
      style={{
        display: "flex",
        height: "100%",
        width: 240,
        flexShrink: 0,
        flexDirection: "column",
        borderRight: "1px solid var(--color-border)",
        borderColor: "var(--color-border)",
        background: "var(--color-surface-1)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--color-border)",
          borderColor: "var(--color-border)",
          paddingLeft: 12,
          paddingRight: 12,
          paddingTop: 8,
          paddingBottom: 8,
        }}
      >
        <span
          style={{
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "var(--color-text-secondary)",
            fontSize: 12,
          }}
        >
          Pipelines
        </span>
        <Button variant="secondary" size="sm" type="button" onClick={props.onNew}>
          + New
        </Button>
      </div>
      <ul style={{ flex: 1, overflow: "auto" }}>
        {props.pipelines.length === 0 && (
          <li style={{ padding: 12, color: "var(--color-text-secondary)", fontSize: 12 }}>
            No pipelines yet.
          </li>
        )}
        {props.pipelines.map((p) => (
          <li
            key={p.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              borderBottom: "1px solid var(--color-border)",
              paddingLeft: 12,
              paddingRight: 12,
              paddingTop: 8,
              paddingBottom: 8,
              fontSize: 12,
              ...(p.id === props.activeId ? { background: "var(--color-surface-2)" } : {}),
            }}
          >
            <Button
              type="button"
              onClick={() => {
                props.onSelect(p.id);
              }}
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                textAlign: "left",
                color: "var(--color-text)",
              }}
            >
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.name}
              </div>
              <div
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 10,
                  color: "var(--color-text-secondary)",
                }}
              >
                {p.stages.length} stage{p.stages.length === 1 ? "" : "s"}
              </div>
            </Button>
            <Button
              type="button"
              onClick={() => {
                props.onDelete(p.id);
              }}
              style={{ color: "var(--color-text-secondary)" }}
              title="delete pipeline"
            >
              ×
            </Button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function ActivePipeline({ pipelinesObj }: { pipelinesObj: UsePipelinesReturn }): React.JSX.Element {
  const { active } = pipelinesObj;
  if (!active) return <></>;

  return (
    <div style={{ display: "flex", height: "100%", flex: 1, flexDirection: "column" }}>
      <PipelineHeader pipelinesObj={pipelinesObj} />
      <PipelineExportResult pipelinesObj={pipelinesObj} />
      <PipelineContent pipelinesObj={pipelinesObj} />
      <PipelineInputForm pipelinesObj={pipelinesObj} />
    </div>
  );
}

function PipelineHeader({ pipelinesObj }: { pipelinesObj: UsePipelinesReturn }): React.JSX.Element {
  const { active, addStage, exportActiveAsMcp, exportMcp } = pipelinesObj;
  const store = usePipelinesStore();
  if (!active) return <></>;

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        borderBottom: "1px solid var(--color-border)",
        borderColor: "var(--color-border)",
        background: "var(--color-surface-1)",
        paddingLeft: 16,
        paddingRight: 16,
        paddingTop: 8,
        paddingBottom: 8,
        fontSize: 12,
      }}
    >
      <Input
        value={active.name}
        onChange={(e) => {
          store.rename(active.id, e.target.value);
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
          color: "var(--color-text)",
          fontSize: 14,
        }}
      />
      <span style={{ marginLeft: 8, color: "var(--color-text-secondary)" }}>
        {active.stages.length} stage{active.stages.length === 1 ? "" : "s"}
      </span>
      <Button
        variant="secondary"
        size="sm"
        type="button"
        onClick={addStage}
        data-testid="pipelines-add-stage"
      >
        + Add stage
      </Button>
      <Button
        type="button"
        onClick={() => {
          exportActiveAsMcp(false);
        }}
        disabled={exportMcp.isPending || active.stages.length === 0}
        data-testid="pipelines-save-mcp"
        title={
          active.stages.length === 0
            ? "Add a stage first"
            : "Emit ~/.llamactl/mcp/pipelines/<slug>.json so @llamactl/mcp mounts this as a tool."
        }
        style={{
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          borderColor: "var(--color-border)",
          background: "var(--color-surface-2)",
          paddingLeft: 8,
          paddingRight: 8,
          paddingTop: 2,
          paddingBottom: 2,
          fontSize: 10,
          color: "var(--color-text)",
          cursor: "not-allowed",
          opacity: 0.5,
        }}
      >
        {exportMcp.isPending ? "Saving…" : "⇪ Save as MCP tool"}
      </Button>
    </header>
  );
}

function PipelineExportResult({
  pipelinesObj,
}: {
  pipelinesObj: UsePipelinesReturn;
}): React.JSX.Element {
  const { exportInfo, setExportInfo, exportActiveAsMcp } = pipelinesObj;
  if (!exportInfo) return <></>;

  const isOk = exportInfo.kind === "ok";

  return (
    <div
      data-testid="pipelines-save-mcp-result"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        borderBottom: "1px solid var(--color-border)",
        borderColor: "var(--color-border)",
        background: "var(--color-surface-1)",
        paddingLeft: 16,
        paddingRight: 16,
        paddingTop: 4,
        paddingBottom: 4,
        fontSize: 11,
        color: isOk ? "var(--color-ok)" : "var(--color-err)",
      }}
    >
      {isOk ? (
        <span>
          Saved <span style={{ fontFamily: "var(--font-mono)" }}>{exportInfo.toolName}</span> →{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>{exportInfo.path}</span>
        </span>
      ) : (
        <span>{exportInfo.message}</span>
      )}
      {!isOk && /already exists/i.test(exportInfo.message) ? (
        <Button
          type="button"
          onClick={() => {
            exportActiveAsMcp(true);
          }}
          style={{
            borderRadius: "var(--r-md)",
            border: "1px solid var(--color-border)",
            borderColor: "var(--color-border)",
            paddingLeft: 8,
            paddingRight: 8,
            paddingTop: 2,
            paddingBottom: 2,
            fontSize: 10,
            color: "var(--color-text-secondary)",
          }}
        >
          Overwrite
        </Button>
      ) : (
        <Button
          type="button"
          onClick={() => {
            setExportInfo(null);
          }}
          style={{ color: "var(--color-text-secondary)" }}
        >
          ×
        </Button>
      )}
    </div>
  );
}

function PipelineContent({
  pipelinesObj,
}: {
  pipelinesObj: UsePipelinesReturn;
}): React.JSX.Element {
  const { active, runError, outputs, runningId, currentIdx, nodes } = pipelinesObj;
  const store = usePipelinesStore();
  if (!active) return <></>;

  return (
    <div
      style={{
        display: "flex",
        flex: 1,
        flexDirection: "column",
        gap: 12,
        overflow: "auto",
        background: "var(--color-surface-0)",
        padding: 24,
      }}
    >
      {runError && (
        <div
          style={{
            borderRadius: "var(--r-md)",
            border: "1px solid var(--color-border)",
            borderColor: "var(--color-err)",
            background: "var(--color-surface-1)",
            paddingLeft: 12,
            paddingRight: 12,
            paddingTop: 8,
            paddingBottom: 8,
            color: "var(--color-err)",
            fontSize: 14,
          }}
        >
          {runError}
        </div>
      )}
      {active.stages.map((stage, idx) => (
        <StageCard
          key={stage.id}
          stage={stage}
          index={idx}
          output={outputs[idx] ?? ""}
          running={runningId === active.id && currentIdx === idx}
          nodes={nodes}
          onUpdate={(patch) => {
            store.updateStage(active.id, stage.id, patch);
          }}
          onToggleCapability={(tag) => {
            store.toggleStageCapability(active.id, stage.id, tag);
          }}
          onRemove={() => {
            store.removeStage(active.id, stage.id);
          }}
        />
      ))}
    </div>
  );
}

function PipelineInputForm({
  pipelinesObj,
}: {
  pipelinesObj: UsePipelinesReturn;
}): React.JSX.Element {
  const { initialInput, setInitialInput, run, runningId, active, currentIdx } = pipelinesObj;
  if (!active) return <></>;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run();
      }}
      style={{
        display: "flex",
        gap: 8,
        borderTop: "1px solid var(--color-border)",
        borderColor: "var(--color-border)",
        background: "var(--color-surface-1)",
        padding: 12,
      }}
    >
      <textarea
        value={initialInput}
        onChange={(e) => {
          setInitialInput(e.target.value);
        }}
        placeholder="Initial input for stage 1…"
        style={{
          height: 64,
          flex: 1,
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
      <Button
        variant="primary"
        size="sm"
        type="submit"
        disabled={runningId !== null || !initialInput.trim() || active.stages.length === 0}
      >
        {runningId === active.id
          ? `Stage ${String(currentIdx + 1)}/${String(active.stages.length)}…`
          : "Run"}
      </Button>
    </form>
  );
}

function EmptyState({ onNew }: { onNew: () => void }): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
      }}
      data-testid="pipelines-empty"
    >
      <div style={{ maxWidth: 448, marginTop: 12, textAlign: "center" }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--color-text)" }}>
          Chain model calls into a pipeline
        </h2>
        <p style={{ color: "var(--color-text-secondary)", fontSize: 14 }}>
          Each stage consumes the previous stage&apos;s final assistant message. Useful for
          summarise → review → rewrite, vision-caption → reasoning, cheap-draft → cloud-polish.
        </p>
        <Button
          variant="primary"
          size="sm"
          type="button"
          onClick={onNew}
          data-testid="pipelines-new"
        >
          New pipeline
        </Button>
      </div>
    </div>
  );
}
