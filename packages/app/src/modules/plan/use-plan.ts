import { useEffect, useMemo, useRef, useState } from "react";

import { trpc } from "@/lib/trpc";
import { useOpsExecutorStore } from "@/stores/ops-executor-store";

import type { PlanResult, ToolCatalogEntry, Turn } from "./types";

export interface UsePlanReturn {
  turns: Turn[];
  draft: string;
  setDraft: (v: string) => void;
  catalog: ToolCatalogEntry[];
  setCatalog: (v: ToolCatalogEntry[]) => void;
  decision: "approved" | "rejected" | null;
  setDecision: (v: "approved" | "rejected" | null) => void;
  error: string | null;
  onSubmit: () => void;
  onReset: () => void;
  latestAssistantId: number | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  plan: ReturnType<typeof trpc.operatorPlan.useMutation>;
}

export function usePlan(defaultCatalog: ToolCatalogEntry[]): UsePlanReturn {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const { nodeId, model } = useOpsExecutorStore();
  const [catalog, setCatalog] = useState<ToolCatalogEntry[]>(defaultCatalog);
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const plan = trpc.operatorPlan.useMutation({
    onSuccess: (res) => {
      setTurns((prev) => [
        ...prev,
        { id: nextId.current++, role: "assistant", result: res as PlanResult },
      ]);
      setError(null);
      setDecision(null);
    },
    onError: (err) => {
      setTurns((prev) => [
        ...prev,
        {
          id: nextId.current++,
          role: "assistant",
          result: { ok: false, reason: "transport", message: err.message },
        },
      ]);
      setError(err.message);
    },
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length]);

  const history = useMemo(
    () =>
      turns.map((turn) =>
        turn.role === "user"
          ? { role: "user" as const, text: turn.text }
          : { role: "assistant" as const, text: summarizeResultForHistory(turn.result) },
      ),
    [turns],
  );

  const latestAssistantId = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      if (turn?.role === "assistant") return turn.id;
    }
    return null;
  }, [turns]);

  const onSubmit = (): void => {
    const goal = draft.trim();
    if (!goal || plan.isPending) return;
    if (!nodeId || !model) {
      setError("pick a node + model in the header first");
      return;
    }
    setError(null);
    setDecision(null);
    const userTurn: Turn = { id: nextId.current++, role: "user", text: goal };
    setTurns((prev) => [...prev, userTurn]);
    setDraft("");
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
    setDraft("");
    setDecision(null);
    setError(null);
    nextId.current = 1;
  };

  return {
    turns,
    draft,
    setDraft,
    catalog,
    setCatalog,
    decision,
    setDecision,
    error,
    onSubmit,
    onReset,
    latestAssistantId,
    scrollRef,
    plan,
  };
}

function summarizeResultForHistory(result: PlanResult): string {
  if (!result.ok) {
    return `planner failed: ${result.reason}${result.message ? ` — ${result.message}` : ""}`;
  }
  const steps = result.plan.steps
    .map((step, i) => `${String(i + 1)}. ${step.tool} — ${step.annotation}`)
    .join("\n");
  return `proposed ${String(result.plan.steps.length)} step plan:\n${steps}\n\nreasoning: ${result.plan.reasoning}`;
}
