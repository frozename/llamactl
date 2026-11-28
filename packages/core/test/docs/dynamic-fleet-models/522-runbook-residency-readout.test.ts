import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { OCCUPYING_RESIDENCY_STATES, RESIDENCY_GROUPS } from "../../../src/residency/lifecycle.js";
import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #522
// Kills: shipping the residency read-out without exclusive-window runbook
// prose, misplacing that prose outside steps 2 and 9, or letting it drift
// from the lifecycle renderer, stop bookkeeping, router wiring and
// force-unload limits it cites. Every doc-side case fails on the base
// because the runbook carries none of the new prose yet; the source guards
// already pass.
describe("#522 runbook residency read-out around the window", () => {
  const runbook = flat(sectionBody(/^## Exclusive-window runbook/) ?? "");

  const STEP2_RECORD =
    "Record the current state with `llamactl get workloads` and `llamactl residency status --node <node>`. Its `Lifecycle:` block lists the serving process's `residency_states` rows, one `<model>  <state>  group <group>  version <n>` line each, and its `Exclusive:` line reads `no violations` or `violation in <group>: <members>` (see [dynamic-residency.md](dynamic-residency.md#status-plan-and-apply-profile)).";
  const STEP2_GATE =
    "After production is stopped in step 3 and before step 6, run it again and open the window only when no other `z13-large-gpu` row occupies the group: in step 6 another `loading` or `warming` row, or a `ready` row whose workload is not proven down, refuses the start with `ExclusiveGroupOccupied`.";
  const STEP2_EMPTY =
    "A node with no residency store prints `Lifecycle:  0 workload(s) (scope: serving-process)` and `Exclusive:  no violations`; an unreadable store prints `Lifecycle:  unavailable (store unreadable; scope: serving-process)` or `Lifecycle:  unavailable (lifecycle rows unreadable; scope: serving-process)` and no `Exclusive:` line, and an agent that predates the section prints no `Lifecycle:` line.";
  const STEP9_CHECK =
    "After `llamactl disable <name>` and before `llamactl enable <production-workload>`, run `llamactl residency status --node <node>` again.";
  const STEP9_WALK =
    "A confirmed stop walks the window workload's row `ready` -> `draining` -> `unloading` -> `downloaded`, which frees `z13-large-gpu`, and a stop that throws walks it to `failed`, which does not occupy the group either.";
  const STEP9_UNCONFIRMED =
    "An unconfirmed stop (the process may still be alive) is never recorded: the agent logs `[residency] lifecycle <name> stop not recorded: unconfirmed stop (process may be alive)` and the row stays occupying, so a later same-group start is refused with `ExclusiveGroupOccupied` until the workload is proven down, and an `eval run` without `--url` keeps refusing while the row occupies.";
  const STEP9_OVERRIDE =
    "With the lease registry on (`LLAMACTL_RESIDENCY_LEASES`), `llamactl residency force-unload <name> --reason <text> --yes --node <node>` is the override: it runs the same stop, so it is confirmed only once the engine process is verified gone, and a confirmed force-unload walks the row to `downloaded` while an unconfirmed one keeps it occupying.";
  const STEP9_NO_REGISTRY =
    "Without the lease registry, force-unload exits with `residency force-unload: Unavailable: no residency lease registry installed; nothing to fence`, stops nothing and leaves the row as it is.";
  const STEP9_CLOSE =
    "Close the window when `Exclusive:` reads `no violations` and the window workload's row is not `loading`, `warming` or `ready`; a `ready` row left by an unconfirmed stop can be closed over only once its engine process is proven down, since it then no longer refuses a direct start but still refuses an `eval run` without `--url`.";

  const STEP2_SENTENCES = [STEP2_RECORD, STEP2_GATE, STEP2_EMPTY];
  const STEP9_SENTENCES = [
    STEP9_CHECK,
    STEP9_WALK,
    STEP9_UNCONFIRMED,
    STEP9_OVERRIDE,
    STEP9_NO_REGISTRY,
    STEP9_CLOSE,
  ];

  // Kills: omitting any part of the step-2 read-out, or citing file:line
  // anchors instead of stable prose.
  test("step 2 documents the residency read-out", () => {
    for (const sentence of STEP2_SENTENCES) {
      expect(runbook, sentence.slice(0, 60)).toContain(flat(sentence));
    }
    expect(/\.ts:\d/.test(runbook), "no file:line citation").toBe(false);
  });

  // Kills: placing the read-out outside step 2, where the operator records
  // state before stopping production.
  test("the step-2 sentences sit inside step 2", () => {
    const lo = runbook.indexOf("2. Record the current state");
    const hi = runbook.indexOf("3. Stop production");
    expect(lo, "step 2 anchor").toBeGreaterThanOrEqual(0);
    expect(hi, "step 3 anchor").toBeGreaterThan(lo);
    for (const sentence of STEP2_SENTENCES) {
      const at = runbook.indexOf(flat(sentence));
      expect(at, `missing: ${sentence.slice(0, 60)}`).toBeGreaterThanOrEqual(lo);
      expect(at, `missing: ${sentence.slice(0, 60)}`).toBeLessThan(hi);
    }
  });

  // Kills: omitting the step-9 verification, hiding the unconfirmed-stop
  // exception, or overstating what force-unload can override.
  test("step 9 documents the exit verification, the unconfirmed-stop exception and the override limits", () => {
    const exitIdx = runbook.indexOf("Exit the window");
    const neverIdx = runbook.indexOf("Never run two group members");
    expect(exitIdx, "step 9 anchor").toBeGreaterThanOrEqual(0);
    expect(neverIdx, "post-runbook warning anchor").toBeGreaterThanOrEqual(0);
    for (const sentence of STEP9_SENTENCES) {
      const flattened = flat(sentence);
      expect(runbook, sentence.slice(0, 60)).toContain(flattened);
      const at = runbook.indexOf(flattened);
      expect(at, `missing: ${sentence.slice(0, 60)}`).toBeGreaterThan(exitIdx);
      expect(at, `missing: ${sentence.slice(0, 60)}`).toBeLessThan(neverIdx);
    }
  });

  // Kills: linking a residency anchor that does not exist.
  test("the status anchor resolves", () => {
    expect(runbook, "status anchor link").toContain(
      "dynamic-residency.md#status-plan-and-apply-profile",
    );
    expect(readOrEmpty(join(REPO, "docs/dynamic-residency.md")), "status anchor heading").toContain(
      "## Status, plan and apply-profile",
    );
  });

  // Guard: the CLI renderer keeps the exact Lifecycle and Exclusive rows the
  // prose teaches the operator to read.
  test("source: residency CLI renders the documented lifecycle read-out", () => {
    const residencySrc = readOrEmpty(join(REPO, "packages/cli/src/commands/residency.ts"));
    const body = enclosingBody(residencySrc, "function pushLifecycleLines(");
    expect(body, "pushLifecycleLines signature").not.toBe("");
    for (const phrase of [
      "if (lifecycle === undefined)",
      '"store unreadable"',
      '"lifecycle rows unreadable"',
      "`Lifecycle:  unavailable (${detail}; scope: serving-process)`",
      "workload(s) (scope: serving-process)",
      'group ${w.group ?? "-"}  version ',
      '"Exclusive:  no violations"',
      "`Exclusive:  violation in ${v.group}: ",
    ]) {
      expect(body, phrase).toContain(phrase);
    }

    const usage = /const USAGE = `([\s\S]*?)`;/.exec(residencySrc)?.[1] ?? "";
    expect(usage, "status usage").toContain("status --node <name> [--json]");
    expect(usage, "force-unload usage").toContain(
      "force-unload <workload> --reason <text> --yes [--node <name>]",
    );
    expect(residencySrc, "force-unload refusal render").toContain(
      "`residency force-unload: ${result.reason}: ${result.detail}\\n`",
    );
  });

  // Guard: an absent store is an empty healthy lifecycle, while store and row
  // read failures keep their distinct unavailable reasons.
  test("source: lifecycle snapshot distinguishes absent, unreadable and row-unreadable stores", () => {
    const body = enclosingBody(
      readOrEmpty(join(REPO, "packages/remote/src/residency/procedures.ts")),
      "export function buildResidencyLifecycleSnapshot(",
    );
    expect(body, "buildResidencyLifecycleSnapshot signature").not.toBe("");
    expect(body).toContain("if (!store.present)");
    expect(body).toContain("workloads: [], exclusiveViolations: []");
    expect(body).toContain('"StoreUnreadable"');
    expect(body).toContain('"LifecycleUnreadable"');
  });

  // Guard: occupancy means exactly loading/warming/ready, and z13-large-gpu
  // remains the exclusive group named in the runbook.
  test("source: occupying states and z13-large-gpu exclusivity", () => {
    expect([...OCCUPYING_RESIDENCY_STATES]).toEqual(["loading", "warming", "ready"]);
    expect(RESIDENCY_GROUPS).toContainEqual({ name: "z13-large-gpu", exclusive: true });
  });

  // Guard: direct stops still fail closed on unconfirmed outcomes, while
  // proven-down ready rows stop corroborating occupancy.
  test("source: direct lifecycle stop bookkeeping and corroboration", () => {
    const dlSrc = readOrEmpty(join(REPO, "packages/remote/src/residency/direct-lifecycle.ts"));
    const stopWalk = enclosingBody(dlSrc, "async function walkStopAfterDep<");
    expect(stopWalk, "walkStopAfterDep signature").not.toBe("");
    expect(stopWalk).toContain("stop not recorded: unconfirmed stop (process may be alive)");
    expect(dlSrc).toContain("async function recordSettledStop<");
    expect(dlSrc).toContain("ready -> draining -> unloading -> downloaded");

    const corroborated = enclosingBody(dlSrc, "function isCorroboratedOccupant(");
    expect(corroborated, "isCorroboratedOccupant signature").not.toBe("");
    expect(corroborated).toContain(
      'return !(row.state === "ready" && isProvenDownSafe(opts, row.model));',
    );
    expect(corroborated).toContain("isOccupyingResidencyState(row.state)");
  });

  // Guard: both stop procedures keep the lease fence outside the direct
  // lifecycle stop, and the force-unload comment keeps the occupancy rule.
  test("source: router stop procedures keep fence and direct lifecycle wiring", () => {
    const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    const modelHostStopStart = routerSrc.indexOf("modelHostStop: t.procedure");
    const modelHostStopEnd = routerSrc.indexOf("modelHostStart: t.procedure");
    const serverStopStart = routerSrc.indexOf("serverStop: t.procedure");
    const serverStopEnd = routerSrc.indexOf(
      "DF-05 (#278): explicit operator override",
      serverStopStart,
    );
    expect(modelHostStopStart, "modelHostStop start").toBeGreaterThanOrEqual(0);
    expect(modelHostStopEnd, "modelHostStop end").toBeGreaterThanOrEqual(0);
    expect(serverStopStart, "serverStop start").toBeGreaterThanOrEqual(0);
    expect(serverStopEnd, "serverStop end").toBeGreaterThanOrEqual(0);

    const modelHostStop = routerSrc.slice(modelHostStopStart, modelHostStopEnd);
    const serverStop = routerSrc.slice(serverStopStart, serverStopEnd);
    expect(modelHostStop, "modelHostStop slice").not.toBe("");
    expect(serverStop, "serverStop slice").not.toBe("");
    for (const slice of [modelHostStop, serverStop]) {
      expect(slice).toContain("fenceWorkloadStop");
      expect(slice).toContain("runDirectResidencyStop");
    }
    expect(routerSrc).toContain("an unconfirmed one keeps the row occupying");
  });

  // Guard: without a lease registry force-unload is unavailable before it can
  // stop anything.
  test("source: force-unload refuses before stop without a lease registry", () => {
    const body = enclosingBody(
      readOrEmpty(join(REPO, "packages/remote/src/residency/force-unload.ts")),
      "export async function forceUnloadWorkload(",
    );
    expect(body, "forceUnloadWorkload signature").not.toBe("");
    expect(body).toContain("if (registry === null)");
    expect(body).toContain("no residency lease registry installed; nothing to fence");
    expect(body).toContain('reason: "Unavailable"');
    const registryIdx = body.indexOf("if (registry === null)");
    const stopIdx = body.indexOf("await stop()");
    expect(registryIdx, "registry refusal").toBeGreaterThanOrEqual(0);
    expect(stopIdx, "stop call").toBeGreaterThanOrEqual(0);
    expect(registryIdx, "registry refusal precedes stop").toBeLessThan(stopIdx);
  });

  // Guard: the lease registry remains an explicit agent opt-in.
  test("source: lease registry opt-in remains explicit", () => {
    expect(readOrEmpty(join(REPO, "packages/cli/src/commands/agent.ts"))).toContain(
      'env["LLAMACTL_RESIDENCY_LEASES"] === "1" || env["LLAMACTL_RESIDENCY_LEASES"] === "true"',
    );
  });
});
