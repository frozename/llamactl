/**
 * #335 test-only pin: the eviction hold rules exported by the workload
 * apply layer. parseEvictTargets reads the victim list off the
 * `llamactl.io/evict` annotation, trimming blanks and dropping empty
 * segments. replacementHoldsEviction is the ownership test the
 * reconciler guard and apply share: inside the grace window a missing
 * replacement still holds (apply -f marks victims before the
 * replacement manifest lands) but a present one must be enabled; past
 * the grace window the hold needs a live enabled replacement that still
 * names the victim.
 *
 * Mutation that kills it: in replacementHoldsEviction, drop
 * `&& namesVictim` from the past-grace branch; the "after grace an
 * enabled replacement holding must name the victim" test fails.
 */
import { describe, expect, test } from "bun:test";

import { parseEvictTargets, replacementHoldsEviction } from "../../src/workload/apply.js";
import { type ModelRun, ModelRunSchema } from "../../src/workload/schema.js";

type ModelRunInput = {
  name?: string;
  enabled?: boolean;
  evict?: string;
};

function modelRun(input: ModelRunInput): ModelRun {
  const annotations = input.evict === undefined ? {} : { "llamactl.io/evict": input.evict };
  const spec: Record<string, unknown> = { node: "auto", target: { kind: "rel", value: "m.gguf" } };
  if (input.enabled !== undefined) spec["enabled"] = input.enabled;
  return ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name: input.name ?? "replacement-run", annotations },
    spec,
  });
}

describe("parseEvictTargets", () => {
  test("returns an empty list when the annotation is absent", () => {
    expect(parseEvictTargets(modelRun({}))).toEqual([]);
  });

  test("returns an empty list for an empty annotation", () => {
    expect(parseEvictTargets(modelRun({ evict: "" }))).toEqual([]);
  });

  test("splits a comma-separated list", () => {
    expect(parseEvictTargets(modelRun({ evict: "victim-a,victim-b" }))).toEqual([
      "victim-a",
      "victim-b",
    ]);
  });

  test("trims whitespace around each target", () => {
    expect(parseEvictTargets(modelRun({ evict: " victim-a , victim-b " }))).toEqual([
      "victim-a",
      "victim-b",
    ]);
  });

  test("drops empty segments from stray or trailing commas", () => {
    expect(parseEvictTargets(modelRun({ evict: "victim-a,,victim-b," }))).toEqual([
      "victim-a",
      "victim-b",
    ]);
  });
});

describe("replacementHoldsEviction", () => {
  test("within grace a missing replacement still holds", () => {
    expect(replacementHoldsEviction(undefined, true, false)).toBe(true);
  });

  test("within grace an enabled replacement holds even without naming the victim", () => {
    expect(replacementHoldsEviction(modelRun({ enabled: true }), true, false)).toBe(true);
  });

  test("within grace a disabled replacement releases the hold", () => {
    expect(replacementHoldsEviction(modelRun({ enabled: false }), true, true)).toBe(false);
  });

  test("after grace a missing replacement releases the hold", () => {
    expect(replacementHoldsEviction(undefined, false, true)).toBe(false);
  });

  test("after grace an enabled replacement holding must name the victim", () => {
    expect(replacementHoldsEviction(modelRun({ enabled: true }), false, true)).toBe(true);
    expect(replacementHoldsEviction(modelRun({ enabled: true }), false, false)).toBe(false);
  });

  test("after grace a disabled replacement releases even when it names the victim", () => {
    expect(replacementHoldsEviction(modelRun({ enabled: false }), false, true)).toBe(false);
  });
});
