import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #522
// Kills: the enforcement summary omitting the direct-start fence or the
// read-only launch gate, the ModelRun catalog fallback losing its prose,
// file:line citations entering the summary, or the source surfaces pinned
// by those claims being unwired.
describe("#522 residency enforcement summary", () => {
  const OPEN =
    "What enforces today is the finite-budget admission math, the per-node residency-group start guard, the fenced direct-start lifecycle refusal and the read-only pre-launch gate, all four listed under Residency states and exclusion below.";
  const STALE_OPEN =
    "What enforces today is the finite-budget admission math plus the per-node residency-group start guard described below";
  const FALLBACK =
    "when the stored ModelRun has no such label, or no ModelRun is stored under the name, `serverStart` takes the group from the catalog `residencyGroup` of the rel `resolveTarget` returns for its target (`directModelRunStartOpts`), and a label always wins";
  const ITEM3 =
    "3. The fenced direct-start lifecycle refusal (`runDirectResidencyStart`, `packages/remote/src/residency/direct-lifecycle.ts`, #517). The agent's `modelHostStart` and `serverStart` procedures (`packages/remote/src/router.ts`) run every direct start through it. A ModelHost takes its group from its `llamactl.io/residency-group` label; a ModelRun takes the label, else the catalog group of its resolved target. When another `loading` or `warming` row holds that exclusive group, or a `ready` row whose workload is not proven down, the start is refused before the engine runs, as `residency lifecycle refused <name> <from> -> <to>: ExclusiveGroupOccupied: <detail>`; a same-group `ready` peer proven down is instead reconciled to `downloaded` and logged as `[residency] lifecycle reconciled stale <peer> ready -> downloaded in group <group>`. It also refuses a start while a profile switch is in flight on the node, as `residency lifecycle refused <name>: profile switch in flight on this node; retry after it settles`. A writer inside the profile switch's own scope (its `applyManifest` calls) neither records nor refuses, and a node with no residency store file starts unrecorded. Details: [dynamic-residency.md](dynamic-residency.md#direct-modelhost-start-and-stop).";
  const ITEM4 =
    "4. The read-only pre-launch gate (`exclusiveGroupLaunchRefusal`, `packages/remote/src/residency/direct-lifecycle.ts`, #517). Launches that record no `residency_states` row read the local residency store before they spawn and refuse when any `loading`, `warming` or `ready` row holds the declared-exclusive residency group of what they launch, counting a row for the same id: `llamactl eval run <model>` without `--url` and `llamactl admit measure` exit 1; `llamactl keep-alive start` exits 1 and the keep-alive worker records `start-refused`; `llamactl bench preset` and `bench vision` exit 1, and the agent's bench subscriptions return the refusal as a stream error; the post-pull auto-tune records the preset or vision step as skipped with kind `exclusive-group-occupied`, and `llamactl candidate test` reports the step not run with the refusal as its reason. The refusal reads `residency lifecycle refused <id> downloaded -> loading: ExclusiveGroupOccupied: exclusive group <group> is held by <member> in state <state>`. It also refuses while a profile switch is in flight (`residency lifecycle refused <id>: profile switch in flight on this node; retry after it settles`) or when the store cannot be read (`residency lifecycle refused <id>: store unavailable (<error>)`). The gate is unfenced and never reconciles a proven-down peer, and a node with no store file launches as before.";

  const count = (s: string, sub: string): number => s.split(sub).length - 1;

  const flatDoc = flat(doc);
  const flatRouter = flat(readOrEmpty(join(REPO, "packages/remote/src/router.ts")));
  const router = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
  const dl = readOrEmpty(join(REPO, "packages/remote/src/residency/direct-lifecycle.ts"));
  const lifecycleSteps = flat(
    readOrEmpty(join(REPO, "packages/remote/src/residency/lifecycle-steps.ts")),
  );
  const states = flat(sectionBody(/^## Residency states and exclusion/) ?? "");
  const lifecycleStates = flat(sectionBody(/^### Residency lifecycle states/) ?? "");
  const catalogFieldsAt = flatDoc.indexOf("## Catalog fields");
  const openItemsAt = flatDoc.indexOf("Open items:");
  const openItemsRegion =
    openItemsAt === -1 || catalogFieldsAt === -1 ? "" : flatDoc.slice(openItemsAt, catalogFieldsAt);
  const firstBulletAt = flatDoc.indexOf("- The 8-state residency lifecycle");
  const secondBulletAt = flatDoc.indexOf(
    "- Real GLM-5.3-Flash z13 measurements",
    firstBulletAt + 1,
  );
  const openItemsBullet =
    firstBulletAt === -1
      ? ""
      : flatDoc.slice(firstBulletAt, secondBulletAt === -1 ? catalogFieldsAt : secondBulletAt);
  const observableAt = states.indexOf("Observable signals operators use today");

  // Kills: the stale two-check sentence being left in place.
  test("open items name all four enforcing checks", () => {
    expect(flatDoc, "open-items enforcement summary").toContain(OPEN);
    const openAt = flatDoc.indexOf(OPEN);
    expect(catalogFieldsAt, "## Catalog fields anchor").toBeGreaterThanOrEqual(0);
    expect(openAt, "summary before catalog fields").toBeLessThan(catalogFieldsAt);
    expect(flatDoc, "stale two-check sentence").not.toContain(STALE_OPEN);
  });

  // Kills: serverStart reverting to directModelRunOpts, or the fallback
  // being dropped from directModelRunStartOpts.
  test("ModelRun start group falls back to the catalog", () => {
    const pendingAt = states.indexOf("Still pending #276");
    const beforePending = pendingAt === -1 ? states : states.slice(0, pendingAt);

    expect(openItemsRegion, "fallback in open items").toContain(FALLBACK);
    expect(beforePending, "fallback before Still pending #276").toContain(FALLBACK);
    expect(lifecycleStates, "fallback in lifecycle states").toContain(FALLBACK);

    const startOpts = flat(enclosingBody(router, "function directModelRunStartOpts("));
    expect(startOpts, "directModelRunStartOpts fallback").toContain(
      "return opts.group !== undefined ? opts : { ...opts, group: catalogTargetGroup(target) };",
    );
    const targetGroup = flat(enclosingBody(router, "function catalogTargetGroup("));
    expect(targetGroup, "catalogTargetGroup rel lookup").toContain(
      "catalog.findByRel(rel)?.residencyGroup",
    );
    expect(flatRouter, "serverStart start opts").toContain(
      "directModelRunStartOpts(input.workload, input.target)",
    );
  });

  // Kills: dropping the proven-down exemption, dropping the stale-peer
  // reconcile or its log text, dropping the switch-in-flight refusal,
  // dropping the switch-scope or store-absent bypass, renaming the refusal
  // format, or unwrapping either procedure.
  test("item 3: fenced direct-start lifecycle refusal", () => {
    expect(states, "fenced direct-start lifecycle item").toContain(ITEM3);
    const item3At = states.indexOf(ITEM3);
    const labelledAt = states.indexOf("Only labelled ModelHost peers are checked");
    expect(labelledAt, "Only labelled ModelHost peers anchor").toBeGreaterThanOrEqual(0);
    expect(observableAt, "Observable signals anchor").toBeGreaterThan(labelledAt);
    expect(item3At, "item 3 after labelled-peer limit").toBeGreaterThan(labelledAt);
    expect(item3At, "item 3 before observable signals").toBeLessThan(observableAt);
    expect(/\.ts:\d/.test(ITEM3), "no file:line citation in item 3").toBe(false);
    expect(/\.ts:\d/.test(openItemsBullet), "no file:line citation in open items").toBe(false);

    expect(flatRouter, "modelHostStart fenced").toContain(
      "runDirectResidencyStart<StartModelHostResult>(",
    );
    expect(flatRouter, "serverStart fenced").toContain(
      "runDirectResidencyStart<serverMod.StartServerResult>(",
    );
    expect(lifecycleSteps, "transition refusal format").toContain(
      "`residency lifecycle refused ${workload} ${from} -> ${to}: ${decision.reason}: ${decision.detail}`",
    );
    expect(lifecycleSteps, "stale-peer reconcile log").toContain(
      "`[residency] lifecycle reconciled stale ${row.model} ${row.state} -> downloaded in group ${group}: `",
    );
    expect(lifecycleSteps, "plan-observed occupant exemption").toContain(
      "!ctx.occupiedAtPlan.has(row.model)",
    );

    const corroborated = flat(enclosingBody(dl, "function isCorroboratedOccupant("));
    expect(corroborated, "proven-down exemption").toContain(
      'return !(row.state === "ready" && isProvenDownSafe(opts, row.model));',
    );
    const initialClaim = flat(enclosingBody(dl, "async function initialClaim<"));
    expect(initialClaim, "switch-in-flight refusal").toContain(
      "detail: `residency lifecycle refused ${workload}: profile switch in flight on this node; retry after it settles`",
    );
    const runDirect = flat(enclosingBody(dl, "async function runDirect<"));
    expect(runDirect, "switch-scope bypass").toContain(
      "if (inResidencySwitchScope()) { return { ran: true, result: await dep(workload) }; }",
    );
    expect(runDirect, "store-absent bypass").toContain(
      "if (!existsSync(opts.storePath)) { return { ran: true, result: await dep(workload) }; }",
    );
    expect(
      flat(readOrEmpty(join(REPO, "docs/dynamic-residency.md"))),
      "dynamic-residency anchor",
    ).toContain("## Direct ModelHost start and stop");
  });

  // Kills: removing the gate from any one launch path (eval, admit,
  // keep-alive runStart, bench preset/vision CLI, router bench
  // subscriptions, pull/candidate), changing the refusal text, the gate
  // starting to treat a missing store as a refusal, or the gate starting to
  // consult proven-down.
  test("item 4: read-only pre-launch gate", () => {
    expect(states, "read-only pre-launch gate item").toContain(ITEM4);
    const item3At = states.indexOf(ITEM3);
    const item4At = states.indexOf(ITEM4);
    expect(item4At, "item 4 after item 3").toBeGreaterThan(item3At);
    expect(item4At, "item 4 before observable signals").toBeLessThan(observableAt);
    expect(/\.ts:\d/.test(ITEM4), "no file:line citation in item 4").toBe(false);
    expect(/\.ts:\d/.test(openItemsBullet), "no file:line citation in open items").toBe(false);

    const gate = flat(enclosingBody(dl, "export function exclusiveGroupLaunchRefusal("));
    expect(gate, "occupying states").toContain("isOccupyingResidencyState(row.state)");
    expect(gate, "missing store launches").toContain("if (!snapshot.present) { return null; }");
    expect(gate, "occupied refusal text").toContain(
      "downloaded -> loading: ExclusiveGroupOccupied: exclusive group ${group} is held by ${holder.model} in state ${holder.state}",
    );
    expect(gate, "switch-in-flight text").toContain(
      "profile switch in flight on this node; retry after it settles",
    );
    expect(gate, "store-unavailable text").toContain(": store unavailable (${snapshot.error})");
    expect(gate, "gate never consults proven-down").not.toContain("isProvenDown");

    const evalSrc = flat(readOrEmpty(join(REPO, "packages/cli/src/commands/eval.ts")));
    expect(evalSrc, "eval stderr").toContain("process.stderr.write(`eval run: ${refusal}\\n`);");
    const admitSrc = flat(readOrEmpty(join(REPO, "packages/cli/src/commands/admit-measure.ts")));
    expect(admitSrc, "admit stderr").toContain("console.error(`admit measure: ${refusal}`);");
    const keepAliveCliSrc = flat(readOrEmpty(join(REPO, "packages/cli/src/commands/keepAlive.ts")));
    expect(keepAliveCliSrc, "keep-alive stderr").toContain(
      "process.stderr.write(`keep-alive start: ${groupRefusal}\\n`);",
    );
    const benchSrc = flat(readOrEmpty(join(REPO, "packages/cli/src/commands/bench.ts")));
    expect(benchSrc, "bench preset stderr").toContain(
      "process.stderr.write(`bench preset: ${refusal}\\n`);",
    );
    expect(benchSrc, "bench vision stderr").toContain(
      "process.stderr.write(`bench vision: ${refusal}\\n`);",
    );
    expect(
      count(
        flatRouter,
        "const refusal = benchLaunchRefusal(input.target); if (refusal !== null) throw new Error(refusal);",
      ),
      "router bench subscription gates",
    ).toBeGreaterThanOrEqual(2);

    const keepAliveCoreSrc = flat(readOrEmpty(join(REPO, "packages/core/src/keepAlive.ts")));
    expect(keepAliveCoreSrc, "start-refused state").toContain('emitState(rel, "start-refused")');
    const pullSrc = flat(readOrEmpty(join(REPO, "packages/cli/src/commands/pull.ts")));
    expect(pullSrc, "pull launchRefusal").toContain("launchRefusal: benchLaunchRefusal");
    const candidateSrc = flat(readOrEmpty(join(REPO, "packages/cli/src/commands/candidate.ts")));
    expect(candidateSrc, "candidate launchRefusal").toContain("launchRefusal: benchLaunchRefusal");
    expect(
      count(flatRouter, "launchRefusal: benchLaunchRefusal"),
      "router launchRefusal wiring",
    ).toBeGreaterThanOrEqual(2);
    const autotuneSrc = flat(readOrEmpty(join(REPO, "packages/core/src/autotune.ts")));
    expect(autotuneSrc, "auto-tune skipped kind").toContain('kind: "exclusive-group-occupied"');
    const candidateTestSrc = flat(readOrEmpty(join(REPO, "packages/core/src/candidateTest.ts")));
    expect(candidateTestSrc, "candidate step not run").toContain(
      "if (refusal !== null) return { ran: false, reason: refusal };",
    );
  });
});
