import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

describe("#520 ModelHost restart session fence", () => {
  // Part of #520: pins the stop-before-start section's ModelHost restart
  // fence — startModelHost must refuse a restart that would tear down a
  // live prior host while a session is bound or a lease is held, and the
  // source must carry the same refusal tail.
  // Kills: undocumented behaviour, or doc and source drift — dropping the
  // session/lease fence from startModelHost, renaming the refusal tails,
  // or documenting a fence the code does not implement.
  test("case: ModelHost restart session fence is documented and implemented", () => {
    const body = sectionBody(sectionRe("stop-before-start"));
    expect(body).toBeDefined();
    const s = flat(body ?? "");
    for (const needle of [
      "`startModelHost`",
      "`packages/remote/src/server/modelhost.ts`",
      "refusing to restart ModelHost <name> while a session is bound to its running instance",
      "refusing to restart ModelHost <name> while residency leases are held",
      "finds a live prior host",
    ]) {
      expect(s, needle).toContain(needle);
    }
    const src = readOrEmpty(join(REPO, "packages/remote/src/server/modelhost.ts"));
    for (const pin of [
      "while a session is bound to its running instance",
      "currentSessionRefcounts()",
    ]) {
      expect(src, pin).toContain(pin);
    }
  });
});
