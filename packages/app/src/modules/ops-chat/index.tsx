import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';

/**
 * N.4 — Operator Console. A chat surface that doesn't just produce
 * plans; it executes them. Each planner step renders an approval
 * card tiered by mutation risk:
 *   - read           → auto-run on request; result streams below
 *   - mutation-dry-run-safe → Preview (dry) → Run (wet) two-step
 *   - mutation-destructive  → type the tool name to unlock wet-run
 *
 * Backed by router.operatorRunTool (see packages/remote/src/ops-chat).
 * Every call writes one audit entry to ~/.llamactl/ops-chat/audit.jsonl.
 *
 * The Plan module (N.4.5) produces plans and records intent; this
 * module produces plans AND runs them against the live MCP surface
 * — they sit side-by-side in the activity bar so operators pick the
 * flavor that matches their risk appetite for the task at hand.
 */

type PlanStep = {
  tool: string;
  args?: Record<string, unknown>;
  dryRun?: boolean;
  annotation: string;
};

type PlanResult =
  | {
      ok: true;
      plan: {
        steps: PlanStep[];
        reasoning: string;
        requiresConfirmation: boolean;
      };
      executor: string;
      toolsAvailable: string[];
    }
  | {
      ok: false;
      reason: string;
      message: string;
      executor?: string;
      disallowedTools?: string[];
    };

type ToolTier = 'read' | 'mutation-dry-run-safe' | 'mutation-destructive' | 'unknown';

interface ToolCallOutcome {
  ok: boolean;
  name: string;
  tier: ToolTier;
  durationMs: number;
  result?: unknown;
  error?: { code: string; message: string };
}

type StepState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'preview'; outcome: ToolCallOutcome }
  | { kind: 'done'; outcome: ToolCallOutcome }
  | { kind: 'failed'; outcome: ToolCallOutcome };

type Turn =
  | { id: number; role: 'user'; text: string }
  | {
      id: number;
      role: 'assistant';
      result: PlanResult;
      /** Per-step state keyed by step index. */
      steps: Record<number, StepState>;
      /** Per-step "typed to confirm" scratch for destructive tools. */
      confirmText: Record<number, string>;
    };

type Mode = 'stub' | 'llm';

const DEFAULT_CATALOG: Array<{
  name: string;
  description: string;
  tier: 'read' | 'mutation-dry-run-safe' | 'mutation-destructive';
}> = [
  {
    name: 'llamactl.catalog.list',
    description: 'List curated models on the control plane.',
    tier: 'read',
  },
  {
    name: 'llamactl.node.ls',
    description: 'List every cluster node.',
    tier: 'read',
  },
  {
    name: 'llamactl.bench.compare',
    description: 'Joined catalog + bench comparison table.',
    tier: 'read',
  },
  {
    name: 'llamactl.bench.history',
    description: 'Recent bench runs.',
    tier: 'read',
  },
  {
    name: 'llamactl.server.status',
    description: 'llama-server lifecycle status.',
    tier: 'read',
  },
  {
    name: 'llamactl.workload.list',
    description: 'Declarative ModelRun manifests.',
    tier: 'read',
  },
  {
    name: 'llamactl.promotions.list',
    description: 'Current preset promotions.',
    tier: 'read',
  },
  {
    name: 'llamactl.env',
    description: 'Environment snapshot.',
    tier: 'read',
  },
  {
    name: 'llamactl.cost.snapshot',
    description: 'Rolled-up spend for the last N days.',
    tier: 'read',
  },
  {
    name: 'llamactl.catalog.promote',
    description: 'Promote a model to a preset on a profile.',
    tier: 'mutation-dry-run-safe',
  },
  {
    name: 'llamactl.catalog.promoteDelete',
    description: 'Remove a preset promotion.',
    tier: 'mutation-destructive',
  },
  {
    name: 'llamactl.workload.delete',
    description: 'Remove a ModelRun manifest.',
    tier: 'mutation-destructive',
  },
  {
    name: 'llamactl.node.remove',
    description: 'Remove a node from the cluster.',
    tier: 'mutation-destructive',
  },
];

function summarizeResult(result: PlanResult): string {
  if (!result.ok) return `planner failed: ${result.reason} — ${result.message}`;
  return result.plan.steps
    .map((s, i) => `${i + 1}. ${s.tool} — ${s.annotation}`)
    .join('\n');
}

