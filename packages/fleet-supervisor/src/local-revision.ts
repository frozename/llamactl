import { resolveEnv } from "@llamactl/core/env";
import { readWorkloadEpoch } from "@llamactl/core/kvstore";

import type { WorkloadTarget } from "./workload-probe.js";

/**
 * Reads a local workload's boot token from its llamactl runtime record.
 * The record's startedAt + rel (sha1'd into the workload epoch) are stable
 * per process and change on every restart — unlike `/v1/models` `created`,
 * which llama.cpp-family engines stamp with the request time.
 */
export function makeLocalRevisionReader(
  env: NodeJS.ProcessEnv = process.env,
): (target: WorkloadTarget) => string | null {
  let resolved: ReturnType<typeof resolveEnv> | undefined;
  return (target) => {
    try {
      resolved ??= resolveEnv(env);
      return readWorkloadEpoch({ name: target.name }, resolved);
    } catch {
      return null;
    }
  };
}
