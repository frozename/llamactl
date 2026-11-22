import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

// Part of #518
// Kills: shipping the in-flight load credit undocumented, or documenting
// expectedLoadMs without the residency-ranking.ts wiring.
describe("#518 ranking in-flight load credit", () => {
  test("knobs section documents the credit and residency-ranking.ts wires it", () => {
    const knobs = flat(sectionBody(SECTIONS.knobs) ?? "");
    for (const pin of [
      "the residency store's lifecycle rows also feed the ranker's `expectedLoadMs` signal",
      "a local candidate whose lifecycle row is `loading` or `warming` is charged only the remaining expected load",
      "a row whose elapsed time has reached that default keeps the full default",
    ]) {
      expect(knobs, `knobs section pin ${pin}`).toContain(pin);
    }
    const src = readOrEmpty(join(REPO, "packages/remote/src/proxy/residency-ranking.ts"));
    expect(src, "residency-ranking.ts pin inFlightLoadSignal").toContain("inFlightLoadSignal");
    expect(src, "residency-ranking.ts pin expectedLoadMs").toContain("expectedLoadMs");
  });
});
