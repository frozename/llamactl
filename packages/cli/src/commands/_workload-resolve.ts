import { workloadRuntime, type ResolvedEnv } from '@llamactl/core';

export function resolveWorkloadName(
  explicit: string | undefined,
  resolved: ResolvedEnv,
  opts?: { synthesizeIfEmpty?: boolean },
): string {
  if (explicit) return explicit;
  const live = workloadRuntime.listLocalWorkloads(resolved) ?? [];
  if (live.length === 1) return live[0]!.name;
  if (live.length === 0) {
    if (opts?.synthesizeIfEmpty) return `imperative-${Date.now()}`;
    throw new Error('no live workloads; pass --name <workload>');
  }
  throw new Error(
    `multiple workloads live (${live.map((w: { name: string }) => w.name).join(', ')}); pass --name <workload>`,
  );
}
