import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { CapabilityTag, CompareMeta, Conversation, Message } from "./types";

const DEFAULT_RAG_TOP_K = 5;

export interface ChatStore {
  conversations: Record<string, Conversation>;
  activeId: string | null;
  create: (init: { node: string; model: string }) => string;
  setActive: (id: string) => void;
  append: (id: string, message: Message) => void;
  patchLast: (id: string, patch: Partial<Message>) => void;
  appendB: (id: string, message: Message) => void;
  patchLastB: (id: string, patch: Partial<Message>) => void;
  updateMeta: (id: string, patch: Partial<Pick<Conversation, "node" | "model" | "title">>) => void;
  toggleCapability: (id: string, tag: CapabilityTag) => void;
  setCompareWith: (id: string, meta: CompareMeta | null) => void;
  updateCompareMeta: (id: string, patch: Partial<Pick<CompareMeta, "node" | "model">>) => void;
  toggleCompareCapability: (id: string, tag: CapabilityTag) => void;
  setRagBinding: (id: string, ragNode: string | null, ragTopK?: number) => void;
  patchMessage: (convId: string, messageId: string, patch: Partial<Message>) => void;
  remove: (id: string) => void;
}

type SetState = (
  next: Partial<ChatStore> | ((state: ChatStore) => Partial<ChatStore>),
  replace?: false,
) => void;

function createCoreActions(
  set: SetState,
): Pick<
  ChatStore,
  "create" | "setActive" | "updateMeta" | "toggleCapability" | "setRagBinding" | "remove"
> {
  return {
    create: ({ node, model }: { node: string; model: string }): string => {
      const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      set((s) => ({
        conversations: {
          ...s.conversations,
          [id]: { id, title: "New chat", node, model, messages: [] },
        },
        activeId: id,
      }));
      return id;
    },
    setActive: (id: string): void => {
      set({ activeId: id });
    },
    updateMeta: (
      id: string,
      patch: Partial<Pick<Conversation, "node" | "model" | "title">>,
    ): void => {
      set((s) => {
        const conv = s.conversations[id];
        if (!conv) return s;
        return {
          conversations: {
            ...s.conversations,
            [id]: { ...conv, ...patch },
          },
        };
      });
    },
    toggleCapability: (id: string, tag: CapabilityTag): void => {
      set((s) => {
        const conv = s.conversations[id];
        if (!conv) return s;
        const current = conv.capabilities ?? [];
        const next = current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag];
        return {
          conversations: {
            ...s.conversations,
            [id]: { ...conv, capabilities: next },
          },
        };
      });
    },
    setRagBinding: (id: string, ragNode: string | null, ragTopK?: number): void => {
      set((s) => {
        const conv = s.conversations[id];
        if (!conv) return s;
        const next: Conversation = { ...conv };
        if (ragNode === null) {
          delete next.ragNode;
          delete next.ragTopK;
        } else {
          next.ragNode = ragNode;
          next.ragTopK = ragTopK ?? conv.ragTopK ?? DEFAULT_RAG_TOP_K;
        }
        return {
          conversations: {
            ...s.conversations,
            [id]: next,
          },
        };
      });
    },
    remove: (id: string): void => {
      set((s) => {
        const rest = Object.fromEntries(
          Object.entries(s.conversations).filter(([key]) => key !== id),
        );
        const ids = Object.keys(rest);
        return {
          conversations: rest,
          activeId: s.activeId === id ? (ids[0] ?? null) : s.activeId,
        };
      });
    },
  };
}

function createMessageActions(
  set: SetState,
): Pick<ChatStore, "append" | "patchLast" | "patchMessage"> {
  return {
    append: (id: string, message: Message): void => {
      set((s) => {
        const conv = s.conversations[id];
        if (!conv) return s;
        return {
          conversations: {
            ...s.conversations,
            [id]: { ...conv, messages: [...conv.messages, message] },
          },
        };
      });
    },
    patchLast: (id: string, patch: Partial<Message>): void => {
      set((s) => {
        const conv = s.conversations[id];
        if (!conv || conv.messages.length === 0) return s;
        const last = conv.messages.at(-1);
        if (!last) return s;
        const updated = { ...last, ...patch };
        return {
          conversations: {
            ...s.conversations,
            [id]: {
              ...conv,
              messages: [...conv.messages.slice(0, -1), updated],
            },
          },
        };
      });
    },
    patchMessage: (convId: string, messageId: string, patch: Partial<Message>): void => {
      set((s) => {
        const conv = s.conversations[convId];
        if (!conv) return s;
        const idx = conv.messages.findIndex((m) => m.id === messageId);
        if (idx < 0) return s;
        const message = conv.messages[idx];
        if (!message) return s;
        const updated = { ...message, ...patch };
        return {
          conversations: {
            ...s.conversations,
            [convId]: {
              ...conv,
              messages: [...conv.messages.slice(0, idx), updated, ...conv.messages.slice(idx + 1)],
            },
          },
        };
      });
    },
  };
}

function createComparisonActions(
  set: SetState,
): Pick<
  ChatStore,
  "appendB" | "patchLastB" | "setCompareWith" | "updateCompareMeta" | "toggleCompareCapability"
> {
  return {
    appendB: (id: string, message: Message): void => {
      set((s) => {
        const conv = s.conversations[id];
        if (!conv) return s;
        return {
          conversations: {
            ...s.conversations,
            [id]: { ...conv, messagesB: [...(conv.messagesB ?? []), message] },
          },
        };
      });
    },
    patchLastB: (id: string, patch: Partial<Message>): void => {
      set((s) => {
        const conv = s.conversations[id];
        const list = conv?.messagesB ?? [];
        if (!conv || list.length === 0) return s;
        const last = list.at(-1);
        if (!last) return s;
        return {
          conversations: {
            ...s.conversations,
            [id]: {
              ...conv,
              messagesB: [...list.slice(0, -1), { ...last, ...patch }],
            },
          },
        };
      });
    },
    setCompareWith: (id: string, meta: CompareMeta | null): void => {
      set((s) => {
        const conv = s.conversations[id];
        if (!conv) return s;
        return {
          conversations: {
            ...s.conversations,
            [id]: {
              ...conv,
              compareWith: meta,
              messagesB: meta === null ? [] : (conv.messagesB ?? []),
            },
          },
        };
      });
    },
    updateCompareMeta: (id: string, patch: Partial<Pick<CompareMeta, "node" | "model">>): void => {
      set((s) => {
        const conv = s.conversations[id];
        if (!conv?.compareWith) return s;
        return {
          conversations: {
            ...s.conversations,
            [id]: {
              ...conv,
              compareWith: { ...conv.compareWith, ...patch },
            },
          },
        };
      });
    },
    toggleCompareCapability: (id: string, tag: CapabilityTag): void => {
      set((s) => {
        const conv = s.conversations[id];
        if (!conv?.compareWith) return s;
        const current = conv.compareWith.capabilities ?? [];
        const next = current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag];
        return {
          conversations: {
            ...s.conversations,
            [id]: {
              ...conv,
              compareWith: { ...conv.compareWith, capabilities: next },
            },
          },
        };
      });
    },
  };
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set) => ({
      conversations: {},
      activeId: null,
      ...createCoreActions(set),
      ...createMessageActions(set),
      ...createComparisonActions(set),
    }),
    { name: "llamactl-chat" },
  ),
);
