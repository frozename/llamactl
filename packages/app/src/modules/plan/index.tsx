import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { useOpsExecutorStore } from '@/stores/ops-executor-store';
import { OpsExecutorPicker } from '@/modules/ops/ops-executor-picker';

/**
 * N.4.5 — operator-plan chat UI. Starts empty; each user message runs
 * the planner with the full prior turn history folded into the
 * context. The assistant's response is the resulting plan (or error),
 * rendered inline in the transcript. Approval is scoped to the latest
 * assistant turn. Execution stays CLI-side.
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
      rawPlan?: unknown;
    };

interface ToolCatalogEntry {
  name: string;
  description: string;
  tier: 'read' | 'mutation-dry-run-safe' | 'mutation-destructive';
}

const DEFAULT_CATALOG: ToolCatalogEntry[] = [
  {
    name: 'nova.ops.overview',
    description: 'Unified fleet snapshot — agents, gateways, providers.',
    tier: 'read',
  },
  {
    name: 'nova.ops.cost.snapshot',
    description: 'Rolled-up spend for the last N days.',
    tier: 'read',
  },
  {
    name: 'llamactl.catalog.list',
    description: 'List curated models on the target node.',
    tier: 'read',
  },
  {
    name: 'llamactl.catalog.promote',
    description: 'Promote a model to a preset on a node.',
    tier: 'mutation-dry-run-safe',
  },
  {
    name: 'llamactl.bench.compare',
    description: 'Compare benchmarked models by class + scope.',
    tier: 'read',
  },
  {
    name: 'llamactl.embersynth.sync',
    description: 'Regenerate embersynth.yaml from current state.',
    tier: 'mutation-dry-run-safe',
  },
  {
    name: 'llamactl.embersynth.set-default-profile',
    description: "Remap a synthetic model to a different profile.",
    tier: 'mutation-dry-run-safe',
  },
];

type Turn =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'assistant'; result: PlanResult };

function tierClass(tier: ToolCatalogEntry['tier']): string {
  switch (tier) {
    case 'mutation-destructive':
      return 'bg-[var(--color-err)] text-[color:var(--color-text-inverse)]';
    case 'mutation-dry-run-safe':
      return 'bg-[var(--color-warn,var(--color-ok))] text-[color:var(--color-text-inverse)]';
    default:
      return 'bg-[var(--color-surface-2)] text-[color:var(--color-text-secondary)]';
  }
}

/**
 * Compact textual summary of a PlanResult — fed back to the planner
 * as the assistant turn's content in subsequent requests. Keep it
 * terse: the LLM only needs to know what it already said, not the
 * full JSON structure.
 */
function summarizeResultForHistory(result: PlanResult): string {
  if (!result.ok) {
    return `planner failed: ${result.reason}${
      result.message ? ` — ${result.message}` : ''
    }`;
  }
  const steps = result.plan.steps
    .map((step, i) => `${i + 1}. ${step.tool} — ${step.annotation}`)
    .join('\n');
  return `proposed ${result.plan.steps.length} step plan:\n${steps}\n\nreasoning: ${result.plan.reasoning}`;
}

