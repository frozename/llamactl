import type { SafetyTier } from "@llamactl/core";

export type PlanStep = {
  tool: string;
  args?: Record<string, unknown>;
  dryRun?: boolean;
  annotation: string;
};

export type PlanResult =
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

export interface ToolCatalogEntry {
  name: string;
  description: string;
  tier: SafetyTier;
}

export type Turn =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "assistant"; result: PlanResult };
