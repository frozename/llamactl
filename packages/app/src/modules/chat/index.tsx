import * as React from "react";
import { useMemo } from "react";

import type { Conversation } from "./types";

import { ChatActiveView, ChatEmptyView, Sidebar } from "./components";
import { useChat } from "./use-chat";

/**
 * Chat module. Scopes a conversation to a node + model; streams
 * responses via `chatStream` from the dispatcher router so both
 * agent and cloud nodes work through the same surface.
 */
export default function Chat(): React.JSX.Element {
  const { store, activeId, active, nodes, models, modelsB, busyA, busyB, send, nodeList, newChat } =
    useChat();

  const conversationList = useMemo<Conversation[]>(
    () => Object.values(store.conversations).sort((a, b) => b.id.localeCompare(a.id)),
    [store.conversations],
  );

  const isLoading = (nodeList as { isLoading?: boolean }).isLoading;

  if (isLoading) {
    return (
      <div style={{ height: "100%" }} data-testid="chat-root">
        <div style={{ padding: 24, fontSize: 14, color: "var(--color-text-secondary)" }}>
          Loading…
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100%" }} data-testid="chat-root">
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
        Chat
      </h1>
      <Sidebar
        activeId={activeId}
        conversations={conversationList}
        onSelect={store.setActive}
        onNew={newChat}
        onDelete={store.remove}
      />
      {active ? (
        <ChatActiveView
          active={active}
          busyA={busyA}
          busyB={busyB}
          models={models}
          modelsB={modelsB}
          nodes={nodes}
          send={send}
          store={store}
        />
      ) : (
        <ChatEmptyView onNew={newChat} />
      )}
    </div>
  );
}
