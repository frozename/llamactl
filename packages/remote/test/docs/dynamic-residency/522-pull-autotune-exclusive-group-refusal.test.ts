import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #522
// Kills: the doc sentences missing or reworded; the launchRefusal gate absent
// or placed after the bench call in maybeTuneAfterPull
// (packages/core/src/autotune.ts); `"launch-refused"` missing from
// MaybeTuneSkipReason; the autotuneAfterPull subscription procedure
// (packages/remote/src/router.ts) or the CLI local branch
// runAutotuneAfterPull (packages/cli/src/commands/pull.ts) dropping
// `launchRefusal: benchLaunchRefusal`.
describe("#522 pull auto-tune exclusive-group refusal", () => {
  test("doc and source pin the pre-spawn launchRefusal gate on the post-pull auto-tune", () => {
    const section = flat(sectionBody(sectionRe("direct modelhost start and stop")) ?? "");
    expect(section).toContain(
      "`llamactl pull file` and `llamactl pull candidate` run the post-pull auto-tune through `maybeTuneAfterPull` (`packages/core/src/autotune.ts`): before `benchPreset` spawns `llama-bench` the tune consults `launchRefusal` — `launch-refused` joins `MaybeTuneSkipReason.kind` — and a refusal records the preset step as skipped with kind `launch-refused` and the refusal message, leaves the vision step `Not evaluated`, and spawns no bench, while a `null` return tunes as before.",
    );
    expect(section).toContain(
      "Both the local branch in `runAutotuneAfterPull` (`packages/cli/src/commands/pull.ts`) and the `autotuneAfterPull` subscription procedure (`packages/remote/src/router.ts`) pass `launchRefusal: benchLaunchRefusal`, the same read-only, unfenced gate the bench verbs use, so the pull auto-tune refuses an occupied declared-exclusive group as `Auto-tune skipped: residency lifecycle refused <rel> downloaded -> loading: ExclusiveGroupOccupied: exclusive group <group> is held by <member> in state <state>` and an in-flight profile switch as `Auto-tune skipped: residency lifecycle refused <rel>: profile switch in flight on this node; retry after it settles` instead of spawning beside the holder, and a node with no store file, a rel with no group and a clear gate spawn the bench as before (#522).",
    );

    const autotuneSrc = readOrEmpty(join(REPO, "packages/core/src/autotune.ts"));

    const tuneBody = enclosingBody(autotuneSrc, "export async function maybeTuneAfterPull(");
    expect(tuneBody, "maybeTuneAfterPull body").not.toBe("");
    const tuneGateAt = tuneBody.indexOf("launchRefusal");
    expect(tuneGateAt, "maybeTuneAfterPull consults launchRefusal").toBeGreaterThanOrEqual(0);
    expect(tuneGateAt).toBeLessThan(tuneBody.indexOf("await benchPreset("));

    const skipBody = enclosingBody(autotuneSrc, "export interface MaybeTuneSkipReason");
    expect(skipBody, "MaybeTuneSkipReason body").not.toBe("");
    expect(skipBody, "MaybeTuneSkipReason lists launch-refused").toContain('"launch-refused"');

    const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    const tuneStart = routerSrc.indexOf("autotuneAfterPull: t.procedure");
    const tuneEnd = routerSrc.indexOf("pullFile: t.procedure", tuneStart);
    const tuneBlock = tuneStart === -1 || tuneEnd === -1 ? "" : routerSrc.slice(tuneStart, tuneEnd);
    expect(tuneBlock, "autotuneAfterPull passes launchRefusal").toContain(
      "launchRefusal: benchLaunchRefusal",
    );

    const pullSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/pull.ts"));
    const pullTuneBody = enclosingBody(pullSrc, "async function runAutotuneAfterPull(");
    expect(pullTuneBody, "runAutotuneAfterPull body").not.toBe("");
    expect(pullTuneBody, "runAutotuneAfterPull passes launchRefusal").toContain(
      "launchRefusal: benchLaunchRefusal",
    );
  });
});
