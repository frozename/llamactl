import { skipToken } from "@tanstack/react-query";
import * as React from "react";
import { useEffect, useRef, useState } from "react";

import { useActiveWorkload } from "@/hooks/useActiveWorkload";
import { trpc } from "@/lib/trpc";
import { useTabStore } from "@/stores/tab-store";
import { Badge, Button } from "@/ui";

import type { ChatStore } from "./store";
import type { CapabilityTag, Conversation, Message } from "./types";

import { CAPABILITY_TAGS } from "./types";

const DEFAULT_RAG_TOP_K = 5;

export function Sidebar(props: {
  activeId: string | null;
  conversations: Conversation[];
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
        background: "var(--color-surface-1)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--color-border)",
          padding: "8px 12px",
        }}
      >
        <span
          style={{
            fontSize: 12,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "var(--color-text-secondary)",
          }}
        >
          Chats
        </span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            props.onNew();
          }}
        >
          New
        </Button>
      </div>
      <ul style={{ flex: 1, overflow: "auto" }}>
        {props.conversations.length === 0 && (
          <li style={{ padding: 12, fontSize: 12, color: "var(--color-text-secondary)" }}>
            No chats yet.
          </li>
        )}
        {props.conversations.map((c) => (
          <li
            key={c.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              borderBottom: "1px solid var(--color-border)",
              padding: "8px 12px",
              fontSize: 12,
              ...(c.id === props.activeId ? { background: "var(--color-surface-2)" } : {}),
            }}
          >
            <button
              type="button"
              onClick={() => {
                props.onSelect(c.id);
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
                {c.title}
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
                {c.node} · {c.model}
              </div>
            </button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                props.onDelete(c.id);
              }}
              title="Delete"
              aria-label="Delete"
            >
              ×
            </Button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

export function MessageBubble(props: { message: Message }): React.JSX.Element {
  const { role, content, retrievedContext } = props.message;
  const [showContext, setShowContext] = useState(false);
  const align = role === "user" ? "flex-end" : role === "error" ? "center" : "flex-start";
  const bgStyle =
    role === "user"
      ? { background: "var(--color-brand)", color: "var(--color-brand-contrast)" }
      : role === "error"
        ? { background: "var(--color-err)", color: "var(--color-text-inverse)" }
        : { background: "var(--color-surface-1)", color: "var(--color-text)" };
  return (
    <div
      style={{ display: "flex", flexDirection: "column", alignItems: align, gap: 4 }}
      data-role={role}
    >
      <span
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--color-text-secondary)",
        }}
      >
        {role}
      </span>
      <div
        style={{
          maxWidth: "80%",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          padding: "8px 12px",
          fontSize: 14,
          ...bgStyle,
        }}
      >
        {content || (role === "assistant" ? "…" : "")}
      </div>
      {retrievedContext && (
        <div
          style={{
            borderRadius: "var(--r-md)",
            border: "1px solid var(--color-border)",
            background: "var(--color-surface-2)",
            padding: "4px 8px",
            fontSize: 10,
            color: "var(--color-text-secondary)",
          }}
        >
          <button
            type="button"
            onClick={() => {
              setShowContext((v) => !v);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontFamily: "var(--font-mono)",
            }}
          >
            <span>{showContext ? "▾" : "▸"}</span>
            <span>
              retrieved {retrievedContext.docs.length} doc
              {retrievedContext.docs.length === 1 ? "" : "s"} from{" "}
              <span style={{ color: "var(--color-text)" }}>{retrievedContext.sourceNode}</span> ·{" "}
              {retrievedContext.totalChars} chars {retrievedContext.truncated ? " (trimmed)" : ""}
            </span>
          </button>
          {showContext && (
            <ul style={{ marginTop: 4 }}>
              {retrievedContext.docs.map((d) => (
                <li
                  key={d.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <span>
                    <span style={{ color: "var(--color-text)" }}>{d.id}</span>
                    <span style={{ margin: "0 4px", opacity: 0.5 }}>·</span>
                    <span>score: {d.score.toFixed(4)}</span>
                  </span>
                  <div
                    style={{
                      maxHeight: 120,
                      overflow: "auto",
                      borderRadius: 2,
                      background: "var(--color-surface-3)",
                      padding: "4px 6px",
                      fontSize: 10,
                      lineHeight: 1.4,
                    }}
                  >
                    {d.contentPreview}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function LocalServerActions({
  picked,
  setPicked,
  rels,
  workload,
  onStarted,
}: {
  picked: string;
  setPicked: (p: string) => void;
  rels: string[];
  workload?: string;
  onStarted?: () => void;
}): React.JSX.Element {
  const utils = trpc.useUtils();
  const start = trpc.serverStart.useSubscription(
    picked && workload ? { target: picked, workload } : skipToken,
    {
      onData: (evt: unknown) => {
        const e = evt as { type?: string; result?: { ok?: boolean } };
        if (e.type === "done" && e.result?.ok) {
          setPicked("");
          void utils.nodeModels.invalidate();
          void utils.serverStatus.invalidate(workload ? { workload } : undefined);
          onStarted?.();
        }
      },
      onError: () => {
        setPicked("");
      },
    },
  );
  void start;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <select
        value={picked}
        onChange={(e) => {
          setPicked(e.target.value);
        }}
        style={{
          borderRadius: 4,
          border: "1px solid var(--color-border)",
          background: "var(--color-surface-2)",
          padding: "2px 4px",
          fontSize: 12,
        }}
      >
        <option value="">Start new model…</option>
        {rels.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {picked && (
        <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>Starting…</span>
      )}
    </div>
  );
}

export function LocalServerStartInline({
  onStarted,
}: {
  onStarted?: () => void;
}): React.JSX.Element {
  const { workload } = useActiveWorkload();
  const catalog = trpc.catalogList.useQuery("all");
  const rels = React.useMemo(
    () =>
      (catalog.data ?? [])
        .map((r) => (r as { rel: string }).rel)
        .filter((r): r is string => typeof r === "string"),
    [catalog.data],
  );
  const [picked, setPicked] = useState("");

  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" }}>
        Local server
      </div>
      <LocalServerActions
        onStarted={onStarted}
        picked={picked}
        rels={rels}
        setPicked={setPicked}
        workload={workload ?? undefined}
      />
      <div style={{ marginLeft: "auto" }}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            useTabStore.getState().open({
              tabKey: "models",
              title: "Models",
              kind: "module",
              openedAt: Date.now(),
            });
          }}
        >
          Open Catalog
        </Button>
      </div>
    </div>
  );
}

export function RagPicker(props: {
  nodes: { name: string; effectiveKind?: string }[];
  ragNode: string | null;
  ragTopK: number;
  onChange: (node: string | null, topK: number) => void;
}): React.JSX.Element {
  const ragNodes = props.nodes.filter((n) => n.effectiveKind === "rag");
  if (ragNodes.length === 0) return <></>;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <select
        value={props.ragNode ?? ""}
        onChange={(e) => {
          props.onChange(e.target.value || null, props.ragTopK);
        }}
        style={{
          borderRadius: 4,
          border: "1px solid var(--color-border)",
          background: "var(--color-surface-2)",
          padding: "4px 8px",
          fontSize: 12,
        }}
      >
        <option value="">No context (RAG)</option>
        {ragNodes.map((n) => (
          <option key={n.name} value={n.name}>
            {n.name}
          </option>
        ))}
      </select>
      {props.ragNode && (
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          topK
          <input
            type="number"
            min={1}
            max={50}
            value={props.ragTopK}
            onChange={(e) => {
              props.onChange(props.ragNode, Number(e.target.value) || DEFAULT_RAG_TOP_K);
            }}
            style={{
              width: 48,
              borderRadius: 4,
              border: "1px solid var(--color-border)",
              background: "var(--color-surface-2)",
              padding: "2px 4px",
              textAlign: "right",
            }}
          />
        </label>
      )}
    </div>
  );
}

function TranscriptHeader(props: {
  label: string;
  node: string;
  onNodeChange: (node: string) => void;
  nodes: { name: string; effectiveKind?: string }[];
  model: string;
  onModelChange: (model: string) => void;
  models: string[];
  modelsLoading: boolean;
  capabilities: string[];
  onToggleCapability: (tag: CapabilityTag) => void;
  headerExtras?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 12,
        borderBottom: "1px solid var(--color-border)",
        background: "var(--color-surface-1)",
        padding: "8px 12px",
      }}
    >
      <Badge variant="default" style={{ fontWeight: 600 }}>
        {props.label}
      </Badge>
      <select
        value={props.node}
        onChange={(e) => {
          props.onNodeChange(e.target.value);
        }}
        style={{
          borderRadius: 4,
          border: "1px solid var(--color-border)",
          background: "var(--color-surface-2)",
          padding: "4px 8px",
          fontSize: 12,
        }}
      >
        {props.nodes.map((n) => (
          <option key={n.name} value={n.name}>
            {n.name}
          </option>
        ))}
      </select>
      <select
        value={props.model}
        onChange={(e) => {
          props.onModelChange(e.target.value);
        }}
        disabled={props.modelsLoading}
        style={{
          borderRadius: 4,
          border: "1px solid var(--color-border)",
          background: "var(--color-surface-2)",
          padding: "4px 8px",
          fontSize: 12,
        }}
      >
        <option value="">(no model)</option>
        {props.models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <div style={{ display: "flex", gap: 4 }}>
        {CAPABILITY_TAGS.map((tag) => (
          <label
            key={tag}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              color: "var(--color-text-secondary)",
            }}
          >
            <input
              type="checkbox"
              checked={props.capabilities.includes(tag)}
              onChange={() => {
                props.onToggleCapability(tag);
              }}
            />
            {tag}
          </label>
        ))}
      </div>
      {props.headerExtras}
    </div>
  );
}

export function TranscriptColumn(props: {
  label: string;
  node: string;
  model: string;
  messages: Message[];
  capabilities: string[];
  nodes: { name: string; effectiveKind?: string }[];
  models: string[];
  modelsLoading: boolean;
  onNodeChange: (node: string) => void;
  onModelChange: (model: string) => void;
  onToggleCapability: (tag: CapabilityTag) => void;
  onStartedLocal?: () => void;
  headerExtras?: React.ReactNode;
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [props.messages]);

  return (
    <div
      data-testid={`chat-pane-${props.label.toLowerCase()}`}
      style={{
        display: "flex",
        height: "100%",
        flex: 1,
        flexDirection: "column",
        borderRight: props.label === "A" ? "1px solid var(--color-border)" : "none",
      }}
    >
      <TranscriptHeader
        capabilities={props.capabilities}
        headerExtras={props.headerExtras}
        label={props.label}
        model={props.model}
        models={props.models}
        modelsLoading={props.modelsLoading}
        node={props.node}
        nodes={props.nodes}
        onModelChange={props.onModelChange}
        onNodeChange={props.onNodeChange}
        onToggleCapability={props.onToggleCapability}
      />
      <div
        ref={scrollRef}
        style={{ flex: 1, overflow: "auto", background: "var(--color-surface-0)", padding: 16 }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {props.messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
        </div>
      </div>
      {props.node === "local" && <LocalServerStartInline onStarted={props.onStartedLocal} />}
    </div>
  );
}

export function ComposerBar(props: {
  busy: boolean;
  onSend: (text: string) => void;
}): React.JSX.Element {
  const [input, setInput] = useState("");
  const submit = (): void => {
    if (props.busy || !input.trim()) return;
    props.onSend(input);
    setInput("");
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      style={{
        display: "flex",
        gap: 8,
        borderTop: "1px solid var(--color-border)",
        background: "var(--color-surface-1)",
        padding: 12,
      }}
    >
      <textarea
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Message…"
        style={{
          height: 64,
          flex: 1,
          resize: "none",
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          background: "var(--color-surface-2)",
          padding: "8px 12px",
          fontSize: 14,
          color: "var(--color-text)",
        }}
      />
      <Button
        type="submit"
        variant="primary"
        size="md"
        disabled={props.busy || !input.trim()}
        loading={props.busy}
      >
        {props.busy ? "Streaming…" : "Send"}
      </Button>
    </form>
  );
}

export function ChatActiveView(props: {
  active: Conversation;
  nodes: { name: string; effectiveKind?: string }[];
  models: string[];
  modelsB: string[];
  busyA: boolean;
  busyB: boolean;
  send: (text: string) => Promise<void>;
  store: ChatStore;
}): React.JSX.Element {
  const { active, nodes, models, modelsB, busyA, busyB, send, store } = props;
  return (
    <div style={{ display: "flex", height: "100%", flex: 1, flexDirection: "column" }}>
      <div style={{ display: "flex", flex: 1 }}>
        <TranscriptColumn
          label="A"
          node={active.node}
          model={active.model}
          messages={active.messages}
          capabilities={active.capabilities ?? []}
          nodes={nodes}
          models={models}
          modelsLoading={false}
          onNodeChange={(node) => {
            store.updateMeta(active.id, { node, model: "" });
          }}
          onModelChange={(model) => {
            store.updateMeta(active.id, { model });
          }}
          onToggleCapability={(tag) => {
            store.toggleCapability(active.id, tag);
          }}
          headerExtras={
            !active.compareWith ? (
              <>
                <RagPicker
                  nodes={nodes}
                  ragNode={active.ragNode ?? null}
                  ragTopK={active.ragTopK ?? 5}
                  onChange={(node, topK) => {
                    store.setRagBinding(active.id, node, topK);
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    store.setCompareWith(active.id, {
                      node: active.node,
                      model: active.model,
                      capabilities: active.capabilities,
                    });
                  }}
                  data-testid="chat-compare"
                  title="Compare against another node/model"
                  leadingIcon="⇄"
                >
                  Compare
                </Button>
              </>
            ) : null
          }
        />
        {active.compareWith ? (
          <TranscriptColumn
            label="B"
            node={active.compareWith.node}
            model={active.compareWith.model}
            messages={active.messagesB ?? []}
            capabilities={active.compareWith.capabilities ?? []}
            nodes={nodes}
            models={modelsB}
            modelsLoading={false}
            onNodeChange={(node) => {
              store.updateCompareMeta(active.id, { node, model: "" });
            }}
            onModelChange={(model) => {
              store.updateCompareMeta(active.id, { model });
            }}
            onToggleCapability={(tag) => {
              store.toggleCompareCapability(active.id, tag);
            }}
            headerExtras={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  store.setCompareWith(active.id, null);
                }}
                data-testid="chat-compare-exit"
                title="Exit compare mode"
                leadingIcon="×"
              >
                Exit compare
              </Button>
            }
          />
        ) : null}
      </div>
      <ComposerBar
        busy={busyA || busyB}
        onSend={(text) => {
          void send(text);
        }}
      />
    </div>
  );
}

export function ChatEmptyView(props: { onNew: () => void }): React.JSX.Element {
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
      data-testid="chat-empty"
    >
      <div style={{ maxWidth: 448, marginTop: 12, textAlign: "center" }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--color-text)" }}>
          Start a conversation
        </h2>
        <p style={{ fontSize: 14, color: "var(--color-text-secondary)" }}>
          Chat scopes a conversation to a node + model. Attach capability tags (reasoning, vision,
          tools…) and orchestrators like embersynth will route by them. History stays on this
          laptop.
        </p>
        <Button
          type="button"
          variant="primary"
          size="md"
          onClick={() => {
            props.onNew();
          }}
          data-testid="chat-new"
        >
          New chat
        </Button>
      </div>
    </div>
  );
}
