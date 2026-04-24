import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { trpc } from '@/lib/trpc';
import { useTabStore } from '@/stores/tab-store';
import { Badge, Button } from '@/ui';

/**
 * Chat module. Scopes a conversation to a node + model; streams
 * responses via `chatStream` from the dispatcher router so both
 * agent and cloud nodes work through the same surface.
 *
 * Persistence: a zustand-persisted store keeps conversations locally
 * per-renderer (no server-side history yet — bring-your-own cloud
 * keys mean conversation logs stay on the laptop).
 */

interface RetrievedDoc {
  id: string;
  score: number;
  /** First ~200 chars of the doc so users can see what was pulled. */
  contentPreview: string;
}

interface RetrievedContext {
  sourceNode: string;
  docs: RetrievedDoc[];
  /** Total characters of doc content injected into the LLM request. */
  totalChars: number;
  /** True when docs were trimmed to fit the per-turn context budget. */
  truncated: boolean;
}

interface Message {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'error';
  content: string;
  /**
   * Auto-retrieval metadata. Attached to the user message that
   * triggered retrieval so transparency-minded users can inspect
   * what the LLM actually saw.
   */
  retrievedContext?: RetrievedContext;
}

/**
 * Per-conversation RAG binding. Picks the knowledge base we consult
 * before each turn plus how many top-K docs to fetch.
 */
const DEFAULT_RAG_TOP_K = 5;

/**
 * Per-turn context budget (character count). A rough 4-chars ≈ 1
 * token rule gives us ~3000 tokens — under a typical 4K input window
 * with headroom for the user message + prior turns. Tunable later.
 */
const MAX_CONTEXT_CHARS = 12000;

