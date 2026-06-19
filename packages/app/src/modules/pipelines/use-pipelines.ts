import { useMemo, useState } from "react";

import type { Pipeline, Stage } from "./types";

import { trpc } from "../../lib/trpc";
import { usePipelinesStore } from "./store";

export interface UsePipelinesReturn {
  active: Pipeline | undefined;
  nodes: { name: string }[];
  initialInput: string;
  setInitialInput: (v: string) => void;
  runningId: string | null;
  currentIdx: number;
  outputs: string[];
  runError: string | null;
  exportInfo:
    | { kind: "ok"; path: string; toolName: string }
    | { kind: "error"; message: string }
    | null;
  setExportInfo: (
    v: { kind: "ok"; path: string; toolName: string } | { kind: "error"; message: string } | null,
  ) => void;
  exportMcp: ReturnType<typeof trpc.pipelineExportMcp.useMutation>;
  exportActiveAsMcp: (overwrite: boolean) => void;
  run: () => void;
  newPipeline: () => void;
  addStage: () => void;
  nodeList: ReturnType<typeof trpc.nodeList.useQuery>;
}

type StreamInput = {
  node: string;
  request: {
    model: string;
    messages: { role: string; content: string }[];
    providerOptions?: { capabilities: string[] };
  };
};

export interface ChatStreamEvent {
  type: "chunk" | "error" | "done";
  chunk?: { choices?: { delta?: { content?: string } }[] };
  error?: { message?: string };
}

export interface StageRunControls {
  setCurrentIdx: (v: number) => void;
  setOutputs: (update: (prev: string[]) => string[]) => void;
  setRunError: (v: string | null) => void;
  setRunningId: (v: string | null) => void;
  setStreamInput: (v: StreamInput | null) => void;
  setStreamKey: (update: (prev: number) => number) => void;
}

function advanceStage(
  pipeline: Pipeline,
  finishedIdx: number,
  finalOutput: string,
  c: StageRunControls,
): void {
  const nextIdx = finishedIdx + 1;
  if (nextIdx >= pipeline.stages.length) {
    c.setRunningId(null);
    c.setStreamInput(null);
    return;
  }
  const nextStage = pipeline.stages[nextIdx];
  if (!nextStage) return;
  c.setCurrentIdx(nextIdx);
  c.setOutputs((o) => [...o, ""]);
  c.setStreamKey((k) => k + 1);
  c.setStreamInput(buildStageRequest(nextStage, finalOutput));
}

export function applyChatStreamEvent(
  e: ChatStreamEvent,
  pipeline: Pipeline,
  currentIdx: number,
  c: StageRunControls,
): void {
  if (e.type === "chunk") {
    const piece = e.chunk?.choices?.[0]?.delta?.content ?? "";
    if (piece) {
      c.setOutputs((prev) => {
        const next = [...prev];
        const current = next[currentIdx] ?? "";
        next[currentIdx] = current + piece;
        return next;
      });
    }
  } else if (e.type === "error") {
    c.setRunError(e.error?.message ?? "stream error");
    c.setRunningId(null);
    c.setStreamInput(null);
  } else {
    c.setOutputs((prev) => {
      const final = prev[currentIdx] ?? "";
      queueMicrotask(() => {
        advanceStage(pipeline, currentIdx, final, c);
      });
      return prev;
    });
  }
}

// Resolve which pipeline should receive stream events.
// Keyed on runningId so that switching the active pipeline mid-run
// never redirects events to the newly-active pipeline.
export function selectRunningPipeline(
  pipelines: Record<string, Pipeline>,
  runningId: string | null,
): Pipeline | undefined {
  if (!runningId) return undefined;
  return pipelines[runningId];
}

