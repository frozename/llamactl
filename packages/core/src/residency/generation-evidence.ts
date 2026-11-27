export type GenerationRecord = {
  pid: number;
  birthId?: string | undefined;
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

  return recorded.birthId === undefined
    ? judgeLegacyBirth(recorded, observation)
    : judgeNativeBirth(recorded.birthId, observation);
}

function judgeLegacyBirth(
  recorded: GenerationRecord,
  observation: ProcessObservation,
): GenerationVerdict {
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

function judgeNativeBirth(birthId: string, observation: ProcessObservation): GenerationVerdict {
  if (observation.birthId === undefined) {
    return { kind: "uncertain", reason: "birth-identity-unavailable" };
  }
  if (birthId !== observation.birthId) {
    return observation.alive
      ? { kind: "different-generation", reason: "pid-reused" }
      : { kind: "uncertain", reason: "unidentified-absence" };
  }
  return { kind: observation.alive ? "same-generation" : "verified-absent" };
}
