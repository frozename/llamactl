import * as React from 'react';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';

/**
 * N.4.5 — operator-plan UI. Takes a natural-language goal, dispatches
 * to the planner (stub or llm-backed executor), renders the validated
 * plan as a reviewable card list with per-step annotations.
 *
 * Execution remains out of scope for this slice — the renderer
 * approves/rejects the plan and records the operator's decision
 * locally; actual tool dispatch happens via the CLI (`llamactl plan
 * run` with --auto) or a follow-up slice.
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

/**
 * Sample tool catalog surfaced to the planner. Real deployments
 * populate this from the installed MCP servers; the renderer keeps
 * a minimal curated set so the default stub produces a plan the
 * operator can read without needing to wire a harness here.
 */
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

type Mode = 'stub' | 'llm';

function tierClass(tier: ToolCatalogEntry['tier']): string {
  switch (tier) {
    case 'mutation-destructive':
      return 'bg-[var(--color-danger)] text-[color:var(--color-fg-inverted)]';
    case 'mutation-dry-run-safe':
      return 'bg-[var(--color-warning,var(--color-accent))] text-[color:var(--color-fg-inverted)]';
    default:
      return 'bg-[var(--color-surface-2)] text-[color:var(--color-fg-muted)]';
  }
}

export default function Plan(): React.JSX.Element {
  const [goal, setGoal] = useState('');
  const [context, setContext] = useState('');
  const [mode, setMode] = useState<Mode>('stub');
  const [model, setModel] = useState('');
  const [apiKeyEnv, setApiKeyEnv] = useState('OPENAI_API_KEY');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [catalog, setCatalog] = useState<ToolCatalogEntry[]>(DEFAULT_CATALOG);
  const [result, setResult] = useState<PlanResult | null>(null);
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const plan = trpc.operatorPlan.useMutation({
    onSuccess: (res) => {
      setResult(res as PlanResult);
      setDecision(null);
      setError(null);
    },
    onError: (err) => {
      setResult(null);
      setError(err.message);
    },
  });

  const onSubmit = (): void => {
    setError(null);
    setResult(null);
    const payload = {
      goal: goal.trim(),
      context: context.trim() || undefined,
      mode,
      tools: catalog,
      ...(mode === 'llm'
        ? {
            model: model.trim() || 'gpt-4o-mini',
            baseUrl: baseUrl.trim() || undefined,
            apiKeyEnv: apiKeyEnv.trim() || undefined,
          }
        : {}),
    };
    plan.mutate(payload);
  };

  const disabled = plan.isPending || goal.trim().length === 0;

  return (
    <div
      className="flex h-full flex-col"
      data-testid="plan-root"
    >
      <div className="border-b border-[color:var(--color-border)] p-4 space-y-3">
        <h2 className="text-lg font-medium">Operator plan</h2>
        <p className="text-xs text-[color:var(--color-fg-muted)] max-w-prose">
          Translate a natural-language operational goal into a validated
          sequence of MCP tool calls. Stub mode produces a canned plan so
          you can review the shape without burning tokens; LLM mode
          drives a real OpenAI-compatible model. Approving a plan here
          records your intent — execution stays CLI-side.
        </p>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs">
            <input
              type="radio"
              checked={mode === 'stub'}
              onChange={() => setMode('stub')}
              data-testid="plan-mode-stub"
            />
            Stub
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input
              type="radio"
              checked={mode === 'llm'}
              onChange={() => setMode('llm')}
              data-testid="plan-mode-llm"
            />
            LLM
          </label>
          {mode === 'llm' && (
            <>
              <input
                type="text"
                placeholder="gpt-4o-mini"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="text-xs rounded border border-[color:var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 w-40"
                data-testid="plan-model"
              />
              <input
                type="text"
                placeholder="https://api.openai.com/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="text-xs rounded border border-[color:var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 w-60"
                data-testid="plan-base-url"
              />
              <input
                type="text"
                placeholder="OPENAI_API_KEY"
                value={apiKeyEnv}
                onChange={(e) => setApiKeyEnv(e.target.value)}
                className="text-xs rounded border border-[color:var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 w-40"
                data-testid="plan-api-key-env"
              />
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="space-y-2">
          <label className="block text-xs uppercase tracking-wide text-[color:var(--color-fg-muted)]">
            Goal
          </label>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={3}
            placeholder="e.g. promote the fastest vision model on macbook-pro-48g"
            className="w-full rounded border border-[color:var(--color-border)] bg-[var(--color-surface-2)] p-2 text-sm font-mono"
            data-testid="plan-goal"
          />
          <label className="block text-xs uppercase tracking-wide text-[color:var(--color-fg-muted)]">
            Context (optional)
          </label>
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            rows={2}
            placeholder="Compact fleet snapshot — paste from healer journal, nova.ops.overview, etc."
            className="w-full rounded border border-[color:var(--color-border)] bg-[var(--color-surface-2)] p-2 text-sm font-mono"
            data-testid="plan-context"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onSubmit}
              disabled={disabled}
              className="rounded border border-[color:var(--color-border)] bg-[var(--color-accent)] text-[color:var(--color-fg-inverted)] px-3 py-1 text-sm font-medium shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
              title={disabled && goal.trim().length === 0 ? 'Enter a goal above' : undefined}
              data-testid="plan-submit"
            >
              {plan.isPending ? 'Planning…' : 'Generate plan'}
            </button>
            {result?.ok && (
              <>
                <button
                  type="button"
                  onClick={() => setDecision('approved')}
                  disabled={decision !== null}
                  className="rounded border border-[color:var(--color-border)] bg-[var(--color-success)] text-[color:var(--color-fg-inverted)] px-3 py-1 text-sm disabled:opacity-50"
                  data-testid="plan-approve"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => setDecision('rejected')}
                  disabled={decision !== null}
                  className="rounded border border-[color:var(--color-border)] bg-[var(--color-danger)] text-[color:var(--color-fg-inverted)] px-3 py-1 text-sm disabled:opacity-50"
                  data-testid="plan-reject"
                >
                  Reject
                </button>
              </>
            )}
          </div>
          {decision && (
            <div
              className={`text-xs ${decision === 'approved' ? 'text-[color:var(--color-success)]' : 'text-[color:var(--color-danger)]'}`}
              data-testid="plan-decision"
            >
              {decision === 'approved'
                ? 'Plan approved. Run via: llamactl plan run "<goal>" --auto'
                : 'Plan rejected. Refine the goal + regenerate.'}
            </div>
          )}
        </div>

        {error && (
          <div
            className="rounded border border-[color:var(--color-danger)] bg-[var(--color-surface-2)] p-2 text-sm text-[color:var(--color-danger)]"
            data-testid="plan-error"
          >
            {error}
          </div>
        )}

        {result && !result.ok && (
          <div
            className="rounded border border-[color:var(--color-warning,var(--color-accent))] p-3 text-sm space-y-1"
            data-testid="plan-failure"
          >
            <div className="font-medium">Planner failed: {result.reason}</div>
            <div className="text-xs text-[color:var(--color-fg-muted)]">{result.message}</div>
            {result.disallowedTools && result.disallowedTools.length > 0 && (
              <div className="text-xs">
                Disallowed tools: {result.disallowedTools.join(', ')}
              </div>
            )}
          </div>
        )}

        {result?.ok && (
          <div
            className="rounded border border-[color:var(--color-border)] p-3 text-sm space-y-2"
            data-testid="plan-result"
          >
            <div className="flex items-center justify-between">
              <div className="font-medium">Plan</div>
              <div className="text-xs text-[color:var(--color-fg-muted)]">
                executor={result.executor} · {result.plan.steps.length} step
                {result.plan.steps.length === 1 ? '' : 's'}
              </div>
            </div>
            <div className="text-xs text-[color:var(--color-fg-muted)]">
              {result.plan.reasoning}
            </div>
            <ol
              className="space-y-2 mt-2 list-none pl-0"
              data-testid="plan-steps"
            >
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
                  <div className="text-xs text-[color:var(--color-fg-muted)]">
                    {step.annotation}
                  </div>
                  {step.args && Object.keys(step.args).length > 0 && (
                    <pre className="text-[11px] bg-[var(--color-surface-2)] rounded p-1 overflow-auto">
                      {JSON.stringify(step.args, null, 2)}
                    </pre>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}

        <details className="rounded border border-[color:var(--color-border)] p-3 text-xs">
          <summary className="cursor-pointer">
            Tool catalog ({catalog.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {catalog.map((t) => (
              <li key={t.name} className="flex items-center gap-2">
                <span className={`px-1 rounded text-[10px] ${tierClass(t.tier)}`}>
                  {t.tier}
                </span>
                <span className="font-mono">{t.name}</span>
                <span className="text-[color:var(--color-fg-muted)]">—</span>
                <span className="text-[color:var(--color-fg-muted)]">{t.description}</span>
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
    </div>
  );
}
