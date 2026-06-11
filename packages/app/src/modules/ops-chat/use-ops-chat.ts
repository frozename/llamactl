import { useEffect, useMemo, useRef, useState } from "react";

import { trpc } from "@/lib/trpc";
import { useOpsExecutorStore } from "@/stores/ops-executor-store";
import { useTabStore } from "@/stores/tab-store";

import type { PlanStep, ToolCallOutcome, ToolTier, TranscriptMessage } from "./types";

export interface UseOpsChatReturn {
  messages: TranscriptMessage[];
  draft: string;
  setDraft: (v: string) => void;
  error: string | null;
  streaming: boolean;
  onSubmit: () => void;
  onReset: () => void;
  onApprove: (
    msg: Extract<TranscriptMessage, { kind: "proposal" }>,
    dryRun: boolean,
  ) => Promise<void>;
  onReject: (msg: Extract<TranscriptMessage, { kind: "proposal" }>) => Promise<void>;
  onConfirmText: (id: number, v: string) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  auditTail: ReturnType<typeof trpc.opsChatAuditTail.useQuery>;
}

export function useOpsChat(
  defaultCatalog: {
    name: string;
    description: string;
    tier: "read" | "mutation-dry-run-safe" | "mutation-destructive";
  }[],
): UseOpsChatReturn {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [draft, setDraft] = useState("");
  const { nodeId, model } = useOpsExecutorStore();
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamInput, setStreamInput] = useState<
    Parameters<typeof trpc.operatorChatStream.useSubscription>[0] | null
  >(null);
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
      const e = evt as
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
      if (e.type === "plan_proposed") {
        if (pinnedSessionRef.current !== e.sessionId) {
          pinnedSessionRef.current = e.sessionId;
          useTabStore.getState().open({
            tabKey: `ops-session:${e.sessionId}`,
            title: `Session ${e.sessionId.slice(0, 8)}`,
            kind: "ops-session",
            instanceId: e.sessionId,
            openedAt: Date.now(),
          });
        }
        setMessages((prev) => [
          ...prev,
          {
            kind: "proposal",
            id: nextId.current++,
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
        setMessages((prev) => [
          ...prev,
          { kind: "refusal", id: nextId.current++, reason: e.reason },
        ]);
        setStreaming(false);
        setStreamInput(null);
      } else {
        if (e.iterations > 0)
          setMessages((prev) => [
            ...prev,
            { kind: "done", id: nextId.current++, iterations: e.iterations },
          ]);
        setStreaming(false);
        setStreamInput(null);
      }
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

  const onApprove = async (
    msg: Extract<TranscriptMessage, { kind: "proposal" }>,
    dryRun: boolean,
  ): Promise<void> => {
    const patch = (p: Partial<Extract<TranscriptMessage, { kind: "proposal" }>>): void => {
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id && m.kind === "proposal" ? { ...m, ...p } : m)),
      );
    };
    patch({ state: dryRun ? "previewing" : "running-wet" });
    try {
      const outcome = await runTool.mutateAsync({
        name: msg.step.tool,
        arguments: msg.step.args ?? {},
        dryRun,
      });
      void auditTail.refetch();
      if (dryRun) {
        patch({ state: "preview-ready", previewOutcome: outcome });
        return;
      }
      patch({ state: outcome.ok ? "done" : "failed", wetOutcome: outcome });
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
        tier: "unknown",
        durationMs: 0,
        error: { code: "transport", message: (err as Error).message },
      };
      patch({ state: "failed", wetOutcome: outcome });
      void auditTail.refetch();
      if (!dryRun)
        try {
          await submitOutcome.mutateAsync({
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
  };

  const onReject = async (msg: Extract<TranscriptMessage, { kind: "proposal" }>): Promise<void> => {
    setMessages((prev) =>
      prev.map((m) => (m.id === msg.id && m.kind === "proposal" ? { ...m, state: "rejected" } : m)),
    );
    try {
      await submitOutcome.mutateAsync({
        sessionId: msg.sessionId,
        stepId: msg.stepId,
        ok: false,
        summary: "operator rejected proposal",
        abort: true,
      });
    } catch {
      /* ignore */
    }
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
