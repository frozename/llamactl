import type { SafetyTier } from "@llamactl/core";

export type PlanStep = {
  tool: string;
  args?: Record<string, unknown>;
  dryRun?: boolean;
  annotation: string;
};

export type ToolTier = SafetyTier;

export interface ToolCallOutcome {
  ok: boolean;
  name: string;
  tier: ToolTier | "unknown";
  durationMs: number;
  result?: unknown;
  error?: { code: string; message: string };
}

export type ProposalState =
  | "pending"
  | "previewing"
  | "preview-ready"
  | "running-wet"
  | "done"
  | "failed"
  | "rejected";

export type TranscriptMessage =
  | { kind: "user"; id: number; content: string }
  | {
      kind: "proposal";
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
  | { kind: "refusal"; id: number; reason: string }
  | { kind: "done"; id: number; iterations: number };

export interface ProposalBubbleProps {
  message: Extract<TranscriptMessage, { kind: "proposal" }>;
  onApprove: (dryRun: boolean) => void;
  onReject: () => void;
  onConfirmText: (v: string) => void;
}
