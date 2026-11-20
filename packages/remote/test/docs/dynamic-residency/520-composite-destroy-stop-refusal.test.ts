import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #520
// Kills: undocumented behaviour, or doc and source drift — dropping the
// refusal check from destroyComposite, the router deleting the composite
// YAML unconditionally (router.ts compositeDestroy), the CLI losing the
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
    ]) {
      expect(s, needle).toContain(needle);
    }

    const applySrc = readOrEmpty(join(REPO, "packages/remote/src/composite/apply.ts"));
    for (const pin of ["composite manifest preserved", "manifestPreserved"]) {
      expect(applySrc, pin).toContain(pin);
    }
    const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    expect(routerSrc, "result.manifestPreserved").toContain("result.manifestPreserved");
    const cliSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/composite.ts"));
    expect(cliSrc, "not destroyed: a workload stop was refused; manifest preserved").toContain(
      "not destroyed: a workload stop was refused; manifest preserved",
    );
  });
});
