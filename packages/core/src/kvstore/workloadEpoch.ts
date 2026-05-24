import { createHash } from 'node:crypto';
import { readModelHostState } from '../engines/state.js';
import { readServerPid, readServerState } from '../server.js';
import type { ResolvedEnv } from '../types.js';
import type { WorkloadKey } from '../workloadRuntime.js';

export interface WorkloadEpochInput {
  pid: number;
  startedAt: string;
  rel: string;
  argsHash?: string;
}

export function computeWorkloadEpoch(input: WorkloadEpochInput): string {
  const payload = `${input.pid}|${input.startedAt}|${input.rel}|${input.argsHash ?? ''}`;
  return createHash('sha1').update(payload).digest('hex');
}

// Kept in kvstore because workload_epoch is a cache-key concern, not an engine concern.
export function readWorkloadEpoch(key: WorkloadKey, resolved: ResolvedEnv): string | null {
  const modelRunPid = readServerPid(key, resolved);
  const modelRunState = readServerState(key, resolved);
  if (
    modelRunPid !== null &&
    modelRunState !== null &&
    modelRunState.pid === modelRunPid &&
    typeof modelRunState.startedAt === 'string' &&
    typeof modelRunState.rel === 'string'
  ) {
    return computeWorkloadEpoch({
      pid: modelRunPid,
      startedAt: modelRunState.startedAt,
      rel: modelRunState.rel,
    });
  }

  const modelHostState = readModelHostState(key, resolved);
  if (!modelHostState) return null;
  const hostLike = modelHostState as unknown as { pid?: unknown; startedAt?: unknown; rel?: unknown };
  if (
    Number.isInteger(hostLike.pid) &&
    typeof hostLike.startedAt === 'string' &&
    typeof hostLike.rel === 'string'
  ) {
    return computeWorkloadEpoch({
      pid: hostLike.pid as number,
      startedAt: hostLike.startedAt,
      rel: hostLike.rel,
    });
  }
  console.warn(`[kvstore] workload_epoch unavailable for ModelHost '${key.name}': sidecar missing pid/startedAt/rel`);
  return null;
}
