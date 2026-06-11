import { useEffect, useMemo, useState } from "react";

import { trpc } from "@/lib/trpc";

import type { CapabilityTag, Conversation, Message, RetrievedContext } from "./types";

import { type ChatStore, useChatStore } from "./store";
import { type ChatRequest, useChatActions } from "./use-chat-logic";

const DEFAULT_RAG_TOP_K = 5;

export interface UseChatResult {
  store: ChatStore;
  activeId: string | null;
  active: Conversation | undefined;
  nodes: { name: string; effectiveKind?: string }[];
  models: string[];
  modelsB: string[];
  busyA: boolean;
  busyB: boolean;
  modelList: unknown;
  modelListB: unknown;
  send: (text: string) => Promise<void>;
  nodeList: unknown;
  newChat: () => void;
}

type StreamInput = {
  node: string;
  request: ChatRequest;
};

interface StreamChunk {
  choices?: { delta?: { content?: string } }[];
}

function handleStreamChunk(id: string, isB: boolean, store: ChatStore, chunk: StreamChunk): void {
  const choices = chunk.choices;
  if (!choices) return;
  const delta = choices[0]?.delta;
  if (!delta?.content) return;
  const piece = delta.content;

  const conv = store.conversations[id];
  if (!conv) return;

  const msgs = isB ? conv.messagesB : conv.messages;
  const lastMsg = msgs ? msgs[msgs.length - 1] : undefined;
  const last = lastMsg?.content ?? "";

  if (isB) store.patchLastB(id, { content: last + piece });
  else store.patchLast(id, { content: last + piece });
}

function handleStreamError(
  id: string,
  isB: boolean,
  store: ChatStore,
  error: { message?: string },
): void {
  const msg: Message = {
    id: `m-${String(Date.now())}`,
    role: "error" as const,
    content: error.message ?? "stream error",
  };
  if (isB) store.appendB(id, msg);
  else store.append(id, msg);
}

function createDataHandler(
  id: string,
  isB: boolean,
  store: ChatStore,
  setBusy: (b: boolean) => void,
  setStreamInput: (s: StreamInput | null) => void,
): (evt: unknown) => void {
  return (evt: unknown): void => {
    const e = evt as {
      type?: string;
      chunk?: StreamChunk;
      error?: { message?: string };
    };
    if (e.type === "chunk" && e.chunk) {
      handleStreamChunk(id, isB, store, e.chunk);
    } else if (e.type === "error" || e.type === "done") {
      if (e.type === "error") {
        handleStreamError(id, isB, store, e.error ?? {});
      }
      setBusy(false);
      setStreamInput(null);
    }
  };
}

function createErrorHandler(
  id: string,
  isB: boolean,
  store: ChatStore,
  setBusy: (b: boolean) => void,
  setStreamInput: (s: StreamInput | null) => void,
): (err: { message: string }) => void {
  return (err: { message: string }): void => {
    const msg: Message = {
      id: `m-${String(Date.now())}`,
      role: "error" as const,
      content: err.message,
    };
    if (isB) {
      store.appendB(id, msg);
    } else {
      store.append(id, msg);
    }
    setBusy(false);
    setStreamInput(null);
  };
}

function useChatSubscriptions({
  activeId,
  streamInputA,
  streamInputB,
  streamKeyA,
  streamKeyB,
  setBusyA,
  setBusyB,
  setStreamInputA,
  setStreamInputB,
  store,
}: {
  activeId: string | null;
  streamInputA: StreamInput | null;
  streamInputB: StreamInput | null;
  streamKeyA: number;
  streamKeyB: number;
  setBusyA: (b: boolean) => void;
  setBusyB: (b: boolean) => void;
  setStreamInputA: (s: StreamInput | null) => void;
  setStreamInputB: (s: StreamInput | null) => void;
  store: ChatStore;
}): void {
  trpc.chatStream.useSubscription(
    streamInputA ?? { node: "local", request: { model: "", messages: [] } },
    {
      enabled: !!streamInputA,
      // Force a fresh subscription every time we bump the counter —
      // tRPC v11 only re-subscribes when input identity changes, and
      // sending the same prompt twice in a row shouldn't collapse.
      key: streamKeyA,
      onData: createDataHandler(activeId ?? "", false, store, setBusyA, setStreamInputA),
      onError: createErrorHandler(activeId ?? "", false, store, setBusyA, setStreamInputA),
    } as Parameters<typeof trpc.chatStream.useSubscription>[1],
  );
  trpc.chatStream.useSubscription(
    streamInputB ?? { node: "local", request: { model: "", messages: [] } },
    {
      enabled: !!streamInputB,
      key: streamKeyB,
      onData: createDataHandler(activeId ?? "", true, store, setBusyB, setStreamInputB),
      onError: createErrorHandler(activeId ?? "", true, store, setBusyB, setStreamInputB),
    } as Parameters<typeof trpc.chatStream.useSubscription>[1],
  );
}

