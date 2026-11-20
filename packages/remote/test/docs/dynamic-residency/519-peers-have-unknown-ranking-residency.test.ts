import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { expectPins, flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

// Part of #519
// Kills: shipping the peer-unknown-residency ranking rule undocumented, or
// documenting residencyKnown without the residency-ranking.ts and
// ranking.ts wiring, or keeping the "all peers rank as non-resident" claim.
describe("#519 peers have unknown ranking residency", () => {
  test("knobs section documents residencyKnown and the source wires it", () => {
    expect(sectionBody(SECTIONS.knobs)).toBeDefined();
    const knobs = flat(sectionBody(SECTIONS.knobs) ?? "");
    expectPins(knobs, "peer residency", [
      "`residencyKnown`",
      "a peer candidate has unknown residency",
      "`coldLoadPenaltyMs` and the default expected-load cost never charge a peer and `residentPreference` never rewards one",
      "so a peer candidate outranks a local candidate that has no `ready` lifecycle row (for example one started by a plain apply) by that candidate's expected-load cost plus `coldLoadPenaltyMs`",
      "A caller that passes `resident` without `residencyKnown` keeps the old behaviour",
    ]);
    expect(knobs).not.toContain("and all peers, rank as non-resident");
    expect(readOrEmpty(join(REPO, "packages/remote/src/proxy/residency-ranking.ts"))).toContain(
      "residencyKnown",
    );
    expect(readOrEmpty(join(REPO, "packages/core/src/routing/ranking.ts"))).toContain(
      "residencyKnown",
    );
  });
});