function PlanCard({
  result,
  onApprove,
  onReject,
  decision,
  isLatest,
}: {
  result: PlanResult;
  onApprove: () => void;
  onReject: () => void;
  decision: 'approved' | 'rejected' | null;
  isLatest: boolean;
}): React.JSX.Element {
  if (!result.ok) {
    return (
      <div
        className="rounded border border-[color:var(--color-warn,var(--color-ok))] p-3 text-sm space-y-1 bg-[color:var(--color-surface-1)]"
        data-testid="plan-failure"
      >
        <div className="font-medium">Planner failed: {result.reason}</div>
        <div className="text-xs text-[color:var(--color-text-secondary)]">{result.message}</div>
        {result.disallowedTools && result.disallowedTools.length > 0 && (
          <div className="text-xs">
            Disallowed tools: {result.disallowedTools.join(', ')}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className="rounded border border-[color:var(--color-border)] p-3 text-sm space-y-2 bg-[color:var(--color-surface-1)]"
      data-testid="plan-result"
    >
      <div className="flex items-center justify-between">
        <div className="font-medium">Plan</div>
        <div className="text-xs text-[color:var(--color-text-secondary)]">
          executor={result.executor} · {result.plan.steps.length} step
          {result.plan.steps.length === 1 ? '' : 's'}
        </div>
      </div>
      <div className="text-xs text-[color:var(--color-text-secondary)]">{result.plan.reasoning}</div>
      <ol className="space-y-2 mt-2 list-none pl-0" data-testid="plan-steps">
        {result.plan.steps.map((step, i) => (
          <li
            key={i}
            className="rounded border border-[color:var(--color-border)] p-2 space-y-1"
            data-testid={`plan-step-${i}`}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono">{i + 1}.</span>
              <span className="font-mono text-sm">{step.tool}</span>
              {step.dryRun && (
                <span className="rounded bg-[var(--color-surface-2)] px-1 text-[10px] uppercase">
                  dry-run
                </span>
              )}
            </div>
            <div className="text-xs text-[color:var(--color-text-secondary)]">{step.annotation}</div>
            {step.args && Object.keys(step.args).length > 0 && (
              <pre className="text-[11px] bg-[var(--color-surface-2)] rounded p-1 overflow-auto">
                {JSON.stringify(step.args, null, 2)}
              </pre>
            )}
          </li>
        ))}
      </ol>
      {isLatest && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onApprove}
            disabled={decision !== null}
            className="rounded border border-[color:var(--color-border)] bg-[var(--color-brand)] text-[color:var(--color-brand-contrast)] px-3 py-1 text-xs font-medium disabled:opacity-50"
            data-testid="plan-approve"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={onReject}
            disabled={decision !== null}
            className="rounded border border-[color:var(--color-border)] bg-[var(--color-err)] text-[color:var(--color-text-inverse)] px-3 py-1 text-xs font-medium disabled:opacity-50"
            data-testid="plan-reject"
          >
            Reject
          </button>
          {decision && (
            <span
              className={`text-xs ${
                decision === 'approved'
                  ? 'text-[color:var(--color-ok)]'
                  : 'text-[color:var(--color-err)]'
              }`}
              data-testid="plan-decision"
            >
              {decision === 'approved'
                ? 'Approved — run via llamactl plan run "<goal>" --auto'
                : 'Rejected — refine and resend'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default function Plan(): React.JSX.Element {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const { nodeId, model } = useOpsExecutorStore();
  const [catalog, setCatalog] = useState<ToolCatalogEntry[]>(DEFAULT_CATALOG);
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const plan = trpc.operatorPlan.useMutation({
    onSuccess: (res) => {
      setTurns((prev) => [...prev, { id: nextId.current++, role: 'assistant', result: res as PlanResult }]);
      setError(null);
      setDecision(null);
    },
    onError: (err) => {
      // Represent the tRPC-level error as an assistant turn too so the
      // transcript stays consistent.
      setTurns((prev) => [
        ...prev,
        {
          id: nextId.current++,
          role: 'assistant',
          result: { ok: false, reason: 'transport', message: err.message },
        },
      ]);
      setError(err.message);
    },
  });

  // Auto-scroll the transcript when a new turn lands.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length]);

  const history = useMemo(
    () =>
      turns.map((turn) =>
        turn.role === 'user'
          ? { role: 'user' as const, text: turn.text }
          : { role: 'assistant' as const, text: summarizeResultForHistory(turn.result) },
      ),
    [turns],
  );

  // Latest assistant turn — only card that can be approved/rejected.
  const latestAssistantId = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      if (turn && turn.role === 'assistant') return turn.id;
    }
    return null;
  }, [turns]);

  const onSubmit = (): void => {
    const goal = draft.trim();
    if (!goal || plan.isPending) return;
    if (!nodeId || !model) {
      setError('pick a node + model in the header first');
      return;
    }
    setError(null);
    setDecision(null);
    const userTurn: Turn = { id: nextId.current++, role: 'user', text: goal };
    setTurns((prev) => [...prev, userTurn]);
    setDraft('');
    plan.mutate({
      goal,
      nodeId,
      model,
      tools: catalog,
      history,
    });
  };

  const onReset = (): void => {
    setTurns([]);
    setDraft('');
    setDecision(null);
    setError(null);
    nextId.current = 1;
  };

  const submitDisabled = plan.isPending || draft.trim().length === 0;

  return (
    <div className="flex h-full flex-col" data-testid="plan-root">
      <div className="border-b border-[color:var(--color-border)] p-4 space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">Operator plan</h2>
            <p className="text-xs text-[color:var(--color-text-secondary)] max-w-prose">
              Describe an operational goal. Each reply is a validated plan you
              can approve or refine in a follow-up turn.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <OpsExecutorPicker />
            {turns.length > 0 && (
              <button
                type="button"
                onClick={onReset}
                data-testid="plan-reset"
                className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)] px-3 py-1 text-xs text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text)]"
              >
                New conversation
              </button>
            )}
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-auto p-4 space-y-3"
        data-testid="plan-transcript"
      >
        {turns.length === 0 && (
          <div
            className="rounded-md border border-dashed border-[color:var(--color-border)] p-6 text-sm text-[color:var(--color-text-secondary)]"
            data-testid="plan-empty"
          >
            <h3 className="text-sm font-semibold text-[color:var(--color-text)]">
              Start with a goal
            </h3>
            <p className="mt-1 text-xs">
              Example:{' '}
              <span className="font-mono">
                promote the fastest vision model on macbook-pro-48g
              </span>
              . The planner returns a step-by-step plan — you can then ask for
              refinements in the same conversation.
            </p>
          </div>
        )}
        {turns.map((turn) => {
          if (turn.role === 'user') {
            return (
              <div
                key={turn.id}
                className="flex justify-end"
                data-testid={`plan-turn-user-${turn.id}`}
              >
                <div className="max-w-[70%] rounded-2xl bg-[color:var(--color-ok)] px-3 py-2 text-sm text-[color:var(--color-text-inverse)] whitespace-pre-wrap">
                  {turn.text}
                </div>
              </div>
            );
          }
          return (
            <div
              key={turn.id}
              className="flex justify-start"
              data-testid={`plan-turn-assistant-${turn.id}`}
            >
              <div className="w-full max-w-[90%]">
                <PlanCard
                  result={turn.result}
                  onApprove={() => setDecision('approved')}
                  onReject={() => setDecision('rejected')}
                  decision={turn.id === latestAssistantId ? decision : null}
                  isLatest={turn.id === latestAssistantId}
                />
              </div>
            </div>
          );
        })}
        {plan.isPending && (
          <div
            className="flex justify-start"
            data-testid="plan-pending"
          >
            <div className="rounded-2xl bg-[color:var(--color-surface-2)] px-3 py-2 text-xs text-[color:var(--color-text-secondary)]">
              Planning…
            </div>
          </div>
        )}
        {error && (
          <div
            className="rounded border border-[color:var(--color-err)] bg-[color:var(--color-surface-1)] p-2 text-xs text-[color:var(--color-err)]"
            data-testid="plan-error"
          >
            {error}
          </div>
        )}
      </div>

      <div className="border-t border-[color:var(--color-border)] p-3 space-y-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter sends, plain Enter inserts a newline so
            // operators can type multi-line refinements without losing
            // draft state.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={3}
          placeholder={
            turns.length === 0
              ? 'e.g. promote the fastest vision model on macbook-pro-48g'
              : 'Refine: "change step 3 to target gpu1", "add a rollback", "why did you skip nova.ops.overview?"'
          }
          className="w-full rounded border border-[color:var(--color-border)] bg-[var(--color-surface-2)] p-2 text-sm font-mono"
          data-testid="plan-goal"
        />
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitDisabled}
            data-testid="plan-submit"
            title={submitDisabled ? 'Type a goal, then send' : 'Send (⌘/Ctrl+Enter)'}
            className="rounded border border-[color:var(--color-border)] bg-[var(--color-brand)] text-[color:var(--color-brand-contrast)] px-3 py-1 text-sm font-medium shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
          >
            {plan.isPending ? 'Planning…' : turns.length === 0 ? 'Generate plan' : 'Send'}
          </button>
          <span className="text-[10px] text-[color:var(--color-text-secondary)]">
            ⌘/Ctrl+Enter to send · {turns.length} turn{turns.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      <details className="border-t border-[color:var(--color-border)] px-4 py-2 text-xs">
        <summary className="cursor-pointer">Tool catalog ({catalog.length})</summary>
        <ul className="mt-2 space-y-1">
          {catalog.map((t) => (
            <li key={t.name} className="flex items-center gap-2">
              <span className={`px-1 rounded text-[10px] ${tierClass(t.tier)}`}>{t.tier}</span>
              <span className="font-mono">{t.name}</span>
              <span className="text-[color:var(--color-text-secondary)]">—</span>
              <span className="text-[color:var(--color-text-secondary)]">{t.description}</span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => setCatalog(DEFAULT_CATALOG)}
          className="mt-2 rounded border border-[color:var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[11px]"
          data-testid="plan-reset-catalog"
        >
          Reset to defaults
        </button>
      </details>
    </div>
  );
}
