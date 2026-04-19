import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { trpc } from '@/lib/trpc';

/**
 * Chat module. Scopes a conversation to a node + model; streams
 * responses via `chatStream` from the dispatcher router so both
 * agent and cloud nodes work through the same surface.
 *
 * Persistence: a zustand-persisted store keeps conversations locally
 * per-renderer (no server-side history yet — bring-your-own cloud
 * keys mean conversation logs stay on the laptop).
 */

interface Message {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'error';
  content: string;
}

/**
 * Capability vocabulary the chat input exposes. Mirrors nova's
 * `ModelCapability` enum. Tags ride the request via
 * `providerOptions.capabilities` so embersynth receives them (the
 * OpenAI-compat adapter merges providerOptions into the wire body;
 * sirius + direct providers ignore the extra field).
 */
const CAPABILITY_TAGS = [
  'reasoning',
  'long_context',
  'tools',
  'vision',
  'json_mode',
  'code',
] as const;
type CapabilityTag = (typeof CAPABILITY_TAGS)[number];

interface CompareMeta {
  node: string;
  model: string;
  capabilities?: CapabilityTag[];
}

interface Conversation {
  id: string;
  title: string;
  node: string;
  model: string;
  messages: Message[];
  /** Capability hints carried on every turn. Orchestrators like
   *  embersynth read these to pick the right node. */
  capabilities?: CapabilityTag[];
  /** A/B compare: when set, every send dispatches a second stream
   *  against this node/model/capabilities. The second transcript
   *  lives in `messagesB`. */
  compareWith?: CompareMeta | null;
  messagesB?: Message[];
}

interface ChatStore {
  conversations: Record<string, Conversation>;
  activeId: string | null;
  create: (init: { node: string; model: string }) => string;
  setActive: (id: string) => void;
  append: (id: string, message: Message) => void;
  patchLast: (id: string, patch: Partial<Message>) => void;
  appendB: (id: string, message: Message) => void;
  patchLastB: (id: string, patch: Partial<Message>) => void;
  updateMeta: (id: string, patch: Partial<Pick<Conversation, 'node' | 'model' | 'title'>>) => void;
  toggleCapability: (id: string, tag: CapabilityTag) => void;
  setCompareWith: (id: string, meta: CompareMeta | null) => void;
  updateCompareMeta: (id: string, patch: Partial<Pick<CompareMeta, 'node' | 'model'>>) => void;
  toggleCompareCapability: (id: string, tag: CapabilityTag) => void;
  remove: (id: string) => void;
}

const useChatStore = create<ChatStore>()(
  persist(
    (set) => ({
      conversations: {},
      activeId: null,
      create: ({ node, model }) => {
        const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        set((s) => ({
          conversations: {
            ...s.conversations,
            [id]: { id, title: 'New chat', node, model, messages: [] },
          },
          activeId: id,
        }));
        return id;
      },
      setActive: (id) => set({ activeId: id }),
      append: (id, message) =>
        set((s) => {
          const conv = s.conversations[id];
          if (!conv) return s;
          return {
            conversations: {
              ...s.conversations,
              [id]: { ...conv, messages: [...conv.messages, message] },
            },
          };
        }),
      patchLast: (id, patch) =>
        set((s) => {
          const conv = s.conversations[id];
          if (!conv || conv.messages.length === 0) return s;
          const last = conv.messages[conv.messages.length - 1]!;
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
        }),
      updateMeta: (id, patch) =>
        set((s) => {
          const conv = s.conversations[id];
          if (!conv) return s;
          return {
            conversations: {
              ...s.conversations,
              [id]: { ...conv, ...patch },
            },
          };
        }),
      toggleCapability: (id, tag) =>
        set((s) => {
          const conv = s.conversations[id];
          if (!conv) return s;
          const current = conv.capabilities ?? [];
          const next = current.includes(tag)
            ? current.filter((t) => t !== tag)
            : [...current, tag];
          return {
            conversations: {
              ...s.conversations,
              [id]: { ...conv, capabilities: next },
            },
          };
        }),
      appendB: (id, message) =>
        set((s) => {
          const conv = s.conversations[id];
          if (!conv) return s;
          return {
            conversations: {
              ...s.conversations,
              [id]: { ...conv, messagesB: [...(conv.messagesB ?? []), message] },
            },
          };
        }),
      patchLastB: (id, patch) =>
        set((s) => {
          const conv = s.conversations[id];
          const list = conv?.messagesB ?? [];
          if (!conv || list.length === 0) return s;
          const last = list[list.length - 1]!;
          return {
            conversations: {
              ...s.conversations,
              [id]: {
                ...conv,
                messagesB: [...list.slice(0, -1), { ...last, ...patch }],
              },
            },
          };
        }),
      setCompareWith: (id, meta) =>
        set((s) => {
          const conv = s.conversations[id];
          if (!conv) return s;
          return {
            conversations: {
              ...s.conversations,
              [id]: {
                ...conv,
                compareWith: meta,
                // Clear B's transcript on disable; otherwise keep it so
                // toggling off and on during a session doesn't nuke the
                // history mid-comparison.
                messagesB: meta === null ? [] : conv.messagesB ?? [],
              },
            },
          };
        }),
      updateCompareMeta: (id, patch) =>
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
        }),
      toggleCompareCapability: (id, tag) =>
        set((s) => {
          const conv = s.conversations[id];
          if (!conv?.compareWith) return s;
          const current = conv.compareWith.capabilities ?? [];
          const next = current.includes(tag)
            ? current.filter((t) => t !== tag)
            : [...current, tag];
          return {
            conversations: {
              ...s.conversations,
              [id]: {
                ...conv,
                compareWith: { ...conv.compareWith, capabilities: next },
              },
            },
          };
        }),
      remove: (id) =>
        set((s) => {
          const rest = { ...s.conversations };
          delete rest[id];
          const ids = Object.keys(rest);
          return {
            conversations: rest,
            activeId: s.activeId === id ? ids[0] ?? null : s.activeId,
          };
        }),
    }),
    { name: 'llamactl-chat' },
  ),
);

