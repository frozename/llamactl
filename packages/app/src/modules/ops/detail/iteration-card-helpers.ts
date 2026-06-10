import type { IterationView } from "../../../lib/use-ops-session";

export function statusGlyph(it: IterationView): string {
  const last = it.wet ?? it.preview;
  if (!last) return "·";
  return last.ok ? "✓" : "✗";
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
