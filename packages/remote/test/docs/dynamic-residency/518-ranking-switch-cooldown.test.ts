import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

// Part of #518
// Kills: shipping the ranking switch-cooldown signal undocumented, or
// documenting cooldownUntil without the residency-ranking.ts wiring.
describe("#518 ranking switch cooldown", () => {
  test("knobs section documents the signal and residency-ranking.ts wires it", () => {
    const knobs = flat(sectionBody(SECTIONS.knobs) ?? "");
    for (const pin of [
      "`cooldownUntil`",
      "`switchCooldownSeconds`",
      "`lastSucceededAtMs`",
      "`profile-switch:<node>`",
    ]) {
      expect(knobs, `knobs section pin ${pin}`).toContain(pin);
    }
    const src = readOrEmpty(join(REPO, "packages/remote/src/proxy/residency-ranking.ts"));
    for (const pin of ["cooldownUntil", "profileSwitchOperationKey"]) {
      expect(src, `residency-ranking.ts pin ${pin}`).toContain(pin);
    }
  });
});
