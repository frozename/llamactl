import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

const q = flat(sectionBody(/^## Qualification and promotion/) ?? "");

describe("#518 embersynth degraded node priority doc", () => {
  test("D1: qualification docs pin degraded fusion-node priority demotion", () => {
    for (const needle of [
      "a fusion node whose `modelId` fell back to a degraded rel is advertised at priority 9",
      "behind every healthy bench band",
    ]) {
      expect(q).toContain(needle);
    }
  });

  test("D2: the embersynth generator names the degraded node priority constant", () => {
    expect(readOrEmpty(join(REPO, "packages/remote/src/config/embersynth.ts"))).toContain(
      "DEGRADED_NODE_PRIORITY",
    );
  });
});
