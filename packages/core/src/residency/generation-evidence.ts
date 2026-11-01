/**
 * Pure generation evidence for managed admission. Given a recorded
 * generation (the claim's pid), a pid file state, and a live process
 * observation, decide whether the process is the same generation,
 * a different (reused) generation, verified absent, or uncertain.
 *
 * No I/O — inputs are plain objects, output is a verdict.
 */

export type ProcessObservation = {
  pid: number;
  alive: boolean;
  startTimeMs?: number;
  executable?: string;
};

export type GenerationRecord = {
  pid: number;
  startTimeMs?: number;
  executable?: string;
};

export type GenerationVerdict =
  | { kind: "same-generation" }
  | { kind: "verified-absent" }
  | { kind: "different-generation"; reason: string }
  | { kind: "uncertain"; reason: string };

export function judgeGeneration(input: {
  recorded: GenerationRecord | undefined;
  pidFilePid: number | undefined;
  observation: ProcessObservation | undefined;
}): GenerationVerdict {
  // Deep-clone inputs to guarantee no mutation
  const recorded = input.recorded
    ? { pid: input.recorded.pid, startTimeMs: input.recorded.startTimeMs, executable: input.recorded.executable }
    : undefined;
  const pidFilePid = input.pidFilePid;
  const observation = input.observation
    ? { pid: input.observation.pid, alive: input.observation.alive, startTimeMs: input.observation.startTimeMs, executable: input.observation.executable }
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
  if (observation.pid === recorded.pid) {
    if (observation.alive) {
      // Rule 3: Same pid, alive — check startTimeMs and executable
      if (
        (recorded.startTimeMs !== undefined &&
          observation.startTimeMs !== undefined &&
          recorded.startTimeMs !== observation.startTimeMs) ||
        (recorded.executable !== undefined &&
          observation.executable !== undefined &&
          recorded.executable !== observation.executable)
      ) {
        return { kind: "different-generation", reason: "pid-reused" };
      }
      return { kind: "same-generation" };
    }
    // Same pid but not alive
    // Rule 4: Not alive, but has identifying info → verified-absent
    if (observation.startTimeMs !== undefined || observation.executable !== undefined) {
      return { kind: "verified-absent" };
    }
    // Not alive, no identifying info → uncertain
    return { kind: "uncertain", reason: "unidentified-absence" };
  }

  // Observation is for a DIFFERENT pid than recorded
  if (observation.alive) {
    // The recorded pid process is not being observed alive.
    // But the observation is for a different pid, so we cannot
    // positively identify that the recorded process is absent
    // based on this observation alone (unless the observation
    // has identifying info matching the recorded process — but
    // the pid differs, so it can't be the same process).
    // If we have a startTimeMs or executable on the observation
    // that matches the recorded generation, that would be
    // impossible since the pid differs — so this is uncertain.
    return { kind: "uncertain", reason: "no-observation-for-recorded-pid" };
  }

  // Observation is alive but for a different (dead) pid
  // The recorded process might still be alive under its own pid
  // (no observation for it), or might have died. Uncertain.
  return { kind: "uncertain", reason: "no-observation-for-recorded-pid" };
}
