import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #517
// Kills: the doc sentences missing or reworded; the eval/admit guards
// absent or placed after ensureEvalRoot()/runMeasureAttempt( (the spawn
// already ran, $DEV_STORAGE/eval exists, the marker binary executed);
// exclusiveGroupLaunchRefusal missing from direct-lifecycle.ts.
describe("#517 sandbox launch exclusive-group refusal", () => {
  test("doc and source pin the pre-spawn exclusive-group refusal", () => {
    const section = flat(sectionBody(sectionRe("direct modelhost start and stop")) ?? "");
    expect(section).toContain(
      "`llamactl eval run <model>` without `--url` and `llamactl admit measure <workload>` spawn a sandbox engine in the CLI process and record no `residency_states` row, but before spawning they read the local residency store read-only through `exclusiveGroupLaunchRefusal` (`packages/remote/src/residency/direct-lifecycle.ts`) and exit 1 without spawning when the launch's declared-exclusive residency group is occupied (#517).",
    );
    expect(section).toContain(
      "`eval run` takes the group from the catalog row whose `rel` is `<model>`; `admit measure` takes the manifest's `llamactl.io/residency-group` label, falling back to the catalog row of its model rel.",
    );
    expect(section).toContain(
      "Any `loading`, `warming` or `ready` row in that group refuses, including a row for the same name, as `<command>: residency lifecycle refused <name> downloaded -> loading: ExclusiveGroupOccupied: exclusive group <group> is held by <member> in state <state>`; a nonterminal profile switch refuses with `profile switch in flight on this node; retry after it settles`, and an unreadable store refuses with `store unavailable (<message>)`.",
    );
    expect(section).toContain(
      "A node with no store file, a model with no group, and an undeclared or non-exclusive group launch as before. The check is read-only and unfenced, and it never reconciles a proven-down peer, so a stale `ready` row refuses until it is cleared (for example by `llamactl residency force-unload <workload> --reason <text> --yes` or the boot orphan sweep).",
    );

    const evalBody = enclosingBody(
      readOrEmpty(join(REPO, "packages/cli/src/commands/eval.ts")),
      "async function runEvalRun(",
    );
    expect(evalBody, "runEvalRun body").not.toBe("");
    const evalGuardAt = evalBody.indexOf("exclusiveGroupLaunchRefusal(");
    expect(evalGuardAt, "runEvalRun calls exclusiveGroupLaunchRefusal").toBeGreaterThanOrEqual(0);
    expect(evalGuardAt).toBeLessThan(evalBody.indexOf("ensureEvalRoot()"));

    const admitBody = enclosingBody(
      readOrEmpty(join(REPO, "packages/cli/src/commands/admit-measure.ts")),
      "export async function runAdmitMeasure(",
    );
    expect(admitBody, "runAdmitMeasure body").not.toBe("");
    const admitGuardAt = admitBody.indexOf("exclusiveGroupLaunchRefusal(");
    expect(
      admitGuardAt,
      "runAdmitMeasure calls exclusiveGroupLaunchRefusal",
    ).toBeGreaterThanOrEqual(0);
    expect(admitGuardAt).toBeLessThan(admitBody.indexOf("runMeasureAttempt("));

    expect(readOrEmpty(join(REPO, "packages/remote/src/residency/direct-lifecycle.ts"))).toContain(
      "export function exclusiveGroupLaunchRefusal(",
    );
  });
});
