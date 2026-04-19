import * as React from 'react';
import { useMemo, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { trpc } from '@/lib/trpc';

/**
 * Pipelines — ordered chains of model calls where stage N's final
 * assistant message becomes stage N+1's user content. No server-side
 * state: the renderer dispatches each stage through the dispatcher's
 * chatStream subscription and advances on the `done` event.
 *
 * Common shapes this unlocks without leaving the app:
 *   summarize → review → rewrite
 *   vision-caption → reasoning model → tool-call agent
 *   cheap-local draft → cloud-polish
 *
 * Parallel / fan-out stages are out of scope — that's Phase E
 * (multi-node RPC) and orthogonal to linear pipeline UX.
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

interface Stage {
  id: string;
  node: string;
  model: string;
  systemPrompt: string;
  capabilities: CapabilityTag[];
}

interface Pipeline {
  id: string;
  name: string;
  stages: Stage[];
}

interface PipelinesStore {
  pipelines: Record<string, Pipeline>;
  activeId: string | null;
  create: (init: { node: string; model: string }) => string;
  setActive: (id: string) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  addStage: (id: string, stage: Stage) => void;
  updateStage: (id: string, stageId: string, patch: Partial<Stage>) => void;
  removeStage: (id: string, stageId: string) => void;
  toggleStageCapability: (id: string, stageId: string, tag: CapabilityTag) => void;
}

const usePipelinesStore = create<PipelinesStore>()(
  persist(
    (set) => ({
      pipelines: {},
      activeId: null,
      create: ({ node, model }) => {
        const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        set((s) => ({
          pipelines: {
            ...s.pipelines,
            [id]: {
              id,
              name: 'New pipeline',
              stages: [
                {
                  id: `s-${Date.now().toString(36)}`,
                  node,
                  model,
                  systemPrompt: '',
                  capabilities: [],
                },
              ],
            },
          },
          activeId: id,
        }));
        return id;
      },
      setActive: (id) => set({ activeId: id }),
      rename: (id, name) =>
        set((s) => {
          const p = s.pipelines[id];
          if (!p) return s;
          return { pipelines: { ...s.pipelines, [id]: { ...p, name } } };
        }),
      remove: (id) =>
        set((s) => {
          const rest = { ...s.pipelines };
          delete rest[id];
          const ids = Object.keys(rest);
          return {
            pipelines: rest,
            activeId: s.activeId === id ? ids[0] ?? null : s.activeId,
          };
        }),
      addStage: (id, stage) =>
        set((s) => {
          const p = s.pipelines[id];
          if (!p) return s;
          return {
            pipelines: { ...s.pipelines, [id]: { ...p, stages: [...p.stages, stage] } },
          };
        }),
      updateStage: (id, stageId, patch) =>
        set((s) => {
          const p = s.pipelines[id];
          if (!p) return s;
          return {
            pipelines: {
              ...s.pipelines,
              [id]: {
                ...p,
                stages: p.stages.map((st) =>
                  st.id === stageId ? { ...st, ...patch } : st,
                ),
              },
            },
          };
        }),
      removeStage: (id, stageId) =>
        set((s) => {
          const p = s.pipelines[id];
          if (!p) return s;
          return {
            pipelines: {
              ...s.pipelines,
              [id]: { ...p, stages: p.stages.filter((st) => st.id !== stageId) },
            },
          };
        }),
      toggleStageCapability: (id, stageId, tag) =>
        set((s) => {
          const p = s.pipelines[id];
          if (!p) return s;
          return {
            pipelines: {
              ...s.pipelines,
              [id]: {
                ...p,
                stages: p.stages.map((st) => {
                  if (st.id !== stageId) return st;
                  const has = st.capabilities.includes(tag);
                  return {
                    ...st,
                    capabilities: has
                      ? st.capabilities.filter((t) => t !== tag)
                      : [...st.capabilities, tag],
                  };
                }),
              },
            },
          };
        }),
    }),
    { name: 'llamactl-pipelines' },
  ),
);

function Sidebar(props: {
  activeId: string | null;
  pipelines: Pipeline[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}): React.JSX.Element {
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-1)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <span className="text-xs uppercase tracking-widest text-[color:var(--color-fg-muted)]">
          Pipelines
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
        {props.pipelines.length === 0 && (
          <li className="p-3 text-xs text-[color:var(--color-fg-muted)]">
            No pipelines yet.
          </li>
        )}
        {props.pipelines.map((p) => (
          <li
            key={p.id}
            className={`flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2 text-xs ${
              p.id === props.activeId ? 'bg-[var(--color-surface-2)]' : ''
            }`}
          >
            <button
              type="button"
              onClick={() => props.onSelect(p.id)}
              className="flex-1 truncate text-left text-[color:var(--color-fg)]"
            >
              <div className="truncate">{p.name}</div>
              <div className="truncate text-[10px] text-[color:var(--color-fg-muted)]">
                {p.stages.length} stage{p.stages.length === 1 ? '' : 's'}
              </div>
            </button>
            <button
              type="button"
              onClick={() => props.onDelete(p.id)}
              className="text-[color:var(--color-fg-muted)]"
              title="delete pipeline"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function StageCard(props: {
  stage: Stage;
  index: number;
  output: string;
  running: boolean;
  nodes: Array<{ name: string }>;
  onUpdate: (patch: Partial<Stage>) => void;
  onToggleCapability: (tag: CapabilityTag) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const modelList = trpc.nodeModels.useQuery(
    { name: props.stage.node },
    { staleTime: 60_000 },
  );
  const models = useMemo(
    () =>
      (modelList.data?.models as Array<{ id?: string }> | undefined)
        ?.map((m) => m.id)
        .filter((id): id is string => typeof id === 'string') ?? [],
    [modelList.data],
  );
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)]">
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2 text-xs">
        <span className="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--color-fg-muted)]">
          #{props.index + 1}
        </span>
        <span className="text-[color:var(--color-fg-muted)]">node</span>
        <select
          value={props.stage.node}
          onChange={(e) => props.onUpdate({ node: e.target.value })}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 font-mono text-[11px] text-[color:var(--color-fg)]"
        >
          {props.nodes.map((n) => (
            <option key={n.name} value={n.name}>
              {n.name}
            </option>
          ))}
        </select>
        <span className="ml-2 text-[color:var(--color-fg-muted)]">model</span>
        <select
          value={props.stage.model}
          onChange={(e) => props.onUpdate({ model: e.target.value })}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 font-mono text-[11px] text-[color:var(--color-fg)]"
        >
          {models.length === 0 && <option value={props.stage.model}>{props.stage.model || '(none)'}</option>}
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={props.onRemove}
          className="ml-auto text-[10px] text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-danger)]"
          title="remove stage"
        >
          × remove
        </button>
      </header>
      <div className="flex flex-col gap-2 p-3">
        <textarea
          value={props.stage.systemPrompt}
          onChange={(e) => props.onUpdate({ systemPrompt: e.target.value })}
          placeholder="System prompt (optional)…"
          className="h-16 resize-none rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[color:var(--color-fg)]"
        />
        <div className="flex flex-wrap items-center gap-1 text-[10px]">
          <span className="text-[color:var(--color-fg-muted)]">capabilities:</span>
          {CAPABILITY_TAGS.map((tag) => {
            const active = props.stage.capabilities.includes(tag);
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
              >
                {tag.replace('_', '-')}
              </button>
            );
          })}
        </div>
        <div
          className={`min-h-[3rem] whitespace-pre-wrap rounded border border-dashed border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs ${
            props.output ? 'text-[color:var(--color-fg)]' : 'text-[color:var(--color-fg-muted)]'
          }`}
        >
          {props.output || (props.running ? 'streaming…' : 'no output yet')}
        </div>
      </div>
    </div>
  );
}

export default function Pipelines(): React.JSX.Element {
  const store = usePipelinesStore();
  const nodeList = trpc.nodeList.useQuery();
  const nodes = useMemo(() => nodeList.data?.nodes ?? [], [nodeList.data]);
  const active = store.activeId ? store.pipelines[store.activeId] : undefined;

  const [initialInput, setInitialInput] = useState('');
  const [runningId, setRunningId] = useState<string | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [outputs, setOutputs] = useState<string[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [streamKey, setStreamKey] = useState(0);
  type StreamInput = {
    node: string;
    request: { model: string; messages: Array<{ role: string; content: string }> };
  };
  const [streamInput, setStreamInput] = useState<StreamInput | null>(null);

  function buildStageRequest(stage: Stage, userContent: string): StreamInput {
    const messages: Array<{ role: string; content: string }> = [];
    if (stage.systemPrompt.trim()) {
      messages.push({ role: 'system', content: stage.systemPrompt });
    }
    messages.push({ role: 'user', content: userContent });
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

  function advance(activePipeline: Pipeline, finishedIdx: number, finalOutput: string): void {
    const nextIdx = finishedIdx + 1;
    if (nextIdx >= activePipeline.stages.length) {
      setRunningId(null);
      setStreamInput(null);
      return;
    }
    const nextStage = activePipeline.stages[nextIdx]!;
    setCurrentIdx(nextIdx);
    setOutputs((o) => [...o, '']);
    setStreamKey((k) => k + 1);
    setStreamInput(buildStageRequest(nextStage, finalOutput));
  }

  trpc.chatStream.useSubscription(
    streamInput ?? { node: 'local', request: { model: '', messages: [] } },
    {
      enabled: !!streamInput,
      key: streamKey,
      onData: (evt: unknown) => {
        if (!active || !runningId) return;
        const e = evt as {
          type?: string;
          chunk?: { choices?: [{ delta?: { content?: string } }] };
          error?: { message?: string };
        };
        if (e.type === 'chunk') {
          const piece = e.chunk?.choices?.[0]?.delta?.content ?? '';
          if (piece) {
            setOutputs((prev) => {
              const next = [...prev];
              next[currentIdx] = (next[currentIdx] ?? '') + piece;
              return next;
            });
          }
        } else if (e.type === 'error') {
          setRunError(e.error?.message ?? 'stream error');
          setRunningId(null);
          setStreamInput(null);
        } else if (e.type === 'done') {
          // Read the final output for this stage from state via a
          // functional set, then schedule the next stage.
          setOutputs((prev) => {
            const final = prev[currentIdx] ?? '';
            queueMicrotask(() => advance(active, currentIdx, final));
            return prev;
          });
        }
      },
      onError: (err: { message?: string }) => {
        setRunError(err.message ?? 'subscription error');
        setRunningId(null);
        setStreamInput(null);
      },
    } as Parameters<typeof trpc.chatStream.useSubscription>[1],
  );

  function run(): void {
    if (!active || active.stages.length === 0) return;
    const text = initialInput.trim();
    if (!text) return;
    setRunError(null);
    setOutputs(['']);
    setCurrentIdx(0);
    setRunningId(active.id);
    setStreamKey((k) => k + 1);
    const first = active.stages[0]!;
    setStreamInput(buildStageRequest(first, text));
  }

  function newPipeline(): void {
    const node = nodes[0]?.name ?? 'local';
    store.create({ node, model: '' });
  }

  function addStage(): void {
    if (!active) return;
    const last = active.stages[active.stages.length - 1];
    store.addStage(active.id, {
      id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`,
      node: last?.node ?? nodes[0]?.name ?? 'local',
      model: last?.model ?? '',
      systemPrompt: '',
      capabilities: [],
    });
  }

  const pipelineList = useMemo(
    () => Object.values(store.pipelines).sort((a, b) => b.id.localeCompare(a.id)),
    [store.pipelines],
  );

  if (nodeList.isLoading) {
    return <div className="p-6 text-sm text-[color:var(--color-fg-muted)]">Loading…</div>;
  }

  return (
    <div className="flex h-full" data-testid="pipelines-root">
      <h1 className="sr-only">Pipelines</h1>
      <Sidebar
        activeId={store.activeId}
        pipelines={pipelineList}
        onSelect={store.setActive}
        onNew={newPipeline}
        onDelete={store.remove}
      />
      {active ? (
        <div className="flex h-full flex-1 flex-col">
          <header className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-2 text-xs">
            <input
              value={active.name}
              onChange={(e) => store.rename(active.id, e.target.value)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-sm text-[color:var(--color-fg)]"
            />
            <span className="ml-2 text-[color:var(--color-fg-muted)]">
              {active.stages.length} stage{active.stages.length === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              onClick={addStage}
              className="ml-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-fg)]"
            >
              + Add stage
            </button>
          </header>
          <div className="flex flex-1 flex-col gap-3 overflow-auto bg-[var(--color-surface-0)] p-6">
            {runError && (
              <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[color:var(--color-danger)]">
                {runError}
              </div>
            )}
            {active.stages.map((stage, idx) => (
              <StageCard
                key={stage.id}
                stage={stage}
                index={idx}
                output={outputs[idx] ?? ''}
                running={runningId === active.id && currentIdx === idx}
                nodes={nodes}
                onUpdate={(patch) => store.updateStage(active.id, stage.id, patch)}
                onToggleCapability={(tag) => store.toggleStageCapability(active.id, stage.id, tag)}
                onRemove={() => store.removeStage(active.id, stage.id)}
              />
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run();
            }}
            className="flex gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
          >
            <textarea
              value={initialInput}
              onChange={(e) => setInitialInput(e.target.value)}
              placeholder="Initial input for stage 1…"
              className="h-16 flex-1 resize-none rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[color:var(--color-fg)]"
            />
            <button
              type="submit"
              disabled={runningId !== null || !initialInput.trim() || active.stages.length === 0}
              className="rounded border border-[var(--color-border)] bg-[var(--color-accent)] px-4 text-sm text-[color:var(--color-fg-inverted)] disabled:opacity-50"
            >
              {runningId === active.id ? `Stage ${currentIdx + 1}/${active.stages.length}…` : 'Run'}
            </button>
          </form>
        </div>
      ) : (
        <div
          className="flex h-full flex-1 items-center justify-center p-8"
          data-testid="pipelines-empty"
        >
          <div className="max-w-md space-y-3 text-center">
            <h2 className="text-lg font-semibold text-[color:var(--color-fg)]">
              Chain model calls into a pipeline
            </h2>
            <p className="text-sm text-[color:var(--color-fg-muted)]">
              Each stage consumes the previous stage's final assistant
              message. Useful for summarise → review → rewrite, vision-caption
              → reasoning, cheap-draft → cloud-polish.
            </p>
            <button
              type="button"
              onClick={newPipeline}
              data-testid="pipelines-new"
              className="rounded border border-[var(--color-border)] bg-[var(--color-accent)] px-4 py-2 text-sm text-[color:var(--color-fg-inverted)]"
            >
              New pipeline
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
