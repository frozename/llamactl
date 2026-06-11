export function fmtTps(raw: string | number | undefined | null): string {
  if (raw === null || raw === undefined) return "—";
  const n = typeof raw === "number" ? raw : Number.parseFloat(raw);
  return Number.isFinite(n) ? n.toFixed(1) : "—";
}