function useChatModels(node: string | undefined): { modelList: unknown; models: string[] } {
  const modelList = trpc.nodeModels.useQuery(
    { name: node ?? "local" },
    { enabled: !!node, staleTime: 60_000 },
  );
  const models = useMemo(
    () =>
      (modelList.data?.models as { id?: string }[] | undefined)
        ?.map((m) => m.id)
        .filter((id): id is string => typeof id === "string") ?? [],
    [modelList.data],
  );
  return { modelList, models };
}

interface ChatSenderProps {
  active: Conversation | undefined;
  store: ChatStore;
  retrieveContext: (
    ragNode: string,
    text: string,
    topK: number,
  ) => Promise<{
    systemMessage: { role: "system"; content: string };
    metadata: RetrievedContext;
  } | null>;
  buildRequest: (
    messages: Message[],
    text: string,
    model: string,
    capabilities: CapabilityTag[],
    sysMsg?: { role: "system"; content: string },
  ) => ChatRequest;
  setBusyA: (b: boolean) => void;
  setBusyB: (b: boolean) => void;
  setStreamKeyA: (fn: (k: number) => number) => void;
  setStreamKeyB: (fn: (k: number) => number) => void;
  setStreamInputA: (s: StreamInput | null) => void;
  setStreamInputB: (s: StreamInput | null) => void;
}

function useChatSender(props: ChatSenderProps): (text: string) => Promise<void> {
  const {
    active,
    store,
    retrieveContext,
    buildRequest,
    setBusyA,
    setBusyB,
    setStreamKeyA,
    setStreamKeyB,
    setStreamInputA,
    setStreamInputB,
  } = props;
  return async (text: string): Promise<void> => {
    if (!active) return;
    const stamp = Date.now();
    const userMsg: Message = { id: `m-${String(stamp)}-u`, role: "user", content: text };
    const asstMsg: Message = { id: `m-${String(stamp)}-a`, role: "assistant", content: "" };
    store.append(active.id, userMsg);
    store.append(active.id, asstMsg);
    if (active.messages.length === 0) store.updateMeta(active.id, { title: text.slice(0, 48) });
    setBusyA(true);
    setStreamKeyA((k) => k + 1);

    let sysMsg: { role: "system"; content: string } | undefined;
    if (active.ragNode) {
      const ctx = await retrieveContext(active.ragNode, text, active.ragTopK ?? DEFAULT_RAG_TOP_K);
      if (ctx) {
        sysMsg = ctx.systemMessage;
        store.patchMessage(active.id, userMsg.id, { retrievedContext: ctx.metadata });
      }
    }
    setStreamInputA({
      node: active.node,
      request: buildRequest(active.messages, text, active.model, active.capabilities ?? [], sysMsg),
    });
    if (active.compareWith) {
      const uB: Message = { id: `m-${String(stamp)}-ub`, role: "user", content: text };
      const aB: Message = { id: `m-${String(stamp)}-ab`, role: "assistant", content: "" };
      store.appendB(active.id, uB);
      store.appendB(active.id, aB);
      setBusyB(true);
      setStreamKeyB((k) => k + 1);
      setStreamInputB({
        node: active.compareWith.node,
        request: buildRequest(
          active.messagesB ?? [],
          text,
          active.compareWith.model,
          active.compareWith.capabilities ?? [],
        ),
      });
    }
  };
}

export function useChat(): UseChatResult {
  const store = useChatStore();
  const { buildRequest, retrieveContext } = useChatActions();
  const nodeList = trpc.nodeList.useQuery();
  const activeId = store.activeId;
  const active = activeId ? store.conversations[activeId] : undefined;
  const [busyA, setBusyA] = useState(false);
  const [busyB, setBusyB] = useState(false);
  const [streamKeyA, setStreamKeyA] = useState(0);
  const [streamKeyB, setStreamKeyB] = useState(0);

  const [streamInputA, setStreamInputA] = useState<StreamInput | null>(null);
  const [streamInputB, setStreamInputB] = useState<StreamInput | null>(null);

  const nodes = useMemo(
    () => (nodeList.data?.nodes ?? []).filter((n) => n.effectiveKind !== "rag"),
    [nodeList.data],
  );

  const { modelList, models } = useChatModels(active?.node);
  const { modelList: modelListB, models: modelsB } = useChatModels(active?.compareWith?.node);

  useEffect(() => {
    if (!active || !activeId) return;
    const [firstModel] = models;
    if (firstModel && (!active.model || !models.includes(active.model))) {
      store.updateMeta(activeId, { model: firstModel });
    }
  }, [active, activeId, models, store]);

  useChatSubscriptions({
    activeId,
    streamInputA,
    streamInputB,
    streamKeyA,
    streamKeyB,
    setBusyA,
    setBusyB,
    setStreamInputA,
    setStreamInputB,
    store,
  });

  const send = useChatSender({
    active,
    store,
    retrieveContext,
    buildRequest,
    setBusyA,
    setBusyB,
    setStreamKeyA,
    setStreamKeyB,
    setStreamInputA,
    setStreamInputB,
  });

  return {
    store,
    activeId,
    active,
    nodes,
    models,
    modelsB,
    busyA,
    busyB,
    modelList,
    modelListB,
    send,
    nodeList,
    newChat: (): void => {
      const node = nodes[0]?.name ?? "local";
      const model = models[0] ?? "";
      store.create({ node, model });
    },
  };
}
