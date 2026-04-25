import * as React from 'react';
import { useMemo, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { trpc } from '@/lib/trpc';
import { Badge, Button, StatusDot, Input, Kbd } from '@/ui';

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
    <aside style={{ display: 'flex', height: '100%', width: 240, flexShrink: 0, flexDirection: 'column', borderRight: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--color-border)', borderColor: 'var(--color-border)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8 }}>
        <span style={{ textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-secondary)', fontSize: 12 }}>
          Pipelines
        </span>
        <Button variant="secondary" size="sm"
          type="button"
          onClick={props.onNew}
          
        >
          + New
        </Button>
      </div>
      <ul style={{ flex: 1, overflow: 'auto' }}>
        {props.pipelines.length === 0 && (
          <li style={{ padding: 12, color: 'var(--color-text-secondary)', fontSize: 12 }}>
            No pipelines yet.
          </li>
        )}
        {props.pipelines.map((p) => (
          <li
            key={p.id}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderBottom: '1px solid var(--color-border)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontSize: 12, ...(p.id === props.activeId ? { background: 'var(--color-surface-2)' } : {}) }}
          >
            <Button
              type="button"
              onClick={() => props.onSelect(p.id)}
              style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', color: 'var(--color-text)' }}
            >
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, color: 'var(--color-text-secondary)' }}>
                {p.stages.length} stage{p.stages.length === 1 ? '' : 's'}
              </div>
            </Button>
            <Button
              type="button"
              onClick={() => props.onDelete(p.id)}
              style={{ color: 'var(--color-text-secondary)' }}
              title="delete pipeline"
            >
              ×
            </Button>
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
    <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--color-border)', borderColor: 'var(--color-border)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontSize: 12 }}>
        <span style={{ borderRadius: 'var(--r-md)', background: 'var(--color-surface-2)', paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-secondary)' }}>
          #{props.index + 1}
        </span>
        <span style={{ color: 'var(--color-text-secondary)' }}>node</span>
        <select
          value={props.stage.node}
          onChange={(e) => props.onUpdate({ node: e.target.value })}
          style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text)' }}
        >
          {props.nodes.map((n) => (
            <option key={n.name} value={n.name}>
              {n.name}
            </option>
          ))}
        </select>
        <span style={{ marginLeft: 8, color: 'var(--color-text-secondary)' }}>model</span>
        <select
          value={props.stage.model}
          onChange={(e) => props.onUpdate({ model: e.target.value })}
          style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text)' }}
        >
          {models.length === 0 && <option value={props.stage.model}>{props.stage.model || '(none)'}</option>}
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <Button variant="secondary" size="sm"
          type="button"
          onClick={props.onRemove}
          
          title="remove stage"
        >
          × remove
        </Button>
      </header>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12 }}>
        <textarea
          value={props.stage.systemPrompt}
          onChange={(e) => props.onUpdate({ systemPrompt: e.target.value })}
          placeholder="System prompt (optional)…"
          style={{ height: 64, resize: 'none', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-text)', fontSize: 14 }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, fontSize: 10 }}>
          <span style={{ color: 'var(--color-text-secondary)' }}>capabilities:</span>
          {CAPABILITY_TAGS.map((tag) => {
            const active = props.stage.capabilities.includes(tag);
            return (
              <Button
                key={tag}
                type="button"
                onClick={() => props.onToggleCapability(tag)}
                style={{ borderRadius: 9999, border: '1px solid', paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2, fontFamily: 'var(--font-mono)', transitionProperty: 'color, background-color, border-color, text-decoration-color, fill, stroke', transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)', transitionDuration: '150ms', ...(active ? { borderColor: 'var(--color-brand)', background: 'var(--color-brand)', color: 'var(--color-brand-contrast)' } : { borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', color: 'var(--color-text-secondary)' }) }}
              >
                {tag.replace('_', '-')}
              </Button>
            );
          })}
        </div>
        <div
          style={{ minHeight: '3rem', whiteSpace: 'pre-wrap', borderRadius: 4, border: '1px dashed var(--color-border)', backgroundColor: 'var(--color-surface-0)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontSize: 12, ...(props.output ? { color: 'var(--color-text)' } : { color: 'var(--color-text-secondary)' }) }}
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
  const [exportInfo, setExportInfo] = useState<
    | { kind: 'ok'; path: string; toolName: string }
    | { kind: 'error'; message: string }
    | null
  >(null);
  const [streamKey, setStreamKey] = useState(0);
  const exportMcp = trpc.pipelineExportMcp.useMutation({
    onSuccess: (res) => {
      if (res.ok) {
        setExportInfo({ kind: 'ok', path: res.path, toolName: res.toolName });
      } else {
        setExportInfo({ kind: 'error', message: res.message });
      }
    },
    onError: (err) => setExportInfo({ kind: 'error', message: err.message }),
  });

  function exportActiveAsMcp(overwrite: boolean): void {
    if (!active) return;
    if (active.stages.length === 0) {
      setExportInfo({
        kind: 'error',
        message: 'Pipeline has no stages — add at least one before saving as a tool.',
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
  }
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
    return (
      <div style={{ height: '100%' }} data-testid="knowledge-pipelines-root">
        <div style={{ padding: 24, color: 'var(--color-text-secondary)', fontSize: 14 }}>Loading…</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%' }} data-testid="knowledge-pipelines-root">
      <h1 style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', borderWidth: 0 }}>Pipelines</h1>
      <Sidebar
        activeId={store.activeId}
        pipelines={pipelineList}
        onSelect={store.setActive}
        onNew={newPipeline}
        onDelete={store.remove}
      />
      {active ? (
        <div style={{ display: 'flex', height: '100%', flex: 1, flexDirection: 'column' }}>
          <header style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', paddingLeft: 16, paddingRight: 16, paddingTop: 8, paddingBottom: 8, fontSize: 12 }}>
            <Input
              value={active.name}
              onChange={(e) => store.rename(active.id, e.target.value)}
              style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2, color: 'var(--color-text)', fontSize: 14 }}
            />
            <span style={{ marginLeft: 8, color: 'var(--color-text-secondary)' }}>
              {active.stages.length} stage{active.stages.length === 1 ? '' : 's'}
            </span>
            <Button variant="secondary" size="sm"
              type="button"
              onClick={addStage}
              data-testid="pipelines-add-stage"
              
            >
              + Add stage
            </Button>
            <Button
              type="button"
              onClick={() => exportActiveAsMcp(false)}
              disabled={exportMcp.isPending || active.stages.length === 0}
              data-testid="pipelines-save-mcp"
              title={
                active.stages.length === 0
                  ? 'Add a stage first'
                  : 'Emit ~/.llamactl/mcp/pipelines/<slug>.json so @llamactl/mcp mounts this as a tool.'
              }
              style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2, fontSize: 10, color: 'var(--color-text)', cursor: 'not-allowed', opacity: 0.5 }}
            >
              {exportMcp.isPending ? 'Saving…' : '⇪ Save as MCP tool'}
            </Button>
          </header>
          {exportInfo && (
            <div
              data-testid="pipelines-save-mcp-result"
              style={{ ...( exportInfo.kind === 'ok' ? { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', paddingLeft: 16, paddingRight: 16, paddingTop: 4, paddingBottom: 4, fontSize: 11, color: 'var(--color-ok)' } : { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', paddingLeft: 16, paddingRight: 16, paddingTop: 4, paddingBottom: 4, fontSize: 11, color: 'var(--color-err)' } ) }}
            >
              {exportInfo.kind === 'ok' ? (
                <span>
                  Saved <span style={{ fontFamily: 'var(--font-mono)' }}>{exportInfo.toolName}</span>{' '}
                  → <span style={{ fontFamily: 'var(--font-mono)' }}>{exportInfo.path}</span>
                </span>
              ) : (
                <span>{exportInfo.message}</span>
              )}
              {exportInfo.kind === 'error' &&
              /already exists/i.test(exportInfo.message) ? (
                <Button
                  type="button"
                  onClick={() => exportActiveAsMcp(true)}
                  style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2, fontSize: 10, color: 'var(--color-text-secondary)' }}
                >
                  Overwrite
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={() => setExportInfo(null)}
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  ×
                </Button>
              )}
            </div>
          )}
          <div style={{ display: 'flex', flex: 1, flexDirection: 'column', gap: 12, overflow: 'auto', background: 'var(--color-surface-0)', padding: 24 }}>
            {runError && (
              <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-err)', background: 'var(--color-surface-1)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-err)', fontSize: 14 }}>
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
            style={{ display: 'flex', gap: 8, borderTop: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 12 }}
          >
            <textarea
              value={initialInput}
              onChange={(e) => setInitialInput(e.target.value)}
              placeholder="Initial input for stage 1…"
              style={{ height: 64, flex: 1, resize: 'none', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-text)', fontSize: 14 }}
            />
            <Button variant="primary" size="sm"
              type="submit"
              disabled={runningId !== null || !initialInput.trim() || active.stages.length === 0}
              
            >
              {runningId === active.id ? `Stage ${currentIdx + 1}/${active.stages.length}…` : 'Run'}
            </Button>
          </form>
        </div>
      ) : (
        <div
          style={{ display: 'flex', height: '100%', flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}
          data-testid="pipelines-empty"
        >
          <div style={{ maxWidth: 448, marginTop: 12, textAlign: 'center' }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-text)' }}>
              Chain model calls into a pipeline
            </h2>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: 14 }}>
              Each stage consumes the previous stage's final assistant
              message. Useful for summarise → review → rewrite, vision-caption
              → reasoning, cheap-draft → cloud-polish.
            </p>
            <Button variant="primary" size="sm"
              type="button"
              onClick={newPipeline}
              data-testid="pipelines-new"
              
            >
              New pipeline
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
