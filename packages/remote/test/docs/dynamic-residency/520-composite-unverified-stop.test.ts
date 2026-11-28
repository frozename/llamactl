import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #520
// Kills: undocumented unverifiable-stop behaviour, or doc and source drift —
// treating a bare stopped:false as a successful composite destroy/rollback,
// losing the exact operator message, or keeping the stale "no fence reason"
// carve-out after the stop can no longer prove the pid identity.
describe("#520 composite unverified stop documentation", () => {
  test("D1: unverifiable composite stops are documented in session affinity", () => {
    const body = sectionBody(sectionRe("session affinity"));
    expect(body).toBeDefined();
    const s = flat(body ?? "");
    for (const needle of [
      "returns a bare `stopped: false` without a `refused` detail",
      "`serverStop on <node> refused (pid identity unverifiable); composite manifest preserved`",
      "rollback failed for workload/<node>: serverStop on <node> refused (pid identity unverifiable); workload left running",
      "remove its stale pid record, then re-run the destroy",
      "A transport error is still swallowed as before.",
    ]) {
      expect(s, needle).toContain(needle);
    }
  });

  test("D2: the retired no-fence-reason carve-out is gone", () => {
    const body = sectionBody(sectionRe("session affinity"));
    expect(body).toBeDefined();
    const s = flat(body ?? "");
    expect(s).not.toContain("a stop with no fence reason is still swallowed");
  });
});

describe("#520 composite unverified stop source pins", () => {
  test("D3: composite apply source carries the unverifiable-stop pin", () => {
    const applySrc = readOrEmpty(join(REPO, "packages/remote/src/composite/apply.ts"));
    expect(applySrc).toContain("(pid identity unverifiable)");
    expect(applySrc).not.toContain("is NOT a fence refusal — remaining");
  });
});
