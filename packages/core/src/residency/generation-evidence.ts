export type GenerationRecord = {
  pid: number;
  startTimeMs?: number | undefined;
  executable?: string | undefined;
};

export type ProcessObservation = GenerationRecord & { alive: boolean };

export type GenerationVerdict =
  | { kind: "same-generation" }
  | { kind: "verified-absent" }
  | { kind: "different-generation"; reason: string }
  | { kind: "uncertain"; reason: string };

export function judgeGeneration(input: {
  recorded: GenerationRecord | undefined;
  observation: ProcessObservation | undefined;
}): GenerationVerdict {
  const { recorded, observation } = input;
  if (recorded === undefined) return { kind: "uncertain", reason: "no-recorded-generation" };
  if (observation === undefined) return { kind: "uncertain", reason: "no-observation" };
  if (recorded.pid !== observation.pid) {
    return { kind: "uncertain", reason: "no-observation-for-recorded-pid" };
  }

  const timesShared = recorded.startTimeMs !== undefined && observation.startTimeMs !== undefined;
  const pathsShared = recorded.executable !== undefined && observation.executable !== undefined;
  const timeMatches = recorded.startTimeMs === observation.startTimeMs;
  const pathMatches = recorded.executable === observation.executable;
  const consistent = (!timesShared || timeMatches) && (!pathsShared || pathMatches);
  if (observation.alive) {
    return (timesShared || pathsShared) && consistent
      ? { kind: "same-generation" }
      : { kind: "different-generation", reason: "pid-reused" };
  }

  // PIDs can be reused by another instance of the same executable.
  const startTime = recorded.startTimeMs;
  return startTime !== undefined &&
    startTime > 0 &&
    Number.isFinite(startTime) &&
    timeMatches &&
    consistent
    ? { kind: "verified-absent" }
    : { kind: "uncertain", reason: "unidentified-absence" };
}
