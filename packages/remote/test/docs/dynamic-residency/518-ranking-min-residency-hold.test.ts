import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

// Part of #518
// Kills: shipping the min-residency ranking hold undocumented, or
// documenting cooldownUntil/minResidencySeconds without the
// residency-ranking.ts wiring.
describe("#518 ranking min-residency hold", () => {
  test("knobs section documents the hold and residency-ranking.ts wires it", () => {
    const knobs = flat(sectionBody(SECTIONS.knobs) ?? "");
    for (const pin of [
      "`minResidencySeconds` also feeds the ranker's `cooldownUntil` signal",
      "a local candidate without a `ready` lifecycle row whose exclusive residency group is held by another member in `ready` is charged until that member has been `ready` for `minResidencySeconds`",
      "the later of the switch cooldown and the min-residency hold",
    ]) {
      expect(knobs, `knobs section pin ${pin}`).toContain(pin);
    }
    const src = readOrEmpty(join(REPO, "packages/remote/src/proxy/residency-ranking.ts"));
    const partial = enclosingBody(src, "function toPartialResidencyPolicy(");
    const outsidePartial = partial === "" ? src : src.replace(partial, "");
    expect(
      outsidePartial,
      "residency-ranking.ts minResidencySeconds outside toPartialResidencyPolicy",
    ).toContain("minResidencySeconds");
    expect(src, "residency-ranking.ts pin minResidencyHoldSignal").toContain(
      "minResidencyHoldSignal",
    );
  });
});