function tierClass(tier: ToolTier): string {
  switch (tier) {
    case 'mutation-destructive':
      return 'border-[var(--color-danger)] text-[color:var(--color-danger)]';
    case 'mutation-dry-run-safe':
      return 'border-[var(--color-warning,var(--color-accent))] text-[color:var(--color-warning,var(--color-accent))]';
    case 'read':
      return 'border-[var(--color-border)] text-[color:var(--color-fg-muted)]';
    default:
      return 'border-[var(--color-border)] text-[color:var(--color-fg-muted)]';
  }
}

function StepCard(props: {
  index: number;
  step: PlanStep;
  state: StepState;
  tier: ToolTier;
  confirmText: string;
  onConfirmText: (v: string) => void;
  onRun: (dryRun: boolean) => void;
}): React.JSX.Element {
  const { index, step, state, tier, confirmText, onConfirmText, onRun } = props;
  const destructiveReady =
    tier === 'mutation-destructive' ? confirmText.trim() === step.tool : true;
  const running = state.kind === 'running';
  const haveResult = state.kind === 'done' || state.kind === 'failed' || state.kind === 'preview';
  const outcome = haveResult ? (state.outcome as ToolCallOutcome) : null;

  return (
    <div
      className={`rounded border p-2 space-y-1 bg-[color:var(--color-surface-1)] ${tierClass(tier)}`}
      data-testid={`ops-chat-step-${index}`}
      data-tier={tier}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-[color:var(--color-fg-muted)]">{index + 1}.</span>
        <span className="font-mono text-sm text-[color:var(--color-fg)]">{step.tool}</span>
        <span
          className={`rounded border px-1 text-[10px] ${tierClass(tier)}`}
          data-testid={`ops-chat-step-${index}-tier`}
        >
          {tier}
        </span>
      </div>
      <div className="text-xs text-[color:var(--color-fg-muted)]">{step.annotation}</div>
      {step.args && Object.keys(step.args).length > 0 && (
        <pre className="text-[11px] bg-[var(--color-surface-2)] rounded p-1 overflow-auto">
          {JSON.stringify(step.args, null, 2)}
        </pre>
      )}

      {tier === 'mutation-destructive' && state.kind !== 'done' && (
        <label className="flex items-center gap-1 text-[10px] text-[color:var(--color-fg-muted)]">
          Type <span className="font-mono">{step.tool}</span> to unlock:
          <input
            type="text"
            value={confirmText}
            onChange={(e) => onConfirmText(e.target.value)}
            data-testid={`ops-chat-step-${index}-confirm`}
            className="w-48 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 py-0.5 font-mono text-[10px]"
          />
        </label>
      )}

      <div className="flex items-center gap-1 pt-1">
        {tier !== 'read' && state.kind !== 'done' && (
          <button
            type="button"
            onClick={() => onRun(true)}
            disabled={running}
            data-testid={`ops-chat-step-${index}-preview`}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-fg-muted)] disabled:opacity-50"
          >
            {running && state.kind === 'running' ? 'Running…' : 'Preview (dry)'}
          </button>
        )}
        <button
          type="button"
          onClick={() => onRun(false)}
          disabled={running || (tier === 'mutation-destructive' && !destructiveReady)}
          data-testid={`ops-chat-step-${index}-run`}
          className={
            tier === 'mutation-destructive'
              ? 'rounded border border-[var(--color-danger)] px-2 py-0.5 text-[10px] text-[color:var(--color-danger)] disabled:opacity-40'
              : tier === 'mutation-dry-run-safe'
                ? 'rounded border border-[var(--color-accent)] px-2 py-0.5 text-[10px] text-[color:var(--color-accent)] disabled:opacity-40'
                : 'rounded border border-[var(--color-border)] bg-[var(--color-accent)] px-2 py-0.5 text-[10px] text-[color:var(--color-fg-inverted)] disabled:opacity-40'
          }
        >
          {state.kind === 'done'
            ? 'Done ✓'
            : running
              ? 'Running…'
              : tier === 'read'
                ? 'Run'
                : 'Run (wet)'}
        </button>
      </div>

      {outcome && (
        <div
          className="mt-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 text-[11px]"
          data-testid={`ops-chat-step-${index}-result`}
          data-ok={outcome.ok ? 'true' : 'false'}
        >
          <div className="text-[color:var(--color-fg-muted)]">
            {outcome.ok ? '✓ ok' : '✗ failed'} · {outcome.durationMs}ms
            {state.kind === 'preview' ? ' · dry-run' : ''}
          </div>
          {outcome.ok ? (
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono">
              {JSON.stringify(outcome.result, null, 2).slice(0, 2000)}
            </pre>
          ) : (
            <div className="text-[color:var(--color-danger)]">
              {outcome.error?.code}: {outcome.error?.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function OpsChat(): React.JSX.Element {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<Mode>('stub');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [apiKeyEnv, setApiKeyEnv] = useState('OPENAI_API_KEY');
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const plan = trpc.operatorPlan.useMutation({
    onSuccess: (res) => {
      setTurns((prev) => [
        ...prev,
        {
          id: nextId.current++,
          role: 'assistant',
          result: res as PlanResult,
          steps: {},
          confirmText: {},
        },
      ]);
      setError(null);
    },
    onError: (err) => {
      setTurns((prev) => [
        ...prev,
        {
          id: nextId.current++,
          role: 'assistant',
          result: { ok: false, reason: 'transport', message: err.message },
          steps: {},
          confirmText: {},
        },
      ]);
      setError(err.message);
    },
  });

  const runTool = trpc.operatorRunTool.useMutation();
  const auditTail = trpc.opsChatAuditTail.useQuery(
    { limit: 50 },
    { refetchInterval: 5_000, staleTime: 1_000 },
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const history = useMemo(
    () =>
      turns.map((turn) =>
        turn.role === 'user'
          ? { role: 'user' as const, text: turn.text }
          : { role: 'assistant' as const, text: summarizeResult(turn.result) },
      ),
    [turns],
  );

  const onSubmit = (): void => {
    const goal = draft.trim();
    if (!goal || plan.isPending) return;
    setError(null);
    const userTurn: Turn = { id: nextId.current++, role: 'user', text: goal };
    setTurns((prev) => [...prev, userTurn]);
    setDraft('');
    plan.mutate({
      goal,
      mode,
      tools: DEFAULT_CATALOG,
      history,
      ...(mode === 'llm'
        ? {
            model: model.trim() || 'gpt-4o-mini',
            baseUrl: baseUrl.trim() || undefined,
            apiKeyEnv: apiKeyEnv.trim() || undefined,
          }
        : {}),
    });
  };

  const onReset = (): void => {
    setTurns([]);
    setDraft('');
    setError(null);
    nextId.current = 1;
  };

  function refreshAudit(): void {
    void auditTail.refetch();
  }

  async function runStep(turnId: number, stepIndex: number, dryRun: boolean): Promise<void> {
    const turn = turns.find((t) => t.id === turnId);
    if (!turn || turn.role !== 'assistant' || !turn.result.ok) return;
    const step = turn.result.plan.steps[stepIndex];
    if (!step) return;
    setTurns((prev) =>
      prev.map((t) =>
        t.id === turnId && t.role === 'assistant'
          ? { ...t, steps: { ...t.steps, [stepIndex]: { kind: 'running' } } }
          : t,
      ),
    );
    try {
      const outcome = (await runTool.mutateAsync({
        name: step.tool,
        arguments: (step.args ?? {}) as Record<string, unknown>,
        dryRun,
      })) as ToolCallOutcome;
      refreshAudit();
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turnId && t.role === 'assistant'
            ? {
                ...t,
                steps: {
                  ...t.steps,
                  [stepIndex]: outcome.ok
                    ? dryRun
                      ? { kind: 'preview', outcome }
                      : { kind: 'done', outcome }
                    : { kind: 'failed', outcome },
                },
              }
            : t,
        ),
      );
    } catch (err) {
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turnId && t.role === 'assistant'
            ? {
                ...t,
                steps: {
                  ...t.steps,
                  [stepIndex]: {
                    kind: 'failed',
                    outcome: {
                      ok: false,
                      name: step.tool,
                      tier: 'unknown',
                      durationMs: 0,
                      error: { code: 'transport', message: (err as Error).message },
                    },
                  },
                },
              }
            : t,
        ),
      );
      refreshAudit();
    }
  }

  function setConfirmText(turnId: number, stepIndex: number, v: string): void {
    setTurns((prev) =>
      prev.map((t) =>
        t.id === turnId && t.role === 'assistant'
          ? { ...t, confirmText: { ...t.confirmText, [stepIndex]: v } }
          : t,
      ),
    );
  }

  function tierFor(toolName: string): ToolTier {
    const match = DEFAULT_CATALOG.find((t) => t.name === toolName);
    return (match?.tier ?? 'unknown') as ToolTier;
  }

  const submitDisabled = plan.isPending || draft.trim().length === 0;

  return (
    <div className="flex h-full flex-col" data-testid="ops-chat-root">
      <div className="border-b border-[color:var(--color-border)] p-4 space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">Operator Console</h2>
            <p className="text-xs text-[color:var(--color-fg-muted)] max-w-prose">
              Natural-language goals become MCP tool calls. Reads run with one
              click; mutations preview dry-first; destructive actions require
              the operator to type the tool name to confirm. Every attempt —
              dry, wet, successful, failed — appends one entry to
              {auditTail.data?.path ? (
                <span className="font-mono"> {auditTail.data.path}</span>
              ) : (
                <span> the ops-chat audit journal</span>
              )}
              .
            </p>
          </div>
          {turns.length > 0 && (
            <button
              type="button"
              onClick={onReset}
              data-testid="ops-chat-reset"
              className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)] px-3 py-1 text-xs text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
            >
              New conversation
            </button>
          )}
        </div>
        <div className="flex items-center gap-2" role="radiogroup" aria-label="Planner mode">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'stub'}
            data-testid="ops-chat-mode-stub"
            onClick={() => setMode('stub')}
            className={
              mode === 'stub'
                ? 'rounded border border-[var(--color-accent)] bg-[var(--color-surface-2)] px-3 py-1 text-xs font-medium text-[color:var(--color-fg)]'
                : 'rounded border border-transparent px-3 py-1 text-xs text-[color:var(--color-fg-muted)] hover:bg-[var(--color-surface-2)]'
            }
          >
            Stub
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'llm'}
            data-testid="ops-chat-mode-llm"
            onClick={() => setMode('llm')}
            className={
              mode === 'llm'
                ? 'rounded border border-[var(--color-accent)] bg-[var(--color-surface-2)] px-3 py-1 text-xs font-medium text-[color:var(--color-fg)]'
                : 'rounded border border-transparent px-3 py-1 text-xs text-[color:var(--color-fg-muted)] hover:bg-[var(--color-surface-2)]'
            }
          >
            LLM
          </button>
          {mode === 'llm' && (
            <>
              <input
                type="text"
                placeholder="gpt-4o-mini"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                data-testid="ops-chat-model"
                className="text-xs rounded border border-[color:var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 w-40"
              />
              <input
                type="text"
                placeholder="https://api.openai.com/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="text-xs rounded border border-[color:var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 w-60"
              />
              <input
                type="text"
                placeholder="OPENAI_API_KEY"
                value={apiKeyEnv}
                onChange={(e) => setApiKeyEnv(e.target.value)}
                className="text-xs rounded border border-[color:var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 w-40"
              />
            </>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-auto p-4 space-y-3"
        data-testid="ops-chat-transcript"
      >
        {turns.length === 0 && (
          <div
            className="rounded-md border border-dashed border-[color:var(--color-border)] p-6 text-sm text-[color:var(--color-fg-muted)]"
            data-testid="ops-chat-empty"
          >
            <h3 className="text-sm font-semibold text-[color:var(--color-fg)]">
              Drive the fleet by describing the goal
            </h3>
            <p className="mt-1 text-xs">
              Example:{' '}
              <span className="font-mono">list installed vision models</span>
              . The planner returns a step-by-step plan; each step is a tool
              call you approve individually.
            </p>
          </div>
        )}
        {turns.map((turn) => {
          if (turn.role === 'user') {
            return (
              <div key={turn.id} className="flex justify-end">
                <div className="max-w-[70%] rounded-2xl bg-[color:var(--color-accent)] px-3 py-2 text-sm text-[color:var(--color-fg-inverted)] whitespace-pre-wrap">
                  {turn.text}
                </div>
              </div>
            );
          }
          if (!turn.result.ok) {
            return (
              <div
                key={turn.id}
                className="rounded border border-[color:var(--color-warning,var(--color-accent))] p-3 text-sm space-y-1 bg-[color:var(--color-surface-1)]"
                data-testid={`ops-chat-turn-${turn.id}-failure`}
              >
                <div className="font-medium">Planner failed: {turn.result.reason}</div>
                <div className="text-xs text-[color:var(--color-fg-muted)]">
                  {turn.result.message}
                </div>
              </div>
            );
          }
          const steps = turn.result.plan.steps;
          return (
            <div
              key={turn.id}
              className="rounded border border-[color:var(--color-border)] p-3 space-y-2 bg-[color:var(--color-surface-1)]"
              data-testid={`ops-chat-turn-${turn.id}`}
            >
              <div className="flex items-center justify-between text-xs">
                <div className="font-medium">Plan</div>
                <div className="text-[color:var(--color-fg-muted)]">
                  executor={turn.result.executor} · {steps.length} step
                  {steps.length === 1 ? '' : 's'}
                </div>
              </div>
              <div className="text-xs text-[color:var(--color-fg-muted)]">
                {turn.result.plan.reasoning}
              </div>
              <div className="space-y-2 mt-1">
                {steps.map((step, i) => (
                  <StepCard
                    key={i}
                    index={i}
                    step={step}
                    tier={tierFor(step.tool)}
                    state={turn.steps[i] ?? { kind: 'idle' }}
                    confirmText={turn.confirmText[i] ?? ''}
                    onConfirmText={(v) => setConfirmText(turn.id, i, v)}
                    onRun={(dryRun) => void runStep(turn.id, i, dryRun)}
                  />
                ))}
              </div>
            </div>
          );
        })}
        {plan.isPending && (
          <div className="flex justify-start" data-testid="ops-chat-pending">
            <div className="rounded-2xl bg-[color:var(--color-surface-2)] px-3 py-2 text-xs text-[color:var(--color-fg-muted)]">
              Planning…
            </div>
          </div>
        )}
        {error && (
          <div
            className="rounded border border-[color:var(--color-danger)] bg-[color:var(--color-surface-1)] p-2 text-xs text-[color:var(--color-danger)]"
            data-testid="ops-chat-error"
          >
            {error}
          </div>
        )}
      </div>

      <details
        className="border-t border-[color:var(--color-border)] bg-[color:var(--color-surface-1)] px-4 py-2 text-xs"
        data-testid="ops-chat-audit-details"
      >
        <summary className="cursor-pointer text-[color:var(--color-fg-muted)]">
          Audit ({auditTail.data?.entries.length ?? 0})
        </summary>
        {auditTail.data?.entries.length ? (
          <ul
            className="mt-2 space-y-1 font-mono text-[10px]"
            data-testid="ops-chat-audit-list"
          >
            {auditTail.data.entries.slice(0, 20).map((entry, i) => (
              <li
                key={`${entry.ts}-${i}`}
                data-testid={`ops-chat-audit-entry-${i}`}
                className="flex items-center gap-2 text-[color:var(--color-fg-muted)]"
              >
                <span>{entry.ts.slice(11, 19)}</span>
                <span
                  className={
                    entry.ok
                      ? 'text-[color:var(--color-success)]'
                      : 'text-[color:var(--color-danger)]'
                  }
                >
                  {entry.ok ? '✓' : '✗'}
                </span>
                <span className="text-[color:var(--color-fg)]">{entry.tool}</span>
                {entry.dryRun && (
                  <span className="rounded bg-[color:var(--color-surface-2)] px-1 text-[9px]">
                    dry
                  </span>
                )}
                <span className="ml-auto">{entry.durationMs}ms</span>
                {!entry.ok && entry.errorCode && (
                  <span className="text-[color:var(--color-danger)]">
                    {entry.errorCode}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[color:var(--color-fg-muted)]">
            No audit entries yet — run a step to start populating{' '}
            {auditTail.data?.path ? (
              <span className="font-mono">{auditTail.data.path}</span>
            ) : (
              <span>the ops-chat audit journal</span>
            )}
            .
          </p>
        )}
      </details>

      <div className="border-t border-[color:var(--color-border)] p-3 space-y-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={2}
          placeholder={
            turns.length === 0
              ? 'e.g. list installed vision models'
              : 'Refine, or ask for the next step…'
          }
          className="w-full rounded border border-[color:var(--color-border)] bg-[var(--color-surface-2)] p-2 text-sm font-mono"
          data-testid="ops-chat-goal"
        />
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitDisabled}
            data-testid="ops-chat-submit"
            className="rounded border border-[color:var(--color-border)] bg-[var(--color-accent)] text-[color:var(--color-fg-inverted)] px-3 py-1 text-sm font-medium shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
          >
            {plan.isPending ? 'Planning…' : turns.length === 0 ? 'Plan' : 'Send'}
          </button>
          <span className="text-[10px] text-[color:var(--color-fg-muted)]">
            ⌘/Ctrl+Enter to send · {turns.length} turn{turns.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>
    </div>
  );
}
