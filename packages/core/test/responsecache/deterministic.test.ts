import { expect, test } from "bun:test";

import { isDeterministic } from "../../src/responsecache/deterministic.js";

test("temperature 0 is deterministic", () => {
  expect(isDeterministic({ temperature: 0, messages: [] })).toBe(true);
});

test("a finite numeric seed is deterministic", () => {
  expect(isDeterministic({ seed: 42 })).toBe(true);
  expect(isDeterministic({ temperature: 0.9, seed: 7 })).toBe(true);
});

test("a non-numeric seed at temperature>0 is NOT deterministic", () => {
  // A string seed is type-blind nonsense to the sampler — it must not be
  // treated as a fixed seed, or one sampled completion is replayed to every
  // byte-identical request.
  expect(isDeterministic({ temperature: 0.9, seed: "abc" })).toBe(false);
});

test("a NaN seed at temperature>0 is NOT deterministic", () => {
  expect(isDeterministic({ temperature: 0.9, seed: Number.NaN })).toBe(false);
});

test("an object seed at temperature>0 is NOT deterministic", () => {
  expect(isDeterministic({ temperature: 0.9, seed: {} })).toBe(false);
});

test("temperature>0 with no seed is NOT deterministic", () => {
  expect(isDeterministic({ temperature: 0.7 })).toBe(false);
});
