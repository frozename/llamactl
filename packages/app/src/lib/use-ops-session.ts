// packages/app/src/lib/use-ops-session.ts
//
// Local mirror of the server's JournalEvent shape — kept structural to
// avoid a direct import from @llamactl/remote (matches the pattern in
// modules/workloads/workers-panel.tsx). If the server schema drifts,
// the tRPC inference at the useSubscription call site will surface
// the mismatch.
import * as React from 'react';
import { trpc } from '../lib/trpc';

export type ToolTier = 'read' | 'mutation-dry-run-safe' | 'mutation-destructive';

export type JournalEvent =
  | { type: 'session_started'; ts: string; sessionId: string;
      goal: string; nodeId?: string; model?: string;
      historyLen: number; toolCount: number }
  | { type: 'plan_proposed';   ts: string; stepId: string;
      iteration: number; tier: ToolTier; reasoning: string;
      step: { tool: string; args?: unknown; dryRun?: boolean; annotation: string } }
  | { type: 'preview_outcome'; ts: string; stepId: string;
      ok: boolean; durationMs: number;
      result?: unknown; resultRedacted?: 'omitted' | 'truncated';
      error?: { code: string; message: string } }
  | { type: 'wet_outcome';     ts: string; stepId: string;
      ok: boolean; durationMs: number;
      result?: unknown; resultRedacted?: 'omitted' | 'truncated';
      error?: { code: string; message: string } }
  | { type: 'refusal'; ts: string; reason: string }
  | { type: 'done';    ts: string; iterations: number }
  | { type: 'aborted'; ts: string; reason: 'client_abort' | 'signal' | 'timeout' };

export type SessionStatus = 'live' | 'done' | 'refused' | 'aborted';

export interface OutcomeView {
  ok: boolean;
  durationMs: number;
  result?: unknown;
  resultRedacted?: 'omitted' | 'truncated';
  error?: { code: string; message: string };
}

export interface IterationView {
  iteration: number;
  stepId: string;
  tool: string;
  tier: ToolTier;
  reasoning: string;
  args: unknown;
  preview?: OutcomeView;
  wet?: OutcomeView;
}

export interface SessionView {
  sessionId: string;
  goal: string;
  status: SessionStatus;
  startedAt: string;
  endedAt?: string;
  iterations: IterationView[];
  refusalReason?: string;
}

export function initialView(sessionId: string): SessionView {
  return {
    sessionId,
    goal: '',
    status: 'live',
    startedAt: '',
    iterations: [],
  };
}

export function mergeEventIntoView(view: SessionView, event: JournalEvent): SessionView {
  switch (event.type) {
    case 'session_started':
      return {
        ...view,
        goal: event.goal,
        startedAt: event.ts,
        status: 'live',
      };
    case 'plan_proposed': {
      if (view.iterations.some((i) => i.stepId === event.stepId)) return view;
      const next: IterationView = {
        iteration: event.iteration,
        stepId: event.stepId,
        tool: event.step.tool,
        tier: event.tier,
        reasoning: event.reasoning,
        args: (event.step as any).args,
      };
      return { ...view, iterations: [...view.iterations, next] };
    }
    case 'preview_outcome':
    case 'wet_outcome': {
      const key = event.type === 'preview_outcome' ? 'preview' : 'wet';
      return {
        ...view,
        iterations: view.iterations.map((it) =>
          it.stepId === event.stepId
            ? {
                ...it,
                [key]: {
                  ok: event.ok,
                  durationMs: event.durationMs,
                  result: event.result,
                  resultRedacted: event.resultRedacted,
                  error: event.error,
                } as OutcomeView,
              }
            : it,
        ),
      };
    }
    case 'refusal':
      return { ...view, status: 'refused', endedAt: event.ts, refusalReason: event.reason };
    case 'done':
      return { ...view, status: 'done', endedAt: event.ts };
    case 'aborted':
      return { ...view, status: 'aborted', endedAt: event.ts };
  }
}

export function useOpsSession(sessionId: string): {
  view: SessionView;
  loading: boolean;
  error: Error | null;
} {
  const [view, setView] = React.useState<SessionView>(() => initialView(sessionId));
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<Error | null>(null);

  trpc.opsSessionWatch.useSubscription(
    { sessionId },
    {
      onData: (event: JournalEvent) => {
        setView((v) => mergeEventIntoView(v, event));
        setLoading(false);
      },
      onError: (err) => setError(err instanceof Error ? err : new Error(String(err))),
    },
  );

  return { view, loading, error };
}