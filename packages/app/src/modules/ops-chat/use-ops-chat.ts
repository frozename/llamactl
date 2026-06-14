import { useEffect, useMemo, useRef, useState } from "react";

import { trpc } from "@/lib/trpc";
import { useOpsExecutorStore } from "@/stores/ops-executor-store";
import { useTabStore } from "@/stores/tab-store";

import type { PlanStep, ToolCallOutcome, ToolTier, TranscriptMessage } from "./types";

type ProposalMessage = Extract<TranscriptMessage, { kind: "proposal" }>;
type OpsStreamInput = Parameters<typeof trpc.operatorChatStream.useSubscription>[0];

export interface UseOpsChatReturn {
  messages: TranscriptMessage[];
  draft: string;
  setDraft: (v: string) => void;
  error: string | null;
  streaming: boolean;
  onSubmit: () => void;
  onReset: () => void;
  onApprove: (msg: ProposalMessage, dryRun: boolean) => Promise<void>;
  onReject: (msg: ProposalMessage) => Promise<void>;
  onConfirmText: (id: number, v: string) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  auditTail: ReturnType<typeof trpc.opsChatAuditTail.useQuery>;
}

type OperatorStreamEvent =
  | {
      type: "plan_proposed";
      sessionId: string;
      stepId: string;
      iteration: number;
      step: PlanStep;
      tier: ToolTier;
      reasoning: string;
    }
  | { type: "refusal"; reason: string }
  | { type: "done"; iterations: number };

interface OperatorStreamContext {
  pinnedSessionRef: { current: string | null };
  nextId: { current: number };
  setMessages: (update: (prev: TranscriptMessage[]) => TranscriptMessage[]) => void;
  setStreaming: (v: boolean) => void;
  setStreamInput: (v: OpsStreamInput | null) => void;
}

function applyOperatorStreamEvent(e: OperatorStreamEvent, ctx: OperatorStreamContext): void {
  if (e.type === "plan_proposed") {
    if (ctx.pinnedSessionRef.current !== e.sessionId) {
      ctx.pinnedSessionRef.current = e.sessionId;
      useTabStore.getState().open({
        tabKey: `ops-session:${e.sessionId}`,
        title: `Session ${e.sessionId.slice(0, 8)}`,
        kind: "ops-session",
        instanceId: e.sessionId,
        openedAt: Date.now(),
      });
    }
    ctx.setMessages((prev) => [
      ...prev,
      {
        kind: "proposal",
        id: ctx.nextId.current++,
        sessionId: e.sessionId,
        stepId: e.stepId,
        iteration: e.iteration,
        step: e.step,
        tier: e.tier,
        reasoning: e.reasoning,
        state: "pending",
        confirmText: "",
      },
    ]);
  } else if (e.type === "refusal") {
    ctx.setMessages((prev) => [
      ...prev,
      { kind: "refusal", id: ctx.nextId.current++, reason: e.reason },
    ]);
    ctx.setStreaming(false);
    ctx.setStreamInput(null);
  } else {
    if (e.iterations > 0)
      ctx.setMessages((prev) => [
        ...prev,
        { kind: "done", id: ctx.nextId.current++, iterations: e.iterations },
      ]);
    ctx.setStreaming(false);
    ctx.setStreamInput(null);
  }
}

interface ProposalOutcomeDeps {
  runToolAsync: ReturnType<typeof trpc.operatorRunTool.useMutation>["mutateAsync"];
  submitOutcomeAsync: ReturnType<typeof trpc.operatorSubmitStepOutcome.useMutation>["mutateAsync"];
  refetchAudit: () => void;
  setMessages: (update: (prev: TranscriptMessage[]) => TranscriptMessage[]) => void;
}

async function approveProposal(
  msg: ProposalMessage,
  dryRun: boolean,
  deps: ProposalOutcomeDeps,
): Promise<void> {
  const patch = (p: Partial<ProposalMessage>): void => {
    deps.setMessages((prev) =>
      prev.map((m) => (m.id === msg.id && m.kind === "proposal" ? { ...m, ...p } : m)),
    );
  };
  patch({ state: dryRun ? "previewing" : "running-wet" });
  try {
    const outcome = await deps.runToolAsync({
      name: msg.step.tool,
      arguments: msg.step.args ?? {},
      dryRun,
    });
    deps.refetchAudit();
    if (dryRun) {
      patch({ state: "preview-ready", previewOutcome: outcome });
      return;
    }
    patch({ state: outcome.ok ? "done" : "failed", wetOutcome: outcome });
    await deps.submitOutcomeAsync({
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
      tier: "unknown",
      durationMs: 0,
      error: { code: "transport", message: (err as Error).message },
    };
    patch({ state: "failed", wetOutcome: outcome });
    deps.refetchAudit();
    if (!dryRun)
      try {
        await deps.submitOutcomeAsync({
          sessionId: msg.sessionId,
          stepId: msg.stepId,
          ok: false,
          summary: `transport error: ${(err as Error).message}`,
          abort: false,
        });
      } catch {
        /* ignore */
      }
  }
}

async function rejectProposal(
  msg: ProposalMessage,
  deps: Pick<ProposalOutcomeDeps, "submitOutcomeAsync" | "setMessages">,
): Promise<void> {
  deps.setMessages((prev) =>
    prev.map((m) => (m.id === msg.id && m.kind === "proposal" ? { ...m, state: "rejected" } : m)),
  );
  try {
    await deps.submitOutcomeAsync({
      sessionId: msg.sessionId,
      stepId: msg.stepId,
      ok: false,
      summary: "operator rejected proposal",
      abort: true,
    });
  } catch {
    /* ignore */
  }
}

export function useOpsChat(
  defaultCatalog: {
    name: string;
    description: string;
    tier: ToolTier;
  }[],
): UseOpsChatReturn {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [draft, setDraft] = useState("");
  const { nodeId, model } = useOpsExecutorStore();
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamInput, setStreamInput] = useState<OpsStreamInput | null>(null);
  const [streamKey, setStreamKey] = useState(0);
  const pinnedSessionRef = useRef<string | null>(null);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const runTool = trpc.operatorRunTool.useMutation();
  const submitOutcome = trpc.operatorSubmitStepOutcome.useMutation();
  const auditTail = trpc.opsChatAuditTail.useQuery(
    { limit: 50 },
    { refetchInterval: 5000, staleTime: 1000 },
  );

  trpc.operatorChatStream.useSubscription(streamInput ?? { goal: "__placeholder__", tools: [] }, {
    enabled: !!streamInput,
    key: streamKey,
    onData: (evt) => {
      applyOperatorStreamEvent(evt, {
        pinnedSessionRef,
        nextId,
        setMessages,
        setStreaming,
        setStreamInput,
      });
    },
    onError: (err: { message: string }) => {
      setError(err.message);
      setStreaming(false);
      setStreamInput(null);
    },
  } as Parameters<typeof trpc.operatorChatStream.useSubscription>[1]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const history = useMemo(() => {
    return messages
      .filter((m): m is Extract<TranscriptMessage, { kind: "user" }> => m.kind === "user")
      .map((m) => ({ role: "user" as const, text: m.content }));
  }, [messages]);

  const onSubmit = (): void => {
    const goal = draft.trim();
    if (!goal || streaming || !nodeId || !model) {
      if (!nodeId || !model) setError("pick a node + model in the header first");
      return;
    }
    pinnedSessionRef.current = null;
    setError(null);
    setMessages((prev) => [...prev, { kind: "user", id: nextId.current++, content: goal }]);
    setDraft("");
    setStreaming(true);
    setStreamKey((k) => k + 1);
    setStreamInput({ goal, nodeId, model, tools: defaultCatalog, history });
  };

  const onApprove = (msg: ProposalMessage, dryRun: boolean): Promise<void> =>
    approveProposal(msg, dryRun, {
      runToolAsync: runTool.mutateAsync,
      submitOutcomeAsync: submitOutcome.mutateAsync,
      refetchAudit: () => {
        void auditTail.refetch();
      },
      setMessages,
    });

  const onReject = async (msg: ProposalMessage): Promise<void> => {
    await rejectProposal(msg, { submitOutcomeAsync: submitOutcome.mutateAsync, setMessages });
    setStreaming(false);
    setStreamInput(null);
  };

  return {
    messages,
    draft,
    setDraft,
    error,
    streaming,
    onSubmit,
    onApprove,
    onReject,
    scrollRef,
    auditTail,
    onReset: (): void => {
      setMessages([]);
      setDraft("");
      setError(null);
      setStreamInput(null);
      setStreaming(false);
      nextId.current = 1;
    },
    onConfirmText: (id: number, v: string): void => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id && m.kind === "proposal" ? { ...m, confirmText: v } : m)),
      );
    },
  };
}

function summarizeOutcome(outcome: ToolCallOutcome): string {
  if (!outcome.ok)
    return `error ${outcome.error?.code ?? "unknown"}: ${outcome.error?.message ?? "(no message)"}`;
  const json = JSON.stringify(outcome.result);
  return json.length > 500
    ? `ok (${String(json.length)} bytes): ${json.slice(0, 500)}…`
    : `ok: ${json}`;
}
