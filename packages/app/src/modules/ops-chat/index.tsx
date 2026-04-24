import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { useOpsExecutorStore } from '@/stores/ops-executor-store';
import { OpsExecutorPicker } from '@/modules/ops/ops-executor-picker';

/**
 * N.4 — Operator Console.
 *
 * Streaming chat surface: the operator types a goal, the planner
 * loop emits one tool-call proposal at a time, and each proposal
 * renders as an inline assistant bubble in the transcript. The
 * operator approves (or rejects) each proposal individually; the
 * outcome is posted back to the server loop which then re-plans and
 * emits the next proposal — or a `done`/`refusal` event that closes
 * the stream.
 *
 * Approval tiers preserved from the pre-streaming surface:
 *   - read                   → one-click Run
 *   - mutation-dry-run-safe  → Preview (dry) → Run (wet) two-step
 *   - mutation-destructive   → type the tool name to unlock wet-run
 *
 * Every tool invocation still writes one audit entry to
 * `~/.llamactl/ops-chat/audit.jsonl` via `operatorRunTool`; the
 * collapsible panel at the bottom tails the last 50 entries.
 */

type PlanStep = {
  tool: string;
  args?: Record<string, unknown>;
  dryRun?: boolean;
  annotation: string;
};

type ToolTier = 'read' | 'mutation-dry-run-safe' | 'mutation-destructive';

interface ToolCallOutcome {
  ok: boolean;
  name: string;
  tier: ToolTier | 'unknown';
  durationMs: number;
  result?: unknown;
  error?: { code: string; message: string };
}

type ProposalState =
  | 'pending'
  | 'previewing'
  | 'preview-ready'
  | 'running-wet'
  | 'done'
  | 'failed'
  | 'rejected';

type TranscriptMessage =
  | { kind: 'user'; id: number; content: string }
  | {
      kind: 'proposal';
      id: number;
      sessionId: string;
      stepId: string;
      iteration: number;
      step: PlanStep;
      tier: ToolTier;
      reasoning: string;
      state: ProposalState;
      confirmText: string;
      previewOutcome?: ToolCallOutcome;
      wetOutcome?: ToolCallOutcome;
    }
  | { kind: 'refusal'; id: number; reason: string }
  | { kind: 'done'; id: number; iterations: number };

/**
 * Canned prompts — seed examples that give operators an instant
 * sense of what this module can do. Kept intentionally short; the
 * chip strip has to stay one-line on a 1280px window.
 */
const CANNED_PROMPTS: Array<{ label: string; prompt: string }> = [
  {
    label: 'Audit fleet health',
    prompt:
      'Check every node for unhealthy providers and suggest fixes. Read-only — do not apply anything yet.',
  },
  {
    label: "Today's AI spend",
    prompt:
      'Pull llamactl.cost.snapshot for today and summarize the top 3 spenders by provider.',
  },
  {
    label: 'Promote top 3 models',
    prompt:
      'Using the bench results, promote the top 3 models by tokens/sec on macbook-pro-48g to the best/vision/balanced presets.',
  },
  {
    label: 'List installed vision models',
    prompt: 'List every vision-capable model installed on the control plane.',
  },
];

const DEFAULT_CATALOG: Array<{
  name: string;
  description: string;
  tier: 'read' | 'mutation-dry-run-safe' | 'mutation-destructive';
}> = [
  { name: 'llamactl.catalog.list', description: 'List curated models on the control plane.', tier: 'read' },
  { name: 'llamactl.node.ls', description: 'List every cluster node.', tier: 'read' },
  { name: 'llamactl.bench.compare', description: 'Joined catalog + bench comparison table.', tier: 'read' },
  { name: 'llamactl.bench.history', description: 'Recent bench runs.', tier: 'read' },
  { name: 'llamactl.server.status', description: 'llama-server lifecycle status.', tier: 'read' },
  { name: 'llamactl.workload.list', description: 'Declarative ModelRun manifests.', tier: 'read' },
  { name: 'llamactl.promotions.list', description: 'Current preset promotions.', tier: 'read' },
  { name: 'llamactl.env', description: 'Environment snapshot.', tier: 'read' },
  { name: 'llamactl.cost.snapshot', description: 'Rolled-up spend for the last N days.', tier: 'read' },
  { name: 'llamactl.catalog.promote', description: 'Promote a model to a preset on a profile.', tier: 'mutation-dry-run-safe' },
  { name: 'llamactl.catalog.promoteDelete', description: 'Remove a preset promotion.', tier: 'mutation-destructive' },
  { name: 'llamactl.workload.delete', description: 'Remove a ModelRun manifest.', tier: 'mutation-destructive' },
  { name: 'llamactl.node.remove', description: 'Remove a node from the cluster.', tier: 'mutation-destructive' },
];

