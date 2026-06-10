import { type ResolvedEnv, workloadRuntime } from "@llamactl/core";
import { required } from "../required.js";

export function resolveWorkloadName(
  explicit: string | undefined,
  resolved: ResolvedEnv,
  opts?: { synthesizeIfEmpty?: boolean },
): string {
  if (explicit) return explicit;
  const live = workloadRuntime.listLocalWorkloads(resolved);
  if (live.length === 1) return required(live[0]).name;
  if (live.length > 1) {
    throw new Error(
      `multiple workloads live (${live.map((w: { name: string }) => w.name).join(", ")}); pass --name <workload>`,
    );
  }
  const known = workloadRuntime.listWorkloadDirs(resolved);
  if (known.length === 1) return required(known[0]);
  if (known.length > 1) {
    throw new Error(
      `multiple workloads on this node (${known.join(", ")}); pass --name <workload>`,
    );
  }
  if (opts?.synthesizeIfEmpty) return `imperative-${String(Date.now())}`;
  throw new Error("no live workloads; pass --name <workload>");
}
