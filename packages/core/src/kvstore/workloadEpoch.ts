import { createHash } from 'node:crypto';
import { readModelHostState } from '../engines/state.js';
import { readServerState } from '../server.js';
import type { ResolvedEnv } from '../types.js';
import type { WorkloadKey } from '../workloadRuntime.js';

export interface WorkloadEpochInput {
  startedAt: string;
  rel: string;
}

export function computeWorkloadEpoch(input: WorkloadEpochInput): string {
  // Simplified 2026-05-24: epoch = sha1(startedAt + rel). pid + argsHash dropped per adversarial review — they added mtime-touch flap risk without real invalidation gain. Restart bumps startedAt; apply-cycle (which changes args) restarts the workload too.
  const payload = `${input.startedAt}|${input.rel}`;
  return createHash('sha1').update(payload).digest('hex');
}

// Kept in kvstore because workload_epoch is a cache-key concern, not an engine concern.
export function readWorkloadEpoch(key: WorkloadKey, resolved: ResolvedEnv): string | null {
  const modelRunState = readServerState(key, resolved);
  if (
    modelRunState !== null &&
    typeof modelRunState.startedAt === 'string' &&
    typeof modelRunState.rel === 'string'
  ) {
    return computeWorkloadEpoch({
      startedAt: modelRunState.startedAt,
      rel: modelRunState.rel,
    });
  }

  const modelHostState = readModelHostState(key, resolved);
  if (!modelHostState) return null;
  const hostLike = modelHostState as unknown as { startedAt?: unknown; rel?: unknown };
  if (
    typeof hostLike.startedAt === 'string' &&
    typeof hostLike.rel === 'string'
  ) {
    return computeWorkloadEpoch({
      startedAt: hostLike.startedAt,
      rel: hostLike.rel,
    });
  }
  console.warn(`[kvstore] workload_epoch unavailable for ModelHost '${key.name}': sidecar missing startedAt/rel`);
  return null;
}
