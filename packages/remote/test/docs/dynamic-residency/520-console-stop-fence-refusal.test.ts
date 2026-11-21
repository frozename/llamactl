import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #520
// Kills: undocumented behaviour, or doc and source drift — the Stop
// dialog ignoring result.refused and falling back to the pid-identity
// text, a fence refusal toasting or closing the dialog, the doc dropping
// the console paragraph, or documenting a fence the code does not
// implement.
describe("#520 console stop-dialog fence refusal", () => {
  test("case: console stop fence refusal is documented and implemented", () => {
    const body = sectionBody(sectionRe("session affinity"));
    expect(body).toBeDefined();
    const s = flat(body ?? "");
    for (const needle of [
      "web console Stop dialog",
      "`stopResultMessage`",
      "`packages/app/src/console/actions/stop-server-model.ts`",
      "Stop refused by the node's stop fence (<reason>: <ids>); nothing was stopped",
      "does not release sessions",
    ]) {
      expect(s, needle).toContain(needle);
    }

    const src = readOrEmpty(join(REPO, "packages/app/src/console/actions/stop-server-model.ts"));
    for (const pin of ["refused by the node's stop fence", "result.refused"]) {
      expect(src, pin).toContain(pin);
    }
  });
});
