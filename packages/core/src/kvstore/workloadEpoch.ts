import { createHash } from "node:crypto";

import type { ResolvedEnv } from "../types.js";
import type { WorkloadKey } from "../workloadRuntime.js";

import { readModelHostState } from "../engines/state.js";
import { readServerState } from "../server.js";

export interface WorkloadEpochInput {
  startedAt: string;
  rel: string;
}

export function computeWorkloadEpoch(input: WorkloadEpochInput): string {
  // Simplified 2026-05-24: epoch = sha1(startedAt + rel). pid + argsHash dropped per adversarial review — they added mtime-touch flap risk without real invalidation gain. Restart bumps startedAt; apply-cycle (which changes args) restarts the workload too.
  const payload = `${input.startedAt}|${input.rel}`;
  return createHash("sha1").update(payload).digest("hex");
}

// Kept in kvstore because workload_epoch is a cache-key concern, not an engine concern.
export function readWorkloadEpoch(key: WorkloadKey, resolved: ResolvedEnv): string | null {
  const modelRunState = readServerState(key, resolved);
  if (
    modelRunState !== null &&
    typeof modelRunState.startedAt === "string" &&
    typeof modelRunState.rel === "string"
  ) {
    return computeWorkloadEpoch({
      startedAt: modelRunState.startedAt,
      rel: modelRunState.rel,
    });
  }

  const modelHostState = readModelHostState(key, resolved);
  if (!modelHostState) return null;
  const hostLike = modelHostState as unknown as {
    startedAt?: unknown;
    rel?: unknown;
    modelAliases?: unknown;
  };
  // ModelHost (omlx) sidecars carry `modelAliases`, not `rel` (a ModelRun/llama-server
  // field). Derive the epoch identity from the canonical first alias so omlx prefix-KV
  // caching engages; fall back to `rel` if a future sidecar shape provides it.
  const hostRel =
    typeof hostLike.rel === "string"
      ? hostLike.rel
      : Array.isArray(hostLike.modelAliases) && typeof hostLike.modelAliases[0] === "string"
        ? hostLike.modelAliases[0]
        : null;
  if (typeof hostLike.startedAt === "string" && hostRel !== null) {
    return computeWorkloadEpoch({ startedAt: hostLike.startedAt, rel: hostRel });
  }
  console.warn(
    `[kvstore] workload_epoch unavailable for ModelHost '${key.name}': sidecar missing startedAt/modelAliases`,
  );
  return null;
}
