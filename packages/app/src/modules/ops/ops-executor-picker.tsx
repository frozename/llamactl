import * as React from 'react';
import { useEffect, useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import { useOpsExecutorStore } from '@/stores/ops-executor-store';

/**
 * Shared node + model picker for the Ops Console. Mounted in the
 * Ops Chat and Planner module headers so both tabs share one
 * executor config via `useOpsExecutorStore`. Filters out nodes that
 * don't answer /v1/chat/completions (RAG-only bindings). The
 * planner router resolves the provider server-side via
 * `providerForNode`, so the UI never deals with raw baseUrl /
 * apiKeyEnv.
 */
export function OpsExecutorPicker(): React.JSX.Element {
  const { nodeId, model, setNode, setModel } = useOpsExecutorStore();
  const nodeList = trpc.nodeList.useQuery();

  type SelectorNode = { name: string; effectiveKind?: string };
  const nodes = useMemo<SelectorNode[]>(
    () =>
      ((nodeList.data?.nodes ?? []) as SelectorNode[]).filter(
        (n) => (n.effectiveKind ?? 'agent') !== 'rag',
      ),
    [nodeList.data],
  );

  const modelList = trpc.nodeModels.useQuery(
    { name: nodeId ?? 'local' },
    { enabled: !!nodeId, staleTime: 60_000 },
  );
  const models = useMemo(
    () =>
      (modelList.data?.models as Array<{ id?: string }> | undefined)
        ?.map((m) => m.id)
        .filter((id): id is string => typeof id === 'string') ?? [],
    [modelList.data],
  );

  // Auto-pick first model when we land on a node whose catalog
  // doesn't include the persisted choice (happens when the user
  // switches nodes, or the model was renamed upstream).
  useEffect(() => {
    if (!nodeId || models.length === 0) return;
    if (!model || !models.includes(model)) {
      setModel(models[0]!);
    }
  }, [nodeId, model, models, setModel]);

  // If the persisted node disappeared from the fleet (renamed /
  // removed), clear it so the picker falls back to empty-state.
  useEffect(() => {
    if (!nodeId) return;
    if (nodes.length === 0) return;
    if (!nodes.some((n) => n.name === nodeId)) setNode(null);
  }, [nodeId, nodes, setNode]);

  if (nodes.length === 0) {
    return (
      <span
        className="text-xs text-[color:var(--color-text-secondary)]"
        data-testid="ops-executor-empty"
      >
        no executable nodes — add one in Nodes
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <select
        value={nodeId ?? ''}
        onChange={(e) => setNode(e.target.value || null)}
        data-testid="ops-executor-node"
        className="rounded border border-[color:var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[color:var(--color-text)]"
      >
        <option value="">pick a node…</option>
        {nodes.map((n) => (
          <option key={n.name} value={n.name}>
            {n.name}
          </option>
        ))}
      </select>
      <select
        value={model ?? ''}
        onChange={(e) => setModel(e.target.value || null)}
        disabled={!nodeId || models.length === 0}
        data-testid="ops-executor-model"
        className="rounded border border-[color:var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[color:var(--color-text)] disabled:opacity-50"
      >
        {models.length === 0 && <option value="">…</option>}
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </div>
  );
}
