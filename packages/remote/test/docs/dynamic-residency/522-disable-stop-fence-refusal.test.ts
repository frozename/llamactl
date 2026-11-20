import { describe, test } from "bun:test";

import { expectPins, flat, sectionBody, sectionRe } from "./helpers.js";

// Part of #522
// Kills: shipping the disable stop-fence refusal undocumented in the
// session-affinity section, or rewording the existing #520 server
// stop/delete workload sentence the new prose extends. The new sentence
// fails on the base because the section does not carry it yet; the #520
// pin guards the sentence it sits beside.
describe("#522 disable stop-fence refusal", () => {
  const affinity = flat(sectionBody(sectionRe("session affinity")) ?? "");

  test("session affinity documents the disable refusal beside the #520 sentence", () => {
    expectPins(affinity, "session affinity", [
      "`llamactl disable <workload>` reports the same refusal: it exits 1 with `disable: serverStop refused: <reason>: <ids>` for a ModelRun (the `: <ids>` part is left out when no ids are reported) or `disable: modelHostStop refused: <reason>: <ids>` for a ModelHost, nothing is stopped, and the manifest stays stored with `spec.enabled: false` (Part of #522).",
      "`llamactl server stop` and `llamactl delete workload` report a node stop-fence refusal instead of a stop (#520).",
    ]);
  });
});