function Sidebar(props: {
  activeId: string | null;
  conversations: Conversation[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}): React.JSX.Element {
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-1)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <span className="text-xs uppercase tracking-widest text-[color:var(--color-fg-muted)]">
          Chats
        </span>
        <button
          type="button"
          onClick={props.onNew}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-fg)]"
        >
          + New
        </button>
      </div>
      <ul className="flex-1 overflow-auto">
        {props.conversations.length === 0 && (
          <li className="p-3 text-xs text-[color:var(--color-fg-muted)]">
            No chats yet.
          </li>
        )}
        {props.conversations.map((c) => (
          <li
            key={c.id}
            className={`flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2 text-xs ${
              c.id === props.activeId ? 'bg-[var(--color-surface-2)]' : ''
            }`}
          >
            <button
              type="button"
              onClick={() => props.onSelect(c.id)}
              className="flex-1 truncate text-left text-[color:var(--color-fg)]"
            >
              <div className="truncate">{c.title}</div>
              <div className="truncate text-[10px] text-[color:var(--color-fg-muted)]">
                {c.node} · {c.model}
              </div>
            </button>
            <button
              type="button"
              onClick={() => props.onDelete(c.id)}
              className="text-[color:var(--color-fg-muted)]"
              title="delete conversation"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function MessageBubble(props: { message: Message }): React.JSX.Element {
  const { role, content } = props.message;
  const align =
    role === 'user'
      ? 'items-end'
      : role === 'error'
        ? 'items-center'
        : 'items-start';
  const bg =
    role === 'user'
      ? 'bg-[var(--color-accent)] text-[color:var(--color-fg-inverted)]'
      : role === 'error'
        ? 'bg-[var(--color-danger)] text-[color:var(--color-fg-inverted)]'
        : 'bg-[var(--color-surface-1)] text-[color:var(--color-fg)]';
  return (
    <div className={`flex flex-col ${align} gap-1`}>
      <span className="text-[10px] uppercase tracking-widest text-[color:var(--color-fg-muted)]">
        {role}
      </span>
      <div
        className={`max-w-[80%] whitespace-pre-wrap break-words rounded-md border border-[var(--color-border)] px-3 py-2 text-sm ${bg}`}
      >
        {content || (role === 'assistant' ? '…' : '')}
      </div>
    </div>
  );
}

function TranscriptColumn(props: {
  label: string;
  node: string;
  model: string;
  messages: Message[];
  capabilities: CapabilityTag[];
  nodes: Array<{ name: string }>;
  models: string[];
  modelsLoading: boolean;
  onNodeChange: (node: string) => void;
  onModelChange: (model: string) => void;
  onToggleCapability: (tag: CapabilityTag) => void;
  headerExtras?: React.ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
  }, [props.messages]);

  return (
    <div
      className="flex min-w-0 flex-1 flex-col border-r border-[var(--color-border)] last:border-r-0"
      data-testid={`chat-pane-${props.label.toLowerCase()}`}
      data-pane={props.label}
    >
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-2 text-xs">
        <span className="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[color:var(--color-fg-muted)]">
          {props.label}
        </span>
        <span className="text-[color:var(--color-fg-muted)]">node</span>
        <select
          value={props.node}
          onChange={(e) => props.onNodeChange(e.target.value)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 font-mono text-[11px] text-[color:var(--color-fg)]"
        >
          {props.nodes.map((n) => (
            <option key={n.name} value={n.name}>
              {n.name}
            </option>
          ))}
        </select>
        <span className="ml-3 text-[color:var(--color-fg-muted)]">model</span>
        {props.modelsLoading ? (
          <span className="text-[10px] text-[color:var(--color-fg-muted)]">loading…</span>
        ) : (
          <select
            value={props.model}
            onChange={(e) => props.onModelChange(e.target.value)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 font-mono text-[11px] text-[color:var(--color-fg)]"
          >
            {props.models.length === 0 ? (
              <option value="">(no models)</option>
            ) : (
              props.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))
            )}
          </select>
        )}
        {props.headerExtras && <div className="ml-auto flex items-center gap-2">{props.headerExtras}</div>}
      </header>
      <div
        ref={ref}
        className="flex flex-1 flex-col gap-4 overflow-auto bg-[var(--color-surface-0)] p-6"
      >
        {props.messages.length === 0 && (
          <div className="text-sm text-[color:var(--color-fg-muted)]">
            Start a conversation by typing below.
          </div>
        )}
        {props.messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-[10px]">
        <span className="text-[color:var(--color-fg-muted)]">capabilities:</span>
        {CAPABILITY_TAGS.map((tag) => {
          const active = props.capabilities.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              onClick={() => props.onToggleCapability(tag)}
              className={`rounded-full border px-2 py-0.5 font-mono transition-colors ${
                active
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[color:var(--color-fg-inverted)]'
                  : 'border-[var(--color-border)] bg-[var(--color-surface-2)] text-[color:var(--color-fg-muted)]'
              }`}
              title={
                active
                  ? `remove ${tag}`
                  : `attach ${tag} — orchestrators route by capability tags`
              }
            >
              {tag.replace('_', '-')}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ComposerBar(props: {
  busy: boolean;
  onSend: (text: string) => void;
}): React.JSX.Element {
  const [input, setInput] = useState('');
  function submit(): void {
    const text = input.trim();
    if (!text || props.busy) return;
    props.onSend(text);
    setInput('');
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
    >
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Message (Shift+Enter for newline)…"
        className="h-16 flex-1 resize-none rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[color:var(--color-fg)]"
      />
      <button
        type="submit"
        disabled={props.busy || !input.trim()}
        className="rounded border border-[var(--color-border)] bg-[var(--color-accent)] px-4 text-sm text-[color:var(--color-fg-inverted)] disabled:opacity-50"
      >
        {props.busy ? 'Streaming…' : 'Send'}
      </button>
    </form>
  );
}

export default function Chat(): React.JSX.Element {
  const store = useChatStore();
  const nodeList = trpc.nodeList.useQuery();
  const activeId = store.activeId;
  const active = activeId ? store.conversations[activeId] : undefined;
  const [busyA, setBusyA] = useState(false);
  const [busyB, setBusyB] = useState(false);
  const [streamKeyA, setStreamKeyA] = useState(0);
  const [streamKeyB, setStreamKeyB] = useState(0);
  type StreamInput = {
    node: string;
    request: { model: string; messages: Array<{ role: string; content: string }> };
  };
  const [streamInputA, setStreamInputA] = useState<StreamInput | null>(null);
  const [streamInputB, setStreamInputB] = useState<StreamInput | null>(null);

  const nodes = useMemo(() => nodeList.data?.nodes ?? [], [nodeList.data]);
  const modelList = trpc.nodeModels.useQuery(
    { name: active?.node ?? 'local' },
    { enabled: !!active, staleTime: 60_000 },
  );
  const models = useMemo(
    () =>
      (modelList.data?.models as Array<{ id?: string }> | undefined)
        ?.map((m) => m.id)
        .filter((id): id is string => typeof id === 'string') ?? [],
    [modelList.data],
  );
  const modelListB = trpc.nodeModels.useQuery(
    { name: active?.compareWith?.node ?? 'local' },
    { enabled: !!active?.compareWith, staleTime: 60_000 },
  );
  const modelsB = useMemo(
    () =>
      (modelListB.data?.models as Array<{ id?: string }> | undefined)
        ?.map((m) => m.id)
        .filter((id): id is string => typeof id === 'string') ?? [],
    [modelListB.data],
  );

  trpc.chatStream.useSubscription(streamInputA ?? { node: 'local', request: { model: '', messages: [] } }, {
    enabled: !!streamInputA,
    // Force a fresh subscription every time we bump the counter —
    // tRPC v11 only re-subscribes when input identity changes, and
    // sending the same prompt twice in a row shouldn't collapse.
    key: streamKeyA,
    onData: (evt) => {
      if (!activeId) return;
      const e = evt as {
        type?: string;
        chunk?: { choices?: [{ delta?: { content?: string } }] };
        error?: { message?: string };
      };
      if (e.type === 'chunk') {
        const piece = e.chunk?.choices?.[0]?.delta?.content ?? '';
        if (piece) {
          store.patchLast(activeId, {
            content: (store.conversations[activeId]?.messages.slice(-1)[0]?.content ?? '') + piece,
          });
        }
      } else if (e.type === 'error') {
        store.append(activeId, {
          id: `m-${Date.now()}`,
          role: 'error',
          content: e.error?.message ?? 'stream error',
        });
        setBusyA(false);
        setStreamInputA(null);
      } else if (e.type === 'done') {
        setBusyA(false);
        setStreamInputA(null);
      }
    },
    onError: (err) => {
      if (!activeId) return;
      store.append(activeId, {
        id: `m-${Date.now()}`,
        role: 'error',
        content: err.message,
      });
      setBusyA(false);
      setStreamInputA(null);
    },
  } as Parameters<typeof trpc.chatStream.useSubscription>[1]);

  trpc.chatStream.useSubscription(streamInputB ?? { node: 'local', request: { model: '', messages: [] } }, {
    enabled: !!streamInputB,
    key: streamKeyB,
    onData: (evt) => {
      if (!activeId) return;
      const e = evt as {
        type?: string;
        chunk?: { choices?: [{ delta?: { content?: string } }] };
        error?: { message?: string };
      };
      if (e.type === 'chunk') {
        const piece = e.chunk?.choices?.[0]?.delta?.content ?? '';
        if (piece) {
          const last = store.conversations[activeId]?.messagesB?.slice(-1)[0]?.content ?? '';
          store.patchLastB(activeId, { content: last + piece });
        }
      } else if (e.type === 'error') {
        store.appendB(activeId, {
          id: `m-${Date.now()}`,
          role: 'error',
          content: e.error?.message ?? 'stream error',
        });
        setBusyB(false);
        setStreamInputB(null);
      } else if (e.type === 'done') {
        setBusyB(false);
        setStreamInputB(null);
      }
    },
    onError: (err) => {
      if (!activeId) return;
      store.appendB(activeId, {
        id: `m-${Date.now()}`,
        role: 'error',
        content: err.message,
      });
      setBusyB(false);
      setStreamInputB(null);
    },
  } as Parameters<typeof trpc.chatStream.useSubscription>[1]);

  const conversationList = useMemo(
    () => Object.values(store.conversations).sort((a, b) => b.id.localeCompare(a.id)),
    [store.conversations],
  );

  function newChat(): void {
    const node = nodes[0]?.name ?? 'local';
    const model = models[0] ?? '';
    store.create({ node, model });
  }

  function buildRequest(
    history: Message[],
    text: string,
    model: string,
    capabilities: CapabilityTag[],
  ): StreamInput['request'] {
    return {
      model,
      messages: [
        ...history.filter((m) => m.role === 'user' || m.role === 'assistant'),
        { role: 'user', content: text },
      ].map((m) => ({ role: m.role, content: m.content })),
      // Carry capability hints via providerOptions so orchestrators
      // (embersynth) see them on the wire. Omit the field entirely
      // when no tags are active so other gateways don't receive a
      // stray empty array in the request body.
      ...(capabilities.length > 0 ? { providerOptions: { capabilities } } : {}),
    };
  }

  function send(text: string): void {
    if (!active) return;
    const stamp = Date.now();
    const userMsg: Message = { id: `m-${stamp}-u`, role: 'user', content: text };
    const asstMsg: Message = { id: `m-${stamp}-a`, role: 'assistant', content: '' };
    store.append(active.id, userMsg);
    store.append(active.id, asstMsg);
    if (active.messages.length === 0) {
      store.updateMeta(active.id, { title: text.slice(0, 48) });
    }
    setBusyA(true);
    setStreamKeyA((k) => k + 1);
    setStreamInputA({
      node: active.node,
      request: buildRequest(active.messages, text, active.model, active.capabilities ?? []),
    });

    // Dispatch side B in parallel when compare mode is active. B's
    // history is independent so each side's context stays honest to
    // its own prior assistant turns.
    if (active.compareWith) {
      const userMsgB: Message = { id: `m-${stamp}-ub`, role: 'user', content: text };
      const asstMsgB: Message = { id: `m-${stamp}-ab`, role: 'assistant', content: '' };
      store.appendB(active.id, userMsgB);
      store.appendB(active.id, asstMsgB);
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
  }

  if (nodeList.isLoading) {
    return (
      <div className="p-6 text-sm text-[color:var(--color-fg-muted)]">Loading…</div>
    );
  }

  return (
    <div className="flex h-full" data-testid="chat-root">
      <h1 className="sr-only">Chat</h1>
      <Sidebar
        activeId={store.activeId}
        conversations={conversationList}
        onSelect={store.setActive}
        onNew={newChat}
        onDelete={store.remove}
      />
      {active ? (
        <div className="flex h-full flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <TranscriptColumn
              label="A"
              node={active.node}
              model={active.model}
              messages={active.messages}
              capabilities={active.capabilities ?? []}
              nodes={nodes}
              models={models}
              modelsLoading={modelList.isLoading}
              onNodeChange={(node) => store.updateMeta(active.id, { node })}
              onModelChange={(model) => store.updateMeta(active.id, { model })}
              onToggleCapability={(tag) => store.toggleCapability(active.id, tag)}
              headerExtras={
                !active.compareWith ? (
                  <button
                    type="button"
                    onClick={() =>
                      store.setCompareWith(active.id, {
                        node: active.node,
                        model: active.model,
                        capabilities: active.capabilities,
                      })
                    }
                    data-testid="chat-compare"
                    className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-fg)]"
                    title="Compare against another node/model — both panes stream the same prompt"
                  >
                    ⇄ Compare
                  </button>
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
                modelsLoading={modelListB.isLoading}
                onNodeChange={(node) => store.updateCompareMeta(active.id, { node })}
                onModelChange={(model) => store.updateCompareMeta(active.id, { model })}
                onToggleCapability={(tag) => store.toggleCompareCapability(active.id, tag)}
                headerExtras={
                  <button
                    type="button"
                    onClick={() => store.setCompareWith(active.id, null)}
                    data-testid="chat-compare-exit"
                    className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-fg)]"
                    title="Exit compare mode — discards pane B transcript"
                  >
                    × Exit compare
                  </button>
                }
              />
            ) : null}
          </div>
          <ComposerBar busy={busyA || busyB} onSend={send} />
        </div>
      ) : (
        <div
          className="flex h-full flex-1 items-center justify-center p-8"
          data-testid="chat-empty"
        >
          <div className="max-w-md space-y-3 text-center">
            <h2 className="text-lg font-semibold text-[color:var(--color-fg)]">
              Start a conversation
            </h2>
            <p className="text-sm text-[color:var(--color-fg-muted)]">
              Chat scopes a conversation to a node + model. Attach capability
              tags (reasoning, vision, tools…) and orchestrators like
              embersynth will route by them. History stays on this laptop.
            </p>
            <button
              type="button"
              onClick={newChat}
              data-testid="chat-new"
              className="rounded border border-[var(--color-border)] bg-[var(--color-accent)] px-4 py-2 text-sm text-[color:var(--color-fg-inverted)]"
            >
              New chat
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
