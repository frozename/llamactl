// Qualification stage ladder for the model-qualification lifecycle
// (frozename/llamactl#518). The stage vocabulary is QUALIFICATION_STAGES
// in schemas.ts; this module adds the promotion order and the
// declared/pin/health overlay resolution.

import type { QUALIFICATION_STAGES } from "../schemas.js";

export type QualificationStage = (typeof QUALIFICATION_STAGES)[number];

/**
 * Runtime tuple of the promotable stages in order. `degraded` is an
 * overlay state, never a rung. `satisfies` pins the array to the
 * canonical stage type the way PRESET_NAMES does in presets.ts.
 */
export const PROMOTION_LADDER = [
  "experimental",
  "candidate",
  "validated",
  "production",
] as const satisfies readonly QualificationStage[];

export type PromotionTarget = "candidate" | "validated" | "production";

/** The ladder successor, or null at the top rung and for degraded. */
export function nextStage(stage: QualificationStage): PromotionTarget | null {
  switch (stage) {
    case "experimental":
      return "candidate";
    case "candidate":
      return "validated";
    case "validated":
      return "production";
    case "production":
    case "degraded":
      return null;
  }
}

export interface HealthSignal {
  ok: boolean;
  reason?: string;
}

export interface EffectiveStage {
  stage: QualificationStage;
  source: "declared" | "pin" | "health";
  baseStage: QualificationStage;
  degraded: boolean;
  reason?: string;
}

export interface EffectiveStageInput {
  declared: QualificationStage;
  pin?: { stage: QualificationStage };
  health?: HealthSignal;
}

/**
 * Resolve the stage a model is treated as holding: the pin wins over
 * the declared stage, and an unhealthy signal degrades whatever the
 * base stage was while keeping it visible as `baseStage`.
 */
export function effectiveStage(input: EffectiveStageInput): EffectiveStage {
  const { declared, pin, health } = input;
  const baseStage = pin?.stage ?? declared;
  const source: EffectiveStage["source"] = pin === undefined ? "declared" : "pin";
  if (health?.ok === false) {
    return {
      stage: "degraded",
      source: "health",
      baseStage,
      degraded: true,
      ...(health.reason === undefined ? {} : { reason: health.reason }),
    };
  }
  return { stage: baseStage, source, baseStage, degraded: baseStage === "degraded" };
}
