import type { PerfSuiteOptions } from "./runner.js";

/** Named perf-suite presets for `bench schedule add --kind suite`. The
 *  id is stored on the schedule; the preset pins the two suite-size
 *  knobs while every other PerfSuiteOptions field (run_id, client,
 *  provenance) is filled per run by the CLI-side runner (#521). */
export const PERF_SUITE_IDS = ["perf-quick", "perf-full"] as const;

export type PerfSuiteId = (typeof PERF_SUITE_IDS)[number];

export type PerfSuitePreset = Required<
  Pick<PerfSuiteOptions, "decodeTokens" | "concurrencyPromptWords">
>;

export const PERF_SUITES: Record<PerfSuiteId, PerfSuitePreset> = {
  "perf-quick": { decodeTokens: 16, concurrencyPromptWords: 128 },
  "perf-full": { decodeTokens: 64, concurrencyPromptWords: 512 },
};

export function resolvePerfSuite(id: string): PerfSuitePreset {
  if (!Object.hasOwn(PERF_SUITES, id)) {
    throw new Error(`unknown perf suite '${id}' (known: ${PERF_SUITE_IDS.join(", ")})`);
  }
  return { ...PERF_SUITES[id as PerfSuiteId] };
}
