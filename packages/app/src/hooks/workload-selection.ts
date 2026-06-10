export interface LiveWorkload {
  name: string;
  phase: "Running" | "Pending" | null;
}

export type WorkloadRow = {
  name?: string;
  spec?: { enabled?: boolean };
  status?: { phase?: string | null } | null;
};

export function getLiveWorkloads(rows: WorkloadRow[]): LiveWorkload[] {
  return rows
    .filter(
      (m) =>
        m.spec?.enabled !== false &&
        (!m.status || m.status.phase === "Running" || m.status.phase === "Pending"),
    )
    .map((m) => ({
      name: m.name ?? "",
      phase: (m.status?.phase as "Running" | "Pending" | null | undefined) ?? null,
    }))
    .filter((m) => m.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function selectActiveWorkload(selected: string | null, live: LiveWorkload[]): string | null {
  if (selected && live.some((w) => w.name === selected)) return selected;
  if (live.length > 0) return live[0]!.name;
  return null;
}
