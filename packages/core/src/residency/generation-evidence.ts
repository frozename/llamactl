/**
 * Pure generation evidence for managed admission. Given a recorded
 * generation (the claim's pid), a pid file state, and a live process
 * observation, decide whether the process is the same generation,
 * a different (reused) generation, verified absent, or uncertain.
 *
 * Identity is judged by shared fields: a field is SHARED when it is
 * defined on both the record and the observation.  Consistent = at
 * least one shared field AND every shared field is equal.  For a
 * same-pid observation: alive && consistent -> same-generation;
 * alive && !consistent -> { kind: 'different-generation', reason:
 * 'pid-reused' }; dead && consistent -> verified-absent; dead &&
 * !consistent -> { kind: 'uncertain', reason: 'unidentified-absence' }.
 *
 * No I/O — inputs are plain objects, output is a verdict.
 */

export type ProcessObservation = {
  pid: number;
  alive: boolean;
  startTimeMs?: number | undefined;
  executable?: string | undefined;
};

export type GenerationRecord = {
  pid: number;
  startTimeMs?: number | undefined;
  executable?: string | undefined;
};

export type GenerationVerdict =
  | { kind: "same-generation" }
  | { kind: "verified-absent" }
  | { kind: "different-generation"; reason: string }
  | { kind: "uncertain"; reason: string };

function identityMatches(recorded: GenerationRecord, observation: ProcessObservation): boolean {
  const sharedFields: (keyof Pick<GenerationRecord, "startTimeMs" | "executable">)[] = [];
  if (recorded.startTimeMs !== undefined && observation.startTimeMs !== undefined) {
    sharedFields.push("startTimeMs");
  }
  if (recorded.executable !== undefined && observation.executable !== undefined) {
    sharedFields.push("executable");
  }
  if (sharedFields.length === 0) {
    return false;
  }
  return sharedFields.every((field) => recorded[field] === observation[field]);
}

function isAlive(observation: ProcessObservation): boolean {
  return observation.alive;
}

function pidMatches(recorded: GenerationRecord, observation: ProcessObservation): boolean {
  return observation.pid === recorded.pid;
}

export function judgeGeneration(input: {
  recorded: GenerationRecord | undefined;
  pidFilePid: number | undefined;
  observation: ProcessObservation | undefined;
}): GenerationVerdict {
  // Deep-clone inputs to guarantee no mutation
  const recorded = input.recorded
    ? {
        pid: input.recorded.pid,
        startTimeMs: input.recorded.startTimeMs,
        executable: input.recorded.executable,
      }
    : undefined;
  const pidFilePid = input.pidFilePid;
  const observation = input.observation
    ? {
        pid: input.observation.pid,
        alive: input.observation.alive,
        startTimeMs: input.observation.startTimeMs,
        executable: input.observation.executable,
      }
    : undefined;

  // Rule 1: No recorded generation → uncertain
  if (!recorded) {
    return { kind: "uncertain", reason: "no-recorded-generation" };
  }

  // Rule 2: No observation → uncertain (regardless of pidFilePid)
  if (!observation) {
    return { kind: "uncertain", reason: "no-observation" };
  }

  // Observation is for the recorded pid
  if (pidMatches(recorded, observation)) {
    return judgeSamePid(recorded, observation);
  }

  // Observation is for a DIFFERENT pid than recorded
  return { kind: "uncertain", reason: "no-observation-for-recorded-pid" };
}

function judgeSamePid(
  recorded: GenerationRecord,
  observation: ProcessObservation,
): GenerationVerdict {
  if (isAlive(observation)) {
    // Rule 3: Same pid, alive — consistent identity (all shared fields match)
    if (identityMatches(recorded, observation)) {
      return { kind: "same-generation" };
    }
    return { kind: "different-generation", reason: "pid-reused" };
  }
  // Same pid but not alive
  // Rule 4: Not alive, consistent identity → verified-absent
  if (identityMatches(recorded, observation)) {
    return { kind: "verified-absent" };
  }
  // Not alive, inconsistent or no shared identity → uncertain
  return { kind: "uncertain", reason: "unidentified-absence" };
}
