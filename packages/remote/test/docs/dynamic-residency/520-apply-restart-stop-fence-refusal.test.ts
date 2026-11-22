import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { expectPins, flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #520
// Kills: shipping the apply-restart stop-fence refusal undocumented,
// documenting it without the source change, or landing the refusal check
// outside convergeClaimedServer where startClaimedServer would already
// have run.
describe("#520 apply restart stop-fence refusal", () => {
  test("case: apply restart honours the node stop fence; doc and source stay pinned", () => {
    const body = sectionBody(sectionRe("stop-before-start refusals"));
    expect(body).toBeDefined();
    const s = flat(body ?? "");
    expectPins(s, "stop-before-start refusals", [
      "When `llamactl apply -f` or the controller restarts a running ModelRun whose spec changed, `convergeClaimedServer` in `packages/remote/src/workload/apply.ts` reads the agent's `serverStop` result first: a node stop-fence refusal (`LeasesActive`, `DrainInProgress`, `SessionsActive` or `SessionsUnknown`) leaves the server running its current spec, starts no workers and no replacement, and reports `serverStop refused: <reason>: <ids>` with a single `Applied=False/StopRefused` condition and phase `Running` (the `: <ids>` part is left out when no ids are reported). The restart never releases sessions; the overrides are `llamactl residency release-session <sessionId> --yes --node <name>` and `llamactl residency force-unload <workload> --reason <text> --yes --node <name>` (#520).",
    ]);

    const src = readOrEmpty(join(REPO, "packages/remote/src/workload/apply.ts"));
    const start = src.indexOf("async function convergeClaimedServer");
    const end = start === -1 ? -1 : src.indexOf("\n}\n", start);
    const converge = end === -1 ? "" : src.slice(start, end);
    expect(converge, "convergeClaimedServer body").toContain("serverStopFenceRefusal(");
  });
});
