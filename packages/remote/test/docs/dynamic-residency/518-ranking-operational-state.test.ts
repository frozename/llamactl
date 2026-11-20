import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

// Part of #518
// Kills: shipping the operational-state ranking signal undocumented, or
// documenting operationalState/effectiveStage without the
// residency-ranking.ts and ranking.ts wiring.
describe("#518 ranking operational state", () => {
  test("knobs section documents the operationalState signal and the source wires it", () => {
    const knobs = flat(sectionBody(SECTIONS.knobs) ?? "");
    for (const pin of [
      "`operationalState`",
      "`draining`",
      "`unloading`",
      "`failed`",
      "effectiveStage",
    ]) {
      expect(knobs, `knobs section pin ${pin}`).toContain(pin);
    }
    expect(readOrEmpty(join(REPO, "packages/remote/src/proxy/residency-ranking.ts"))).toContain(
      "operationalState",
    );
    expect(readOrEmpty(join(REPO, "packages/core/src/routing/ranking.ts"))).toContain(
      "operationalState",
    );
  });
});
