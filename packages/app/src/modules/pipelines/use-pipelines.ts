import { useMemo, useState } from "react";

import { trpc } from "@/lib/trpc";

import type { Pipeline, Stage } from "./types";

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

interface ChatStreamEvent {
  type: "chunk" | "error" | "done";
  chunk?: { choices?: { delta?: { content?: string } }[] };
  error?: { message?: string };
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

  const advance = (activePipeline: Pipeline, finishedIdx: number, finalOutput: string): void => {
    const nextIdx = finishedIdx + 1;
    if (nextIdx >= activePipeline.stages.length) {
      setRunningId(null);
      setStreamInput(null);
      return;
    }
    const nextStage = activePipeline.stages[nextIdx];
    if (!nextStage) return;
    setCurrentIdx(nextIdx);
    setOutputs((o) => [...o, ""]);
    setStreamKey((k) => k + 1);
    setStreamInput(buildStageRequest(nextStage, finalOutput));
  };

  trpc.chatStream.useSubscription(
    streamInput ?? { node: "local", request: { model: "", messages: [] } },
    {
      enabled: !!streamInput,
      key: streamKey,
      onData: (evt) => {
        if (!active || !runningId) return;
        const e = evt as ChatStreamEvent;
        if (e.type === "chunk") {
          const piece = e.chunk?.choices?.[0]?.delta?.content ?? "";
          if (piece) {
            setOutputs((prev) => {
              const next = [...prev];
              const current = next[currentIdx] ?? "";
              next[currentIdx] = current + piece;
              return next;
            });
          }
        } else if (e.type === "error") {
          setRunError(e.error?.message ?? "stream error");
          setRunningId(null);
          setStreamInput(null);
        } else {
          setOutputs((prev) => {
            const final = prev[currentIdx] ?? "";
            queueMicrotask(() => {
              advance(active, currentIdx, final);
            });
            return prev;
          });
        }
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
      if (!active || active.stages.length === 0) {
        setExportInfo({
          kind: "error",
          message: active ? "Pipeline has no stages" : "No active pipeline",
        });
        return;
      }
      setExportInfo(null);
      exportMcp.mutate({
        name: active.name,
        stages: active.stages.map((s) => ({
          node: s.node,
          model: s.model,
          systemPrompt: s.systemPrompt,
          capabilities: s.capabilities,
        })),
        overwrite,
      });
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
