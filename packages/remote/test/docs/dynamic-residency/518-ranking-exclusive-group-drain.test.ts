import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

// Part of #518
// Kills: shipping the exclusive-group drain signal undocumented, dropping
// the lifecycle-row-only limit from the doc, or documenting
// drainMs/RESIDENCY_GROUPS without the residency-ranking.ts wiring.
describe("#518 ranking exclusive-group drain", () => {
  test("knobs section documents the drain signal and residency-ranking.ts wires it", () => {
    const knobs = flat(sectionBody(SECTIONS.knobs) ?? "");
    for (const pin of [
      "`drainMs`",
      "`DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs`",
      "`RESIDENCY_GROUPS`",
      "a local candidate without a `ready` lifecycle row whose exclusive residency group is held by another member in `loading`, `warming` or `ready` is charged the profile-switch drain budget",
      "The drain charge applies only to a candidate with a lifecycle row tagged with the group; a candidate with no lifecycle row is never charged.",
    ]) {
      expect(knobs, `knobs section pin ${pin}`).toContain(pin);
    }
    const src = readOrEmpty(join(REPO, "packages/remote/src/proxy/residency-ranking.ts"));
    for (const pin of ["drainMs", "DEFAULT_PROFILE_SWITCH_TIMEOUTS"]) {
      expect(src, `residency-ranking.ts pin ${pin}`).toContain(pin);
    }
  });
});
