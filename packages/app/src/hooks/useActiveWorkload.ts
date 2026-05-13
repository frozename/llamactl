import { trpc } from '@/lib/trpc';

type WorkloadRow = {
  name?: string;
  spec?: { enabled?: boolean };
  status?: { phase?: string | null } | null;
};

export function useActiveWorkload(): { workload: string | null; loading: boolean } {
  const query = trpc.workloadList.useQuery(undefined, { refetchInterval: 5_000 });
  if (query.isLoading) return { workload: null, loading: true };
  const live = (query.data ?? []).filter(
    (m: WorkloadRow) => m.spec?.enabled !== false && (!m.status || m.status.phase === 'Running' || m.status.phase === 'Pending'),
  );
  if (live.length !== 1) return { workload: null, loading: false };
  return { workload: live[0]?.name ?? null, loading: false };
}
