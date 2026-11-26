import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #520
// Kills: undocumented rollback-refusal behaviour, or doc and source drift —
// dropping the rollback serverStop refusal check, losing the exact operator
// message, recording the still-running workload as stopped/Failed, releasing
// sessions as a side effect, or regressing the destroy path's preserved-
// manifest literal while adding the rollback fence.
describe("#520 composite rollback stop-fence refusal documentation", () => {
  test("case: rollback stop-fence refusal is documented in session affinity", () => {
    const body = sectionBody(sectionRe("session affinity"));
    expect(body).toBeDefined();
    const s = flat(body ?? "");
    for (const needle of [
      "`applyComposite`",
      "`onFailure: rollback`",
      "rollback failed for workload/<node>: serverStop on <node> refused (<reason>: <ids>); workload left running",
      "the `: <ids>` part is dropped when the list is empty",
      "keeps the component `Ready`",
      "never releases sessions",
    ]) {
      expect(s, needle).toContain(needle);
    }
  });
});

describe("#520 composite rollback stop-fence refusal source pins", () => {
  test("case: composite apply source carries rollback and destroy refusal pins", () => {
    const applySrc = readOrEmpty(join(REPO, "packages/remote/src/composite/apply.ts"));
    for (const pin of [
      "workload left running",
      "rollback failed for",
      "composite manifest preserved",
    ]) {
      expect(applySrc, pin).toContain(pin);
    }
  });
});
