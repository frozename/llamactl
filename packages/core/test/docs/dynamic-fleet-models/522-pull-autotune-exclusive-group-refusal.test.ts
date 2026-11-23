import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #522 — RED test pinning the post-pull auto-tune launch refusal in
// docs/dynamic-fleet-models.md (the `### What `llamactl pull` does with a
// candidate row` subsection) and the wiring it describes.
//
// Kills: the new doc sentences missing or reworded; the #820 T6 auto-tune
// sentence dropped or edited; the launchRefusal gate absent or placed after
// `await benchPreset(` in maybeTuneAfterPull (packages/core/src/autotune.ts);
// `"launch-refused"` missing from MaybeTuneSkipReason; the CLI local branch
// runAutotuneAfterPull (packages/cli/src/commands/pull.ts) or the
// autotuneAfterPull subscription procedure (packages/remote/src/router.ts)
// dropping `launchRefusal: benchLaunchRefusal`.
describe("#522 pull auto-tune launch refusal", () => {
  test("doc and source pin the pre-spawn launchRefusal gate on the post-pull auto-tune", () => {
    const section = flat(sectionBody(/^### What `llamactl pull` does with a candidate row/) ?? "");
    expect(section).toContain(
      "`maybeTuneAfterPull` (`packages/core/src/autotune.ts`) consults `launchRefusal` immediately before `benchPreset` spawns `llama-bench` — `launch-refused` joins `MaybeTuneSkipReason.kind` — and a refusal string records the preset step as skipped with kind `launch-refused` and the refusal message, leaves the vision step `Not evaluated`, and spawns no bench, while a `null` return tunes exactly as before.",
    );
    expect(section).toContain(
      "Both the local branch in `runAutotuneAfterPull` (`packages/cli/src/commands/pull.ts`) and the `autotuneAfterPull` subscription procedure (`packages/remote/src/router.ts`) pass `launchRefusal: benchLaunchRefusal`, so the post-pull auto-tune reads the local residency store read-only through the same gate `llamactl bench` uses: an occupied declared-exclusive group prints `Auto-tune skipped: residency lifecycle refused <rel> downloaded -> loading: ExclusiveGroupOccupied: exclusive group <group> is held by <member> in state <state>`, an in-flight profile switch prints `Auto-tune skipped: residency lifecycle refused <rel>: profile switch in flight on this node; retry after it settles`, and a node with no store file, a rel with no group and a clear gate tune as before (#522).",
    );
    // The #820 candidate-row sentence must survive verbatim.
    expect(section).toContain(
      "`maybeTuneAfterPull` (`packages/core/src/autotune.ts`) runs the post-pull bench only when the file was absent before the pull — a re-pull skips with `Model was already on disk` — and only while `LLAMA_CPP_AUTO_TUNE_ON_PULL` is enabled, otherwise it skips with `LLAMA_CPP_AUTO_TUNE_ON_PULL=off`; `--no-tune` skips the call entirely (`packages/cli/src/commands/pull.ts`).",
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
