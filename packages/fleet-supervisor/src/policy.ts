export function classifyFleetPressure(
  history: Array<{ freeMb: number; compressorMb: number }>,
  threshold: { freeMb: number; compressorMb: number; consecutiveTicks: number },
): { pressure: 'HIGH' | 'NORMAL' } {
  const tail = history.slice(-threshold.consecutiveTicks);
  const hot =
    tail.length === threshold.consecutiveTicks &&
    tail.every((row) => row.freeMb <= threshold.freeMb && row.compressorMb >= threshold.compressorMb);
  return { pressure: hot ? 'HIGH' : 'NORMAL' };
}

export function projectAdmissionHeadroom(input: {
  currentFreeGiB: number;
  expectedMemoryGiB: number;
  headroomMinGiB: number;
  safetyFactor?: number;
}): { projectedFreeGiB: number; allowed: true } | { projectedFreeGiB: number; allowed: false; reason: 'projected_free_below_headroom' } {
  const projectedFreeGiB = input.currentFreeGiB - input.expectedMemoryGiB * (input.safetyFactor ?? 1.3);
  if (projectedFreeGiB >= input.headroomMinGiB) {
    return { projectedFreeGiB, allowed: true };
  }
  return { projectedFreeGiB, allowed: false, reason: 'projected_free_below_headroom' };
}
