import { trpc } from '@/lib/trpc';

type WorkloadRow = {
  name?: string;
  phase?: string;
};

export function useActiveWorkload(): { workload: string | null; loading: boolean } {
  const query = trpc.workloadList.useQuery(undefined, { refetchInterval: 5_000 });
  if (query.isLoading) return { workload: null, loading: true };
  const live = (query.data ?? []).filter((row: WorkloadRow) => row.phase === 'Running');
  if (live.length !== 1) return { workload: null, loading: false };
  return { workload: live[0]?.name ?? null, loading: false };
}