function exportPipelineAsMcp(
  pipeline: Pipeline | undefined,
  overwrite: boolean,
  setExportInfo: UsePipelinesReturn["setExportInfo"],
  mutate: ReturnType<typeof trpc.pipelineExportMcp.useMutation>["mutate"],
): void {
  if (!pipeline || pipeline.stages.length === 0) {
    setExportInfo({
      kind: "error",
      message: pipeline ? "Pipeline has no stages" : "No active pipeline",
    });
    return;
  }
  setExportInfo(null);
  mutate({
    name: pipeline.name,
    stages: pipeline.stages.map((s) => ({
      node: s.node,
      model: s.model,
      systemPrompt: s.systemPrompt,
      capabilities: s.capabilities,
    })),
    overwrite,
  });
}

export function usePipelines(): UsePipelinesReturn {
  const store = usePipelinesStore();
  const nodeList = trpc.nodeList.useQuery();
  const nodes = useMemo(() => nodeList.data?.nodes ?? [], [nodeList.data]);
  const active = store.activeId ? store.pipelines[store.activeId] : undefined;

  const [initialInput, setInitialInput] = useState("");
  const [runningId, setRunningId] = useState<string | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [outputs, setOutputs] = useState<string[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [exportInfo, setExportInfo] = useState<
    { kind: "ok"; path: string; toolName: string } | { kind: "error"; message: string } | null
  >(null);
  const [streamKey, setStreamKey] = useState(0);
  const [streamInput, setStreamInput] = useState<StreamInput | null>(null);

  const exportMcp = trpc.pipelineExportMcp.useMutation({
    onSuccess: (res) => {
      if (res.ok) {
        setExportInfo({ kind: "ok", path: res.path, toolName: res.toolName });
      } else {
        setExportInfo({ kind: "error", message: res.message });
      }
    },
    onError: (err) => {
      setExportInfo({ kind: "error", message: err.message });
    },
  });

  const controls: StageRunControls = {
    setCurrentIdx,
    setOutputs,
    setRunError,
    setRunningId,
    setStreamInput,
    setStreamKey,
  };

  trpc.chatStream.useSubscription(
    streamInput ?? { node: "local", request: { model: "", messages: [] } },
    {
      enabled: !!streamInput,
      key: streamKey,
      onData: (evt) => {
        const running = selectRunningPipeline(store.pipelines, runningId);
        if (!running) return;
        applyChatStreamEvent(evt as ChatStreamEvent, running, currentIdx, controls);
      },
      onError: (err: { message: string }) => {
        setRunError(err.message);
        setRunningId(null);
        setStreamInput(null);
      },
    } as Parameters<typeof trpc.chatStream.useSubscription>[1],
  );

  return {
    active,
    nodes,
    initialInput,
    setInitialInput,
    runningId,
    currentIdx,
    outputs,
    runError,
    exportInfo,
    setExportInfo,
    exportMcp,
    nodeList,
    exportActiveAsMcp: (overwrite: boolean): void => {
      exportPipelineAsMcp(active, overwrite, setExportInfo, exportMcp.mutate);
    },
    run: (): void => {
      const text = initialInput.trim();
      if (!active || active.stages.length === 0 || !text) return;
      setRunError(null);
      setOutputs([""]);
      setCurrentIdx(0);
      setRunningId(active.id);
      setStreamKey((k) => k + 1);
      const first = active.stages[0];
      if (first) setStreamInput(buildStageRequest(first, text));
    },
    newPipeline: (): void => {
      store.create({ node: nodes[0]?.name ?? "local", model: "" });
    },
    addStage: (): void => {
      if (!active) return;
      const last = active.stages[active.stages.length - 1];
      store.addStage(active.id, {
        id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`,
        node: last?.node ?? nodes[0]?.name ?? "local",
        model: last?.model ?? "",
        systemPrompt: "",
        capabilities: [],
      });
    },
  };
}

function buildStageRequest(stage: Stage, userContent: string): StreamInput {
  const messages: { role: string; content: string }[] = [];
  if (stage.systemPrompt.trim()) {
    messages.push({ role: "system", content: stage.systemPrompt });
  }
  messages.push({ role: "user", content: userContent });
  return {
    node: stage.node,
    request: {
      model: stage.model,
      messages,
      ...(stage.capabilities.length > 0
        ? { providerOptions: { capabilities: stage.capabilities } }
        : {}),
    },
  };
}