const CONTENT_PREVIEW_CHARS = 200;

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
  /**
   * Auto-context: when set, every send first queries this RAG node
   * with the user's message, trims top-K docs to the per-turn
   * budget, and prepends a system message carrying the snippets.
   * Compare-mode side B is intentionally not RAG-aware in v1 — it's
   * a model-comparison feature, not a knowledge one.
   */
  ragNode?: string;
  ragTopK?: number;
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
  setRagBinding: (id: string, ragNode: string | null, ragTopK?: number) => void;
  patchMessage: (convId: string, messageId: string, patch: Partial<Message>) => void;
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
      patchMessage: (convId, messageId, patch) =>
        set((s) => {
          const conv = s.conversations[convId];
          if (!conv) return s;
          const idx = conv.messages.findIndex((m) => m.id === messageId);
          if (idx < 0) return s;
          const updated = { ...conv.messages[idx]!, ...patch };
          return {
            conversations: {
              ...s.conversations,
              [convId]: {
                ...conv,
                messages: [
                  ...conv.messages.slice(0, idx),
                  updated,
                  ...conv.messages.slice(idx + 1),
                ],
              },
            },
          };
        }),
      setRagBinding: (id, ragNode, ragTopK) =>
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
        <span className="text-xs uppercase tracking-widest text-[color:var(--color-text-secondary)]">
          Chats
        </span>
        <Button type="button" variant="secondary" size="sm" onClick={props.onNew}>
          New
        </Button>
      </div>
      <ul className="flex-1 overflow-auto">
        {props.conversations.length === 0 && (
          <li className="p-3 text-xs text-[color:var(--color-text-secondary)]">
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
              className="flex-1 truncate text-left text-[color:var(--color-text)]"
            >
              <div className="truncate">{c.title}</div>
              <div className="truncate text-[10px] text-[color:var(--color-text-secondary)]">
                {c.node} · {c.model}
              </div>
            </button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => props.onDelete(c.id)}
              title="Delete conversation"
              aria-label="Delete conversation"
            >
              ×
            </Button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function MessageBubble(props: { message: Message }): React.JSX.Element {
  const { role, content, retrievedContext } = props.message;
  const [showContext, setShowContext] = useState(false);
  const align =
    role === 'user'
      ? 'items-end'
      : role === 'error'
        ? 'items-center'
        : 'items-start';
  const bg =
    role === 'user'
      ? 'bg-[var(--color-ok)] text-[color:var(--color-text-inverse)]'
      : role === 'error'
        ? 'bg-[var(--color-err)] text-[color:var(--color-text-inverse)]'
        : 'bg-[var(--color-surface-1)] text-[color:var(--color-text)]';
  return (
    <div className={`flex flex-col ${align} gap-1`} data-role={role}>
      <span className="text-[10px] uppercase tracking-widest text-[color:var(--color-text-secondary)]">
        {role}
      </span>
      <div
        className={`max-w-[80%] whitespace-pre-wrap break-words rounded-md border border-[var(--color-border)] px-3 py-2 text-sm ${bg}`}
      >
        {content || (role === 'assistant' ? '…' : '')}
      </div>
      {retrievedContext && (
        <div className="max-w-[80%] rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[10px] text-[color:var(--color-text-secondary)]">
          <button
            type="button"
            onClick={() => setShowContext((v) => !v)}
            className="flex items-center gap-2 font-mono"
            data-testid="chat-rag-disclosure"
          >
            <span>{showContext ? '▾' : '▸'}</span>
            <span>
              retrieved {retrievedContext.docs.length} doc
              {retrievedContext.docs.length === 1 ? '' : 's'} from
              {' '}
              <span className="text-[color:var(--color-text)]">
                {retrievedContext.sourceNode}
              </span>
              {' '}
              · {retrievedContext.totalChars} chars
              {retrievedContext.truncated ? ' (trimmed)' : ''}
            </span>
          </button>
          {showContext && (
            <ul className="mt-2 space-y-1">
              {retrievedContext.docs.map((d) => (
                <li key={d.id} className="flex flex-col gap-0.5 font-mono">
                  <span>
                    <span className="text-[color:var(--color-text)]">{d.id}</span>
                    <span className="ml-2">score={d.score.toFixed(3)}</span>
                  </span>
                  <span className="whitespace-pre-wrap">{d.contentPreview}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Inline CTA shown when the chat's active node is `local` and the
 * model dropdown resolved empty — nothing to chat with. Kicks off
 * a llama-server start against the catalog's default rel; polls
 * /health for up-to-60s; on success the parent re-fires the
 * nodeModels query and the dropdown populates.
 */
function LocalServerStartInline({ onStarted }: { onStarted?: () => void }): React.JSX.Element {
  const utils = trpc.useUtils();
  const catalog = trpc.catalogList.useQuery('all');
  const [picked, setPicked] = React.useState<string>('');
  const start = trpc.serverStart.useSubscription(
    picked ? { target: picked } : { target: 'noop' },
    {
      enabled: picked !== '',
      onData: (evt: unknown) => {
        const e = evt as { type?: string; result?: { ok?: boolean } };
        if (e.type === 'done' && e.result?.ok) {
          setPicked('');
          void utils.nodeModels.invalidate();
          void utils.serverStatus.invalidate();
          onStarted?.();
        }
      },
      onError: () => setPicked(''),
    } as Parameters<typeof trpc.serverStart.useSubscription>[1],
  );
  void start;
  const rels = React.useMemo(() => {
    const rows = (catalog.data ?? []) as Array<{ rel?: string }>;
    return rows.map((r) => r.rel).filter((r): r is string => typeof r === 'string');
  }, [catalog.data]);
  const [choice, setChoice] = React.useState<string>('');
  React.useEffect(() => {
    if (!choice && rels.length > 0) setChoice(rels[0]!);
  }, [rels, choice]);
  const isStarting = picked !== '';
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3">
      <div className="mb-2 text-xs text-[color:var(--color-text)]">
        Start local llama-server
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          disabled={isStarting}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 font-mono text-xs text-[color:var(--color-text)] disabled:opacity-40"
        >
          {rels.length === 0 ? (
            <option value="">(no catalog entries)</option>
          ) : (
            rels.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))
          )}
        </select>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => setPicked(choice)}
          disabled={isStarting || !choice}
          loading={isStarting}
          data-testid="chat-empty-start-local"
        >
          {isStarting ? 'Starting…' : 'Start'}
        </Button>
        <span className="text-[10px] text-[color:var(--color-text-secondary)]">
          or open <button
            type="button"
            onClick={() =>
              useTabStore.getState().open({
                tabKey: 'module:models.server',
                title: 'Local Server',
                kind: 'module',
                openedAt: Date.now(),
              })
            }
            className="underline hover:text-[color:var(--color-text)]"
          >Models → Local Server</button> for the full flow.
        </span>
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
  onStartedLocal?: () => void;
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
        <Badge variant="default">{props.label}</Badge>
        <span className="text-[color:var(--color-text-secondary)]">node</span>
        <select
          value={props.node}
          onChange={(e) => props.onNodeChange(e.target.value)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 font-mono text-[11px] text-[color:var(--color-text)]"
        >
          {props.nodes.map((n) => (
            <option key={n.name} value={n.name}>
              {n.name}
            </option>
          ))}
        </select>
        <span className="ml-3 text-[color:var(--color-text-secondary)]">model</span>
        {props.modelsLoading ? (
          <span className="text-[10px] text-[color:var(--color-text-secondary)]">loading…</span>
        ) : (
          <select
            value={props.model}
            onChange={(e) => props.onModelChange(e.target.value)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 font-mono text-[11px] text-[color:var(--color-text)]"
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
          <div className="flex flex-col gap-3">
            <div className="text-sm text-[color:var(--color-text-secondary)]">
              {!props.modelsLoading && props.models.length === 0 && props.node === 'local'
                ? 'Local llama-server isn\u2019t running yet \u2014 no models to chat with.'
                : !props.modelsLoading && props.models.length === 0
                  ? `No models exposed by ${props.node}.`
                  : 'Start a conversation by typing below.'}
            </div>
            {!props.modelsLoading && props.models.length === 0 && props.node === 'local' && (
              <LocalServerStartInline onStarted={props.onStartedLocal} />
            )}
          </div>
        )}
        {props.messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-[10px]">
        <span className="text-[color:var(--color-text-secondary)]">capabilities:</span>
        {CAPABILITY_TAGS.map((tag) => {
          const active = props.capabilities.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              onClick={() => props.onToggleCapability(tag)}
              className={`rounded-full border px-2 py-0.5 font-mono transition-colors ${
                active
                  ? 'border-[var(--color-ok)] bg-[var(--color-ok)] text-[color:var(--color-text-inverse)]'
                  : 'border-[var(--color-border)] bg-[var(--color-surface-2)] text-[color:var(--color-text-secondary)]'
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

function RagPicker(props: {
  nodes: Array<{ name: string; effectiveKind?: string }>;
  ragNode: string | null;
  ragTopK: number;
  onChange: (node: string | null, topK: number) => void;
}): React.JSX.Element | null {
  const ragNodes = props.nodes.filter((n) => n.effectiveKind === 'rag');
  if (ragNodes.length === 0) return null;
  return (
    <div className="flex items-center gap-1" data-testid="chat-rag-picker">
      <span className="text-[10px] uppercase tracking-widest text-[color:var(--color-text-secondary)]">
        rag
      </span>
      <select
        value={props.ragNode ?? ''}
        onChange={(e) =>
          props.onChange(e.target.value || null, props.ragTopK)
        }
        className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 font-mono text-[11px] text-[color:var(--color-text)]"
        title="Auto-retrieve context from this knowledge base on every turn"
      >
        <option value="">(off)</option>
        {ragNodes.map((n) => (
          <option key={n.name} value={n.name}>
            {n.name}
          </option>
        ))}
      </select>
      {props.ragNode && (
        <>
          <span className="text-[10px] text-[color:var(--color-text-secondary)]">top</span>
          <input
            type="number"
            min={1}
            max={20}
            value={props.ragTopK}
            onChange={(e) =>
              props.onChange(props.ragNode, Number.parseInt(e.target.value, 10) || DEFAULT_RAG_TOP_K)
            }
            className="w-10 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 py-0.5 font-mono text-[11px] text-[color:var(--color-text)]"
            title="How many top docs to inject"
          />
        </>
      )}
    </div>
  );
}

function ComposerBar(props: {
  busy: boolean;
  onSend: (text: string) => void | Promise<void>;
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
        className="h-16 flex-1 resize-none rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[color:var(--color-text)]"
      />
      <Button
        type="submit"
        variant="primary"
        size="md"
        disabled={props.busy || !input.trim()}
        loading={props.busy}
      >
        {props.busy ? 'Streaming…' : 'Send'}
      </Button>
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

  // Chat needs a node that serves `/v1/chat/completions` — agents
  // (llama-server), gateways (sirius/embersynth), cloud-direct
  // (openai/anthropic/gemini), and provider-via-gateway bindings
  // all qualify. RAG nodes (Chroma/pgvector) don't speak chat, so
  // they're filtered out.
  const nodes = useMemo(
    () =>
      (nodeList.data?.nodes ?? []).filter(
        (n) => (n.effectiveKind ?? 'agent') !== 'rag',
      ),
    [nodeList.data],
  );
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
  // When the node changed (model got cleared) OR the stored model
  // doesn't match any model the new node exposes, auto-pick the
  // first option. Avoids the stale-model-crossover bug where
  // switching from gemini-direct → anthropic-direct left
  // `models/gemini-2.5-flash` in the chat's meta and every
  // subsequent request 404'd.
  useEffect(() => {
    if (!active || !activeId) return;
    if (models.length === 0) return;
    if (!active.model || !models.includes(active.model)) {
      store.updateMeta(activeId, { model: models[0]! });
    }
  }, [active, activeId, models, store]);
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
    contextMessage?: { role: 'system'; content: string },
  ): StreamInput['request'] {
    const priorTurns = history.filter(
      (m) => m.role === 'user' || m.role === 'assistant',
    );
    return {
      model,
      messages: [
        ...(contextMessage ? [contextMessage] : []),
        ...priorTurns,
        { role: 'user', content: text },
      ].map((m) => ({ role: m.role, content: m.content })),
      // Carry capability hints via providerOptions so orchestrators
      // (embersynth) see them on the wire. Omit the field entirely
      // when no tags are active so other gateways don't receive a
      // stray empty array in the request body.
      ...(capabilities.length > 0 ? { providerOptions: { capabilities } } : {}),
    };
  }

  /**
   * Auto-retrieval. Fetches top-K from `ragNode` via `ragSearch`,
   * trims to the per-turn character budget, and shapes both the
   * system-message content and the metadata we'll attach to the user
   * message for UI transparency. Returns `null` when retrieval fails
   * so the chat sends without context rather than erroring out the
   * whole turn.
   */
  const utils = trpc.useUtils();
  async function retrieveContext(
    ragNode: string,
    query: string,
    topK: number,
  ): Promise<{
    systemMessage: { role: 'system'; content: string };
    metadata: RetrievedContext;
  } | null> {
    let response;
    try {
      response = await utils.ragSearch.fetch({
        node: ragNode,
        query,
        topK,
      });
    } catch {
      return null;
    }
    const hits = response.results ?? [];
    if (hits.length === 0) return null;

    // Greedy budget-fill: keep adding docs to the system-message
    // body until the next doc would blow the char budget, then stop.
    const parts: string[] = [
      `Relevant context from knowledge base "${ragNode}":`,
    ];
    const attachedDocs: RetrievedDoc[] = [];
    let used = parts[0]!.length;
    let truncated = false;
    for (const hit of hits) {
      const body = hit.document.content ?? '';
      const chunk = `--- doc ${hit.document.id} (score=${hit.score.toFixed(3)}) ---\n${body}`;
      if (used + chunk.length + 2 > MAX_CONTEXT_CHARS) {
        truncated = true;
        break;
      }
      parts.push(chunk);
      used += chunk.length + 2;
      attachedDocs.push({
        id: hit.document.id,
        score: hit.score,
        contentPreview: body.slice(0, CONTENT_PREVIEW_CHARS),
      });
    }
    if (attachedDocs.length === 0) return null;
    return {
      systemMessage: { role: 'system', content: parts.join('\n\n') },
      metadata: {
        sourceNode: ragNode,
        docs: attachedDocs,
        totalChars: used,
        truncated,
      },
    };
  }

  async function send(text: string): Promise<void> {
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

    // Auto-retrieve context when the conversation names a RAG node.
    // Failure is non-fatal — we send without context and let the
    // chat surface a clear error if the whole request blows up.
    let systemMessage: { role: 'system'; content: string } | undefined;
    if (active.ragNode) {
      const topK = active.ragTopK ?? DEFAULT_RAG_TOP_K;
      const ctx = await retrieveContext(active.ragNode, text, topK);
      if (ctx) {
        systemMessage = ctx.systemMessage;
        // Attach retrieval metadata to the user message that
        // triggered the search so the UI can render a transparency
        // disclosure under it.
        store.patchMessage(active.id, userMsg.id, {
          retrievedContext: ctx.metadata,
        });
      }
    }

    setStreamInputA({
      node: active.node,
      request: buildRequest(
        active.messages,
        text,
        active.model,
        active.capabilities ?? [],
        systemMessage,
      ),
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
      <div className="p-6 text-sm text-[color:var(--color-text-secondary)]">Loading…</div>
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
              onStartedLocal={() => { void modelList.refetch(); }}
              onNodeChange={(node) => store.updateMeta(active.id, { node, model: '' })}
              onModelChange={(model) => store.updateMeta(active.id, { model })}
              onToggleCapability={(tag) => store.toggleCapability(active.id, tag)}
              headerExtras={
                !active.compareWith ? (
                  <>
                    <RagPicker
                      nodes={nodes}
                      ragNode={active.ragNode ?? null}
                      ragTopK={active.ragTopK ?? DEFAULT_RAG_TOP_K}
                      onChange={(node, topK) =>
                        store.setRagBinding(active.id, node, topK)
                      }
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        store.setCompareWith(active.id, {
                          node: active.node,
                          model: active.model,
                          capabilities: active.capabilities,
                        })
                      }
                      data-testid="chat-compare"
                      title="Compare against another node/model — both panes stream the same prompt"
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
                modelsLoading={modelListB.isLoading}
                onNodeChange={(node) => store.updateCompareMeta(active.id, { node, model: '' })}
                onModelChange={(model) => store.updateCompareMeta(active.id, { model })}
                onToggleCapability={(tag) => store.toggleCompareCapability(active.id, tag)}
                headerExtras={
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => store.setCompareWith(active.id, null)}
                    data-testid="chat-compare-exit"
                    title="Exit compare mode — discards pane B transcript"
                    leadingIcon="×"
                  >
                    Exit compare
                  </Button>
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
            <h2 className="text-lg font-semibold text-[color:var(--color-text)]">
              Start a conversation
            </h2>
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              Chat scopes a conversation to a node + model. Attach capability
              tags (reasoning, vision, tools…) and orchestrators like
              embersynth will route by them. History stays on this laptop.
            </p>
            <Button
              type="button"
              variant="primary"
              size="md"
              onClick={newChat}
              data-testid="chat-new"
            >
              New chat
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
