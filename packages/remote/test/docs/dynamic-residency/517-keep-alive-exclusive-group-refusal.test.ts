import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #517
// Kills: missing or reworded doc sentences; a dropped worker wiring
// (runWorker not passing beforeStart); a gate placed after the spawn path
// (keepAliveLaunchRefusal called after process.execPath in runStart); the
// keepAliveLaunchRefusal helper missing exclusiveGroupLaunchRefusal; the
// start-refused state or pre-start gate failure log lines missing from
// packages/core/src/keepAlive.ts; runStart gating the raw target instead
// of the rel resolveTarget returns.
describe("#517 keep-alive exclusive-group refusal", () => {
  test("doc and source pin the keep-alive pre-spawn exclusive-group refusal", () => {
    const section = flat(sectionBody(sectionRe("direct modelhost start and stop")) ?? "");
    expect(section).toContain(
      "`llamactl keep-alive start <target>` spawns a detached supervisor whose worker records its own `residency_states` row under `<target>`, but before spawning it resolves `<target>` to a catalog rel and reads the local residency store read-only through `keepAliveLaunchRefusal` (`packages/cli/src/commands/keepAlive.ts`), ignoring only that target's own row and exiting 1 without spawning when another member of the rel's declared-exclusive residency group is occupied (#517).",
    );
    expect(section).toContain(
      "The rel comes from `resolveTarget` (`packages/core/src/target.ts`), the resolver the worker uses, so the default target `current` and aliases such as `best` are checked under the rel they resolve to and the refusal names that rel; a target that does not resolve skips the check and spawns as before, and the worker then records `resolve-failed`.",
    );
    expect(section).toContain(
      "`keepAliveLaunchRefusal` takes the group from the catalog row whose `rel` is the resolved target and delegates to `exclusiveGroupLaunchRefusal` (`packages/remote/src/residency/direct-lifecycle.ts`); the refusal prints as `keep-alive start: residency lifecycle refused <rel> downloaded -> loading: ExclusiveGroupOccupied: exclusive group <group> is held by <member> in state <state>`, with the same profile-switch and store-unavailable forms as the sandbox launches, and a node with no store file launches as before.",
    );
    expect(section).toContain(
      "The detached `keep-alive worker` re-runs the same gate through the worker's `beforeStart` hook before every start or restart: a refusal records state `start-refused` and appends `start-refused rel=<rel> reason=<refusal>` to the keep-alive log instead of `start-failed`, and a throwing hook records `pre-start gate failed (<message>)` as the reason.",
    );

    const cliSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/keepAlive.ts"));

    const workerBody = enclosingBody(cliSrc, "async function runWorker(");
    expect(workerBody, "runWorker body").not.toBe("");
    expect(workerBody).toContain("beforeStart");

    const startBody = enclosingBody(cliSrc, "async function runStart(");
    expect(startBody, "runStart body").not.toBe("");
    const gateAt = startBody.indexOf("keepAliveLaunchRefusal(");
    expect(gateAt, "runStart calls keepAliveLaunchRefusal").toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeLessThan(startBody.indexOf("process.execPath"));
    const resolveAt = startBody.indexOf("targetMod.resolveTarget(target)");
    expect(resolveAt, "runStart resolves the target").toBeGreaterThanOrEqual(0);
    expect(resolveAt).toBeLessThan(gateAt);

    const helperBody = enclosingBody(cliSrc, "function keepAliveLaunchRefusal(");
    expect(helperBody, "keepAliveLaunchRefusal body").not.toBe("");
    expect(helperBody).toContain("exclusiveGroupLaunchRefusal(");

    const coreSrc = readOrEmpty(join(REPO, "packages/core/src/keepAlive.ts"));
    expect(coreSrc).toContain("start-refused rel=");
    expect(coreSrc).toContain("pre-start gate failed (");
  });
});
