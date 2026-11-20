import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #520
// Kills: undocumented behaviour, or doc and source drift — dropping the
// refusal check from destroyComposite, the router deleting the composite
// YAML unconditionally or dropping the returned manifestPreserved field
// (router.ts compositeDestroy, pinned separately), not recording the
// Degraded status on the kept YAML, the CLI losing the
// not-destroyed header, or documenting a fence the code does not
// implement.
describe("#520 composite destroy stop-fence refusal", () => {
  test("case: composite destroy stop-fence refusal is documented and implemented", () => {
    const body = sectionBody(sectionRe("session affinity"));
    expect(body).toBeDefined();
    const s = flat(body ?? "");
    for (const needle of [
      "`llamactl composite destroy`",
      "`destroyComposite`",
      "`packages/remote/src/composite/apply.ts`",
      "serverStop on <node> refused (<reason>: <ids>); composite manifest preserved",
      "composite/<name> not destroyed: a workload stop was refused; manifest preserved",
      "`manifestPreserved`",
      "rewrites its `status` to record the partial destroy (`phase: Degraded`",
      "returns `manifestPreserved: true`",
      "deletes the YAML and returns `manifestPreserved: false`",
    ]) {
      expect(s, needle).toContain(needle);
    }

    const applySrc = readOrEmpty(join(REPO, "packages/remote/src/composite/apply.ts"));
    for (const pin of ["composite manifest preserved", "manifestPreserved"]) {
      expect(applySrc, pin).toContain(pin);
    }
    const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    // The keep-or-delete guard and the returned field are pinned
    // separately, so dropping either one fails its own pin.
    for (const pin of [
      "if (result.manifestPreserved) {",
      'phase: "Degraded",',
      "deleteComposite(input.name);",
      "manifestPreserved: result.manifestPreserved,",
    ]) {
      expect(routerSrc, pin).toContain(pin);
    }
    const cliSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/composite.ts"));
    expect(cliSrc, "not destroyed: a workload stop was refused; manifest preserved").toContain(
      "not destroyed: a workload stop was refused; manifest preserved",
    );
  });
});