function tierClass(tier: ToolTier): string {
  switch (tier) {
    case 'mutation-destructive':
      return 'border-[var(--color-danger)] text-[color:var(--color-danger)]';
    case 'mutation-dry-run-safe':
      return 'border-[var(--color-warning,var(--color-accent))] text-[color:var(--color-warning,var(--color-accent))]';
    case 'read':
    default:
      return 'border-[var(--color-border)] text-[color:var(--color-fg-muted)]';
  }
}

interface ProposalBubbleProps {
  message: Extract<TranscriptMessage, { kind: 'proposal' }>;
  onApprove: (dryRun: boolean) => void;
  onReject: () => void;
  onConfirmText: (v: string) => void;
}

function ProposalBubble({
  message,
  onApprove,
  onReject,
  onConfirmText,
}: ProposalBubbleProps): React.JSX.Element {
  const { step, tier, iteration, state, confirmText, previewOutcome, wetOutcome, reasoning } = message;
  const destructiveReady = tier === 'mutation-destructive' ? confirmText.trim() === step.tool : true;
  const terminal = state === 'done' || state === 'failed' || state === 'rejected';
  const running = state === 'previewing' || state === 'running-wet';

  return (
    <div className="flex justify-start">
      <div
        className={`max-w-[85%] rounded-2xl border p-3 space-y-2 bg-[color:var(--color-surface-1)] ${tierClass(tier)}`}
        data-testid={`ops-chat-step-${iteration}`}
        data-tier={tier}
        data-state={state}
      >
        {reasoning.length > 0 && (
          <p
            className="text-xs text-[color:var(--color-fg-muted)] italic"
            data-testid={`ops-chat-step-${iteration}-reasoning`}
          >
            {reasoning}
          </p>
        )}
        <div className="text-sm text-[color:var(--color-fg)]">
          {terminal ? 'Ran:' : 'I\u2019d like to run:'}
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm">{step.tool}</span>
          <span
            className={`rounded border px-1 text-[10px] ${tierClass(tier)}`}
            data-testid={`ops-chat-step-${iteration}-tier`}
          >
            {tier}
          </span>
        </div>
        <div className="text-xs text-[color:var(--color-fg-muted)]">{step.annotation}</div>
        {step.args && Object.keys(step.args).length > 0 && (
          <pre
            className="text-[11px] bg-[var(--color-surface-2)] rounded p-1 overflow-auto max-h-40"
            data-testid={`ops-chat-step-${iteration}-args`}
          >
            {JSON.stringify(step.args, null, 2)}
          </pre>
        )}

        {tier === 'mutation-destructive' && !terminal && (
          <label className="flex items-center gap-1 text-[10px] text-[color:var(--color-fg-muted)]">
            Type <span className="font-mono">{step.tool}</span> to unlock:
            <input
              type="text"
              value={confirmText}
              onChange={(e) => onConfirmText(e.target.value)}
              data-testid={`ops-chat-step-${iteration}-confirm`}
              className="w-48 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 py-0.5 font-mono text-[10px]"
            />
          </label>
        )}

        {!terminal && (
          <div className="flex items-center gap-1 pt-1">
            {tier !== 'read' && (
              <button
                type="button"
                onClick={() => onApprove(true)}
                disabled={running || state === 'preview-ready'}
                data-testid={`ops-chat-step-${iteration}-preview`}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-fg-muted)] disabled:opacity-50"
              >
                {state === 'previewing' ? 'Running…' : 'Preview (dry)'}
              </button>
            )}
            <button
              type="button"
              onClick={() => onApprove(false)}
              disabled={
                running ||
                (tier === 'mutation-destructive' && !destructiveReady)
              }
              data-testid={`ops-chat-step-${iteration}-run`}
              className={
                tier === 'mutation-destructive'
                  ? 'rounded border border-[var(--color-danger)] px-2 py-0.5 text-[10px] text-[color:var(--color-danger)] disabled:opacity-40'
                  : tier === 'mutation-dry-run-safe'
                    ? 'rounded border border-[var(--color-accent)] px-2 py-0.5 text-[10px] text-[color:var(--color-accent)] disabled:opacity-40'
                    : 'rounded border border-[var(--color-border)] bg-[var(--color-accent)] px-2 py-0.5 text-[10px] text-[color:var(--color-fg-inverted)] disabled:opacity-40'
              }
            >
              {state === 'running-wet'
                ? 'Running…'
                : tier === 'read'
                  ? 'Run'
                  : 'Run (wet)'}
            </button>
            <button
              type="button"
              onClick={onReject}
              disabled={running}
              data-testid={`ops-chat-step-${iteration}-reject`}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-fg-muted)] disabled:opacity-40"
            >
              Reject
            </button>
          </div>
        )}

        {previewOutcome && (
          <OutcomePanel iteration={iteration} outcome={previewOutcome} kind="preview" />
        )}
        {wetOutcome && (
          <OutcomePanel iteration={iteration} outcome={wetOutcome} kind="wet" />
        )}
        {state === 'rejected' && (
          <div
            className="text-xs italic text-[color:var(--color-fg-muted)]"
            data-testid={`ops-chat-step-${iteration}-rejected`}
          >
            Operator rejected \u2014 session closed.
          </div>
        )}
      </div>
    </div>
  );
}

