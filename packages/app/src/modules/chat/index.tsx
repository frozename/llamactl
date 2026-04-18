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

interface Conversation {
  id: string;
  title: string;
  node: string;
  model: string;
  messages: Message[];
}

interface ChatStore {
  conversations: Record<string, Conversation>;
  activeId: string | null;
  create: (init: { node: string; model: string }) => string;
  setActive: (id: string) => void;
  append: (id: string, message: Message) => void;
  patchLast: (id: string, patch: Partial<Message>) => void;
  updateMeta: (id: string, patch: Partial<Pick<Conversation, 'node' | 'model' | 'title'>>) => void;
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

function ComposePane(props: {
  conversation: Conversation;
  onSend: (text: string) => void;
  busy: boolean;
  nodes: Array<{ name: string }>;
  models: string[];
  modelsLoading: boolean;
  onNodeChange: (node: string) => void;
  onModelChange: (model: string) => void;
}): React.JSX.Element {
  const [input, setInput] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
  }, [props.conversation.messages]);

  function submit(): void {
    const text = input.trim();
    if (!text || props.busy) return;
    props.onSend(text);
    setInput('');
  }

  return (
    <div className="flex h-full flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-2 text-xs">
        <span className="text-[color:var(--color-fg-muted)]">node</span>
        <select
          value={props.conversation.node}
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
            value={props.conversation.model}
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
      </header>
      <div
        ref={ref}
        className="flex flex-1 flex-col gap-4 overflow-auto bg-[var(--color-surface-0)] p-6"
      >
        {props.conversation.messages.length === 0 && (
          <div className="text-sm text-[color:var(--color-fg-muted)]">
            Start a conversation by typing below.
          </div>
        )}
        {props.conversation.messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </div>
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
    </div>
  );
}

export default function Chat(): React.JSX.Element {
  const store = useChatStore();
  const nodeList = trpc.nodeList.useQuery();
  const activeId = store.activeId;
  const active = activeId ? store.conversations[activeId] : undefined;
  const [busy, setBusy] = useState(false);
  const [streamKey, setStreamKey] = useState(0);
  const [streamInput, setStreamInput] = useState<{
    node: string;
    request: { model: string; messages: Array<{ role: string; content: string }> };
  } | null>(null);

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

  trpc.chatStream.useSubscription(streamInput ?? { node: 'local', request: { model: '', messages: [] } }, {
    enabled: !!streamInput,
    // Force a fresh subscription every time we bump the counter —
    // tRPC v11 only re-subscribes when input identity changes, and
    // sending the same prompt twice in a row shouldn't collapse.
    key: streamKey,
    onData: (evt) => {
      if (!activeId) return;
      const e = evt as {
        type?: string;
        chunk?: { choices?: [{ delta?: { content?: string } }] };
        error?: { message?: string };
        finish_reason?: string | null;
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
        setBusy(false);
        setStreamInput(null);
      } else if (e.type === 'done') {
        setBusy(false);
        setStreamInput(null);
      }
    },
    onError: (err) => {
      if (!activeId) return;
      store.append(activeId, {
        id: `m-${Date.now()}`,
        role: 'error',
        content: err.message,
      });
      setBusy(false);
      setStreamInput(null);
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

  function send(text: string): void {
    if (!active) return;
    const userMsg: Message = { id: `m-${Date.now()}-u`, role: 'user', content: text };
    const asstMsg: Message = { id: `m-${Date.now()}-a`, role: 'assistant', content: '' };
    store.append(active.id, userMsg);
    store.append(active.id, asstMsg);
    // Title the conversation from the first user prompt.
    if (active.messages.length === 0) {
      store.updateMeta(active.id, {
        title: text.slice(0, 48),
      });
    }
    setBusy(true);
    setStreamKey((k) => k + 1);
    setStreamInput({
      node: active.node,
      request: {
        model: active.model,
        messages: [
          ...active.messages.filter((m) => m.role === 'user' || m.role === 'assistant'),
          { role: 'user', content: text },
        ].map((m) => ({ role: m.role, content: m.content })),
      },
    });
  }

  if (nodeList.isLoading) {
    return (
      <div className="p-6 text-sm text-[color:var(--color-fg-muted)]">Loading…</div>
    );
  }

  return (
    <div className="flex h-full">
      <Sidebar
        activeId={store.activeId}
        conversations={conversationList}
        onSelect={store.setActive}
        onNew={newChat}
        onDelete={store.remove}
      />
      {active ? (
        <ComposePane
          conversation={active}
          onSend={send}
          busy={busy}
          nodes={nodes}
          models={models}
          modelsLoading={modelList.isLoading}
          onNodeChange={(node) => store.updateMeta(active.id, { node })}
          onModelChange={(model) => store.updateMeta(active.id, { model })}
        />
      ) : (
        <div className="flex h-full flex-1 items-center justify-center text-sm text-[color:var(--color-fg-muted)]">
          <button
            type="button"
            onClick={newChat}
            className="rounded border border-[var(--color-border)] bg-[var(--color-accent)] px-4 py-2 text-[color:var(--color-fg-inverted)]"
          >
            New chat
          </button>
        </div>
      )}
    </div>
  );
}
