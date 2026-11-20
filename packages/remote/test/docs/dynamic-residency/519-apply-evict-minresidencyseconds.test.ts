import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

// Part of #519
// Kills: shipping the apply --evict min-residency gate undocumented, or
// documenting EvictMinResidency / EvictMinResidencyUnknown without the
// checkEvictMinResidency gate in apply.ts.
describe("#519 apply --evict minResidencySeconds", () => {
  test("knobs section documents the gate and apply.ts implements it", () => {
    const knobs = flat(sectionBody(SECTIONS.knobs) ?? "");
    for (const pin of [
      "`--evict`",
      "`EvictMinResidency`",
      "`EvictMinResidencyUnknown`",
      "`LLAMACTL_NODE_NAME`",
    ]) {
      expect(knobs, `knobs section pin ${pin}`).toContain(pin);
    }
    const gate = enclosingBody(
      readOrEmpty(join(REPO, "packages/remote/src/workload/apply.ts")),
      "function checkEvictMinResidency(",
    );
    for (const pin of ["minResidencySeconds", "EvictMinResidency"]) {
      expect(gate, `checkEvictMinResidency pin ${pin}`).toContain(pin);
    }
  });
});
