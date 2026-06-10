import { basename } from "node:path";
import { projectAdmissionHeadroom } from "./policy.js";
import type { FleetPlacementDecision, NodeScore } from "./types.js";
import type { SnapshotRow } from "./aggregator-db.js";

export interface PlacementInput {
  workload: string;
  targetModel: string;
  expectedMemoryMb: number;
  modelFilePenaltyMb?: number;
  headroomMinMb?: number;
  compressorWarnMb?: number;
}

const DEFAULT_HEADROOM_MIN_MB = 512;
const DEFAULT_COMPRESSOR_WARN_MB = 2048;
// 4 GB keeps model-cache penalties realistic for representative GGUF binaries.
const DEFAULT_MODEL_FILE_PENALTY_MB = 4096;

export function scoreNodes(
  rows: ReadonlyArray<SnapshotRow | null | undefined>,
  input: PlacementInput,
): NodeScore[] {
  const modelFilePenaltyMb = input.modelFilePenaltyMb ?? DEFAULT_MODEL_FILE_PENALTY_MB;
  const compressorWarnMb = input.compressorWarnMb ?? DEFAULT_COMPRESSOR_WARN_MB;
  const headroomMinMb = input.headroomMinMb ?? DEFAULT_HEADROOM_MIN_MB;

  return rows.map((entry) => {
    if (!entry) {
      return {
        node: "unknown",
        score: -Infinity,
        freeAfterMb: 0,
        freePenaltyMb: 0,
        compressorMb: 0,
        requestRate5m: 0,
        eligible: false,
        ineligibilityReason: "no_telemetry",
      };
    }

    const snapshot = entry.snapshot;
    if (!snapshot) {
      return {
        node: entry.node,
        score: -Infinity,
        freeAfterMb: 0,
        freePenaltyMb: 0,
        compressorMb: 0,
        requestRate5m: 0,
        eligible: false,
        ineligibilityReason: "no_telemetry",
      };
    }

    const targetModel = input.targetModel.trim();
    const normalizedTarget = basename(targetModel);
    const modelFilePresent =
      targetModel.length === 0
        ? true
        : snapshot.workloads.some((workload) => {
            return workload.models.some(
              (model) => model === targetModel || model === normalizedTarget,
            );
          });

    const freeAfterMb = snapshot.node_mem.free_mb - input.expectedMemoryMb;
    const freePenaltyMb = modelFilePresent ? 0 : modelFilePenaltyMb;
    const compressorMb = snapshot.node_mem.compressor_mb;
    const requestRate5m = snapshot.workloads.reduce(
      (sum, workload) => sum + (workload.request_rate_5m ?? 0),
      0,
    );

    const projected = projectAdmissionHeadroom({
      currentFreeGiB: snapshot.node_mem.free_mb / 1024,
      expectedMemoryGiB: 0,
      headroomMinGiB: headroomMinMb / 1024,
      currentCompressorGiB: snapshot.node_mem.compressor_mb / 1024,
      compressorMaxGiB: compressorWarnMb / 1024,
    });

    const pressureState: NodeScore["pressureState"] = projected.allowed ? "NORMAL" : "HIGH";
    if (projected.allowed === false) {
      return {
        node: snapshot.node,
        score: -Infinity,
        freeAfterMb,
        freePenaltyMb,
        compressorMb,
        requestRate5m,
        eligible: false,
        ineligibilityReason: "pressure",
        pressureState,
      };
    }

    if (freeAfterMb < headroomMinMb) {
      return {
        node: snapshot.node,
        score: -Infinity,
        freeAfterMb,
        freePenaltyMb,
        compressorMb,
        requestRate5m,
        eligible: false,
        ineligibilityReason: "insufficient_headroom",
        pressureState,
      };
    }

    const modelAdjustedFreeAfter = freeAfterMb - freePenaltyMb;

    return {
      node: snapshot.node,
      score: modelAdjustedFreeAfter,
      freeAfterMb,
      freePenaltyMb,
      compressorMb,
      requestRate5m,
      eligible: true,
      pressureState,
      modelFilePresent,
    };
  });
}

export function chooseBestNode(scores: ReadonlyArray<NodeScore>): string | null {
  const ranked = [...scores].sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    if (a.compressorMb !== b.compressorMb) return a.compressorMb - b.compressorMb;
    return a.requestRate5m - b.requestRate5m;
  });
  return ranked.find((score) => score.eligible)?.node ?? null;
}

export type BuildPlacementDecisionInput = {
  workloadName: string;
  requestedNode: string;
  expectedMemoryMb: number;
  scores: NodeScore[];
  headroomMinMb?: number;
  modelFilePenaltyMb?: number;
};

export function makePlacementDecision(input: BuildPlacementDecisionInput): FleetPlacementDecision {
  return {
    workload: input.workloadName,
    requestedNode: input.requestedNode,
    chosenNode: input.scores.find((score) => score.eligible)?.node ?? "",
    expectedMemoryMb: input.expectedMemoryMb,
    headroomMinMb: input.headroomMinMb ?? DEFAULT_HEADROOM_MIN_MB,
    modelFilePenaltyMb: input.modelFilePenaltyMb ?? DEFAULT_MODEL_FILE_PENALTY_MB,
    scores: input.scores,
  };
}
