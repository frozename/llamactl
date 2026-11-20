import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #517
// Kills: documenting the pid-file-only rule or keeping the 'remaining
// scope' claim; isServerProvenDown that reaps the pid file, drops the
// trackedStopIdentity expectation, or counts 'unknown' as proven down.
describe("#517 identity-based ModelRun proof", () => {
  test("doc and source pin the identity-based ModelRun proof", () => {
    const section = flat(sectionBody(sectionRe("direct modelhost start and stop")) ?? "");
    expect(section).toContain(
      "ModelRun proof uses `isServerProvenDown` (`packages/core/src/server.ts`), which checks the recorded pid against its pid file with the same identity check `stopServer` uses and never deletes the pid file; agent boot recovery uses the same predicate through `directWorkloadProvenDown`.",
    );
    expect(section).not.toContain("identity-based ModelRun proof is remaining scope");

    const body = enclosingBody(
      readOrEmpty(join(REPO, "packages/core/src/server.ts")),
      "export function isServerProvenDown(",
    );
    expect(body, "isServerProvenDown").not.toBe("");
    for (const pin of ["isRecordedPidGone(", "trackedStopIdentity(resolved, key, identity)"]) {
      expect(body, `isServerProvenDown ${pin}`).toContain(pin);
    }
    expect(body).not.toContain("removeServerPid(");
  });
});