function OutcomePanel({
  iteration,
  outcome,
  kind,
}: {
  iteration: number;
  outcome: ToolCallOutcome;
  kind: 'preview' | 'wet';
}): React.JSX.Element {
  return (
    <div
      className="mt-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 text-[11px]"
      data-testid={`ops-chat-step-${iteration}-${kind === 'preview' ? 'preview-result' : 'result'}`}
      data-ok={outcome.ok ? 'true' : 'false'}
    >
      <div className="text-[color:var(--color-fg-muted)]">
        {outcome.ok ? '✓ ok' : '✗ failed'} · {outcome.durationMs}ms
        {kind === 'preview' ? ' · dry-run' : ''}
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
  );
}

export default function OpsChat(): React.JSX.Element {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [draft, setDraft] = useState('');
  const { nodeId, model } = useOpsExecutorStore();
  const [error, setError] = useState<string | null>(null);
  const [streamInput, setStreamInput] = useState<Parameters<
    typeof trpc.operatorChatStream.useSubscription
  >[0] | null>(null);
  const [streamKey, setStreamKey] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const runTool = trpc.operatorRunTool.useMutation();
  const submitOutcome = trpc.operatorSubmitStepOutcome.useMutation();
  const auditTail = trpc.opsChatAuditTail.useQuery(
    { limit: 50 },
    { refetchInterval: 5_000, staleTime: 1_000 },
  );

  trpc.operatorChatStream.useSubscription(
    streamInput ?? { goal: '__placeholder__', tools: [] },
    {
      enabled: !!streamInput,
      key: streamKey,
      onData: (evt) => {
        const e = evt as
          | {
              type: 'plan_proposed';
              sessionId: string;
              stepId: string;
              iteration: number;
              step: PlanStep;
              tier: ToolTier;
              reasoning: string;
            }
          | { type: 'refusal'; reason: string }
          | { type: 'done'; iterations: number };
        if (e.type === 'plan_proposed') {
          setMessages((prev) => [
            ...prev,
            {
              kind: 'proposal',
              id: nextId.current++,
              sessionId: e.sessionId,
              stepId: e.stepId,
              iteration: e.iteration,
              step: e.step,
              tier: e.tier,
              reasoning: e.reasoning,
              state: 'pending',
              confirmText: '',
            },
          ]);
        } else if (e.type === 'refusal') {
          setMessages((prev) => [
            ...prev,
            { kind: 'refusal', id: nextId.current++, reason: e.reason },
          ]);
          setStreaming(false);
          setStreamInput(null);
        } else if (e.type === 'done') {
          if (e.iterations > 0) {
            setMessages((prev) => [
              ...prev,
              { kind: 'done', id: nextId.current++, iterations: e.iterations },
            ]);
          }
          setStreaming(false);
          setStreamInput(null);
        }
      },
      onError: (err) => {
        setError(err.message);
        setStreaming(false);
        setStreamInput(null);
      },
    } as Parameters<typeof trpc.operatorChatStream.useSubscription>[1],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const history = useMemo(
    () =>
      messages
        .filter((m): m is Extract<TranscriptMessage, { kind: 'user' }> => m.kind === 'user')
        .map((m) => ({ role: 'user' as const, text: m.content })),
    [messages],
  );

  const onSubmit = (): void => {
    const goal = draft.trim();
    if (!goal || streaming) return;
    if (!nodeId || !model) {
      setError('pick a node + model in the header first');
      return;
    }
    setError(null);
    setMessages((prev) => [
      ...prev,
      { kind: 'user', id: nextId.current++, content: goal },
    ]);
    setDraft('');
    setStreaming(true);
    setStreamKey((k) => k + 1);
    setStreamInput({
      goal,
      nodeId,
      model,
      tools: DEFAULT_CATALOG,
      history,
    });
  };

  const onReset = (): void => {
    setMessages([]);
    setDraft('');
    setError(null);
    setStreamInput(null);
    setStreaming(false);
    nextId.current = 1;
  };

  function refreshAudit(): void {
    void auditTail.refetch();
  }

  function patchProposal(
    id: number,
    patch: Partial<Extract<TranscriptMessage, { kind: 'proposal' }>>,
  ): void {
    setMessages((prev) =>
      prev.map((m) => (m.id === id && m.kind === 'proposal' ? { ...m, ...patch } : m)),
    );
  }

  async function onApprove(
    msg: Extract<TranscriptMessage, { kind: 'proposal' }>,
    dryRun: boolean,
  ): Promise<void> {
    patchProposal(msg.id, { state: dryRun ? 'previewing' : 'running-wet' });
    try {
      const outcome = (await runTool.mutateAsync({
        name: msg.step.tool,
        arguments: (msg.step.args ?? {}) as Record<string, unknown>,
        dryRun,
      })) as ToolCallOutcome;
      refreshAudit();
      if (dryRun) {
        patchProposal(msg.id, { state: 'preview-ready', previewOutcome: outcome });
        return;
      }
      patchProposal(msg.id, {
        state: outcome.ok ? 'done' : 'failed',
        wetOutcome: outcome,
      });
      await submitOutcome.mutateAsync({
        sessionId: msg.sessionId,
        stepId: msg.stepId,
        ok: outcome.ok,
        summary: summarizeOutcome(outcome),
        abort: false,
      });
    } catch (err) {
      const outcome: ToolCallOutcome = {
        ok: false,
        name: msg.step.tool,
        tier: 'unknown',
        durationMs: 0,
        error: { code: 'transport', message: (err as Error).message },
      };
      patchProposal(msg.id, { state: 'failed', wetOutcome: outcome });
      refreshAudit();
      if (!dryRun) {
        try {
          await submitOutcome.mutateAsync({
            sessionId: msg.sessionId,
            stepId: msg.stepId,
            ok: false,
            summary: `transport error: ${(err as Error).message}`,
            abort: false,
          });
        } catch {
          /* best-effort — session may already be closed */
        }
      }
    }
  }

  async function onReject(msg: Extract<TranscriptMessage, { kind: 'proposal' }>): Promise<void> {
    patchProposal(msg.id, { state: 'rejected' });
    try {
      await submitOutcome.mutateAsync({
        sessionId: msg.sessionId,
        stepId: msg.stepId,
        ok: false,
        summary: 'operator rejected proposal',
        abort: true,
      });
    } catch {
      /* loop may have already terminated */
    }
    setStreaming(false);
    setStreamInput(null);
  }

  function onConfirmText(id: number, v: string): void {
    patchProposal(id, { confirmText: v });
  }

  const submitDisabled = streaming || draft.trim().length === 0;

  return (
    <div
      className="flex h-full flex-col"
      data-testid="ops-chat-root"
      data-streaming={streaming ? 'true' : 'false'}
      data-message-count={messages.length}
    >
      <div className="border-b border-[color:var(--color-border)] p-4 space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">Operator Console</h2>
            <p className="text-xs text-[color:var(--color-fg-muted)] max-w-prose">
              Natural-language goals become MCP tool calls. Reads run with one
              click; mutations preview dry-first; destructive actions require
              the operator to type the tool name to confirm. Every attempt \u2014
              dry, wet, successful, failed \u2014 appends one entry to
              {auditTail.data?.path ? (
                <span className="font-mono"> {auditTail.data.path}</span>
              ) : (
                <span> the ops-chat audit journal</span>
              )}
              .
            </p>
          </div>
          <div className="flex items-center gap-2">
            <OpsExecutorPicker />
            {messages.length > 0 && (
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
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-auto p-4 space-y-3"
        data-testid="ops-chat-transcript"
      >
        {messages.length === 0 && (
          <div
            className="rounded-md border border-dashed border-[color:var(--color-border)] p-6 text-sm text-[color:var(--color-fg-muted)]"
            data-testid="ops-chat-empty"
          >
            <h3 className="text-sm font-semibold text-[color:var(--color-fg)]">
              Drive the fleet by describing the goal
            </h3>
            <p className="mt-1 text-xs">
              Example:{' '}
              <span className="font-mono">list installed vision models</span>.
              The planner proposes tool calls one at a time, inline. Approve
              each one; reads run with a click, mutations preview dry-first.
            </p>
          </div>
        )}
        {messages.map((msg) => {
          if (msg.kind === 'user') {
            return (
              <div key={msg.id} className="flex justify-end">
                <div className="max-w-[70%] rounded-2xl bg-[color:var(--color-accent)] px-3 py-2 text-sm text-[color:var(--color-fg-inverted)] whitespace-pre-wrap">
                  {msg.content}
                </div>
              </div>
            );
          }
          if (msg.kind === 'refusal') {
            return (
              <div key={msg.id} className="flex justify-start">
                <div
                  className="max-w-[70%] rounded-2xl border border-[color:var(--color-warning,var(--color-accent))] p-3 text-sm space-y-1 bg-[color:var(--color-surface-1)]"
                  data-testid={`ops-chat-refusal-${msg.id}`}
                >
                  <div className="font-medium">Planner refused</div>
                  <div className="text-xs text-[color:var(--color-fg-muted)]">{msg.reason}</div>
                </div>
              </div>
            );
          }
          if (msg.kind === 'done') {
            return (
              <div
                key={msg.id}
                className="flex justify-center"
                data-testid={`ops-chat-done-${msg.id}`}
              >
                <div className="rounded-2xl bg-[color:var(--color-surface-2)] px-3 py-1 text-[10px] text-[color:var(--color-fg-muted)]">
                  Loop closed · {msg.iterations} iteration{msg.iterations === 1 ? '' : 's'}
                </div>
              </div>
            );
          }
          return (
            <ProposalBubble
              key={msg.id}
              message={msg}
              onApprove={(dryRun) => void onApprove(msg, dryRun)}
              onReject={() => void onReject(msg)}
              onConfirmText={(v) => onConfirmText(msg.id, v)}
            />
          );
        })}
        {streaming && !messages.some((m) => m.kind === 'proposal' && m.state === 'pending') && (
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
                  <span className="text-[color:var(--color-danger)]">{entry.errorCode}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[color:var(--color-fg-muted)]">
            No audit entries yet \u2014 run a step to start populating{' '}
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
        <div
          className="flex flex-wrap items-center gap-1"
          data-testid="ops-chat-canned-prompts"
        >
          {CANNED_PROMPTS.map((cp, i) => (
            <button
              key={cp.label}
              type="button"
              onClick={() => setDraft(cp.prompt)}
              disabled={streaming}
              data-testid={`ops-chat-canned-${i}`}
              className="rounded-full border border-[color:var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] disabled:opacity-40"
            >
              {cp.label}
            </button>
          ))}
        </div>
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
            messages.length === 0
              ? 'e.g. list installed vision models'
              : streaming
                ? 'Waiting for next proposal…'
                : 'Start a new conversation by clicking "New conversation"'
          }
          disabled={streaming}
          className="w-full rounded border border-[color:var(--color-border)] bg-[var(--color-surface-2)] p-2 text-sm font-mono disabled:opacity-60"
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
            {streaming ? 'Streaming…' : messages.length === 0 ? 'Plan' : 'Send'}
          </button>
          <span className="text-[10px] text-[color:var(--color-fg-muted)]">
            ⌘/Ctrl+Enter to send · {messages.length} message{messages.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>
    </div>
  );
}

function summarizeOutcome(outcome: ToolCallOutcome): string {
  if (!outcome.ok) {
    return `error ${outcome.error?.code ?? 'unknown'}: ${outcome.error?.message ?? '(no message)'}`;
  }
  const json = JSON.stringify(outcome.result);
  return json.length > 500 ? `ok (${json.length} bytes): ${json.slice(0, 500)}…` : `ok: ${json}`;
}
