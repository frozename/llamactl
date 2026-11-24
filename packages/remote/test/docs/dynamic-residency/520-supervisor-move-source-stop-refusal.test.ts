import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #520
// Kills: undocumented behaviour, or doc/source drift — the session-affinity
// section must describe the supervisor move's source stop-fence refusal and
// packages/cli/src/commands/supervisor.ts must carry the check.
describe("#520 supervisor move source stop-fence refusal", () => {
  test("session affinity documents the supervisor source-removal refusal; supervisor source carries the check", () => {
    const body = sectionBody(sectionRe("session affinity"));
    expect(body, "session affinity section").toBeDefined();
    const s = flat(body ?? "");

    for (const needle of [
      "`llamactl supervisor serve`",
      "`buildMigrationWorkloadOps`",
      "`packages/cli/src/commands/supervisor.ts`",
      "`workloadDelete`",
      "workloadDelete on <node> did not remove <workload>: <error>",
      "remove failed: ",
      "will retry",
      "`executed`",
      "never releases sessions",
    ]) {
      expect(s, needle).toContain(needle);
    }

    const src = readOrEmpty(join(REPO, "packages/cli/src/commands/supervisor.ts"));
    expect(src, "supervisor.ts did not remove").toContain("did not remove ");
    expect(src, "supervisor.ts workloadDelete on").toContain("workloadDelete on ");
  });
});
