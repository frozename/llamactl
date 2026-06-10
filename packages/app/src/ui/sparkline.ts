export function sparklineHeights(samples: readonly number[], maxHeight: number): number[] {
  if (samples.length === 0) return [];
  const max = Math.max(...samples);
  if (max === 0) return samples.map(() => Math.min(2, maxHeight));
  return samples.map((s) => {
    const raw = (s / max) * maxHeight;
    return Math.max(2, Math.round(raw));
  });
}
