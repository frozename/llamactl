import { trpc } from "@/lib/trpc";
import { useWorkloadSelectionStore } from "@/stores/workload-selection-store";

import { getLiveWorkloads, type LiveWorkload, selectActiveWorkload } from "./workload-selection";

export interface ActiveWorkload {
  workload: string | null;
  workloads: LiveWorkload[];
  setWorkload: (name: string | null) => void;
  loading: boolean;
}

export function useActiveWorkload(): ActiveWorkload {
  const query = trpc.workloadList.useQuery(undefined, { refetchInterval: 5_000 });
  const selected = useWorkloadSelectionStore((s) => s.selected);
  const setSelected = useWorkloadSelectionStore((s) => s.setSelected);

  if (query.isLoading) {
    return { workload: null, workloads: [], setWorkload: setSelected, loading: true };
  }

  const live = getLiveWorkloads(query.data ?? []);
  const workload = selectActiveWorkload(selected, live);

  return { workload, workloads: live, setWorkload: setSelected, loading: false };
}
