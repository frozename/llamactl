export function fmtTps(raw: string | undefined | null): string {
  if (raw === null || raw === undefined || raw === "") return "—";
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(1);
}
