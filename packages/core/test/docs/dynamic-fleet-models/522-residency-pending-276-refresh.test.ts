// Part of #522

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

const PENDING276 =
  "Since #276 opened, ModelHost starts are enforced (items 2 and 3 below), boot recovery of interrupted profile-switch operations and lifecycle rows has landed ([dynamic-residency.md](dynamic-residency.md#cancel-and-crash-recovery)), and the residency store refuses a `desiredRevision` below its high-water mark as `stale-revision` and, on `beginOperation`, refuses as `reservation-exceeds-budget` a reservation that would push the pending and committed reservations past a caller-supplied `nodeBudgetGiB`; the profile-switch executor passes the plan's resolved node budget when it is known. Still pending #276: reconciliation outside a switch, a mandatory `desiredRevision` on `transitionResidencyState` (a write that carries none is accepted and keeps the stored revision), and budget admission for `transitionResidencyState`, which records no reservation and is not budget-gated. The enforcement in place today is the following:";
const RECONCILER =
  "`applyOne` and `applyOneModelHost` (`packages/remote/src/workload/apply.ts`), which the reconciler calls, start a ModelRun's coordinator and a ModelHost through the node agent's `serverStart` and `modelHostStart` procedures, so the fenced direct-start lifecycle refusal covers those starts; the rpc-server workers `applyOne` starts for a ModelRun with `spec.workers` go through the agent's `rpcServerStart` procedure, which calls `startRpcServer` without `runDirectResidencyStart` and records no `residency_states` row, and the reconciler passes `applyOne` no gateway dispatcher, so it leaves a `spec.gateway` ModelRun `Pending` without starting it.";
const ITEM4_NEW =
  "Launches read the local residency store before they spawn and refuse when any `loading`, `warming` or `ready` row holds the declared-exclusive residency group of what they launch. Sandbox launches record no `residency_states` row and count a row for the same id: `llamactl eval run <model>` without `--url`, `llamactl eval perf --launch` and `llamactl admit measure` exit 1; the eval matrix runner spawns no refused engine, and writes an error cell for every workload of a refused model and for the one workload whose judge is refused; `llamactl bench preset` and `bench vision` exit 1, and the agent's bench subscriptions return the refusal as a stream error; the post-pull auto-tune records the preset or vision step as skipped with kind `exclusive-group-occupied`, and `llamactl candidate test` reports the step not run with the refusal as its reason. `llamactl keep-alive start` exits 1, locally or through the agent's `keepAliveStart` procedure, and the keep-alive worker's pre-start gate records `start-refused`; these keep-alive gates pass `ignoreModel` so only the target's own row is ignored, because the worker records that row itself through `runDirectResidencyStart` and `runDirectResidencyStop` (`keepAliveRecordedStart`, `keepAliveRecordedStop`).";

function procedureBody(src: string, key: string): string {
  const start = src.indexOf(`  ${key}: t.procedure`);
  if (start === -1) return "";
  const lines = src.slice(start).split("\n");
  const end = lines.findIndex((line, i) => i > 0 && /^ {2}[A-Za-z]+: t\.procedure/.test(line));
  return lines.slice(0, end === -1 ? lines.length : end).join("\n");
}

describe("#522 residency pending #276 refresh", () => {
  const states = flat(sectionBody(/^## Residency states and exclusion/) ?? "");
  const flatDoc = flat(doc);
  const catalogFieldsAt = flatDoc.indexOf("## Catalog fields");
  const firstBulletAt = flatDoc.indexOf("- The 8-state residency lifecycle");
  const secondBulletAt = flatDoc.indexOf(
    "- Real GLM-5.3-Flash z13 measurements",
    firstBulletAt + 1,
  );
  const openItemsBullet =
    firstBulletAt === -1
      ? ""
      : flatDoc.slice(firstBulletAt, secondBulletAt === -1 ? catalogFieldsAt : secondBulletAt);

  const store = readOrEmpty(join(REPO, "packages/remote/src/residency/store.ts"));
  const applyProfile = readOrEmpty(join(REPO, "packages/remote/src/residency/apply-profile.ts"));
  const reconciler = readOrEmpty(join(REPO, "packages/remote/src/workload/reconciler.ts"));
  const apply = readOrEmpty(join(REPO, "packages/remote/src/workload/apply.ts"));
  const router = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
  const keepAliveCli = readOrEmpty(join(REPO, "packages/cli/src/commands/keepAlive.ts"));
  const directLifecycle = readOrEmpty(
    join(REPO, "packages/remote/src/residency/direct-lifecycle.ts"),
  );
  const launchGate = readOrEmpty(join(REPO, "packages/eval/src/matrix/launch-gate.ts"));
  const evalPerfLaunch = readOrEmpty(join(REPO, "packages/cli/src/commands/eval-perf-launch.ts"));
  const evalPerf = readOrEmpty(join(REPO, "packages/cli/src/commands/eval-perf.ts"));
  const matrixLifecycle = readOrEmpty(join(REPO, "packages/eval/src/matrix/lifecycle.ts"));
  const matrixRunner = readOrEmpty(join(REPO, "packages/eval/src/matrix/runner.ts"));
  const matrixCli = readOrEmpty(join(REPO, "packages/eval/src/matrix/cli.ts"));

  // Kills: reverting (B); making desiredRevision mandatory or budget-gating
  // transitionResidencyState without a doc update; dropping either
  // beginOperation refusal; runFencedSwitch no longer passing the budget.
  test("pending #276 paragraph lists only what is still open", () => {
    expect(states, "pending #276 refresh").toContain(PENDING276);
    expect(states, "stale reconciler/ModelHost pending text").not.toContain(
      "Still pending #276: enforcement in the reconciler and ModelHost",
    );
    expect(states, "landed revision and reservation work still called pending").not.toContain(
      "stale-revision rejection, and summing reservations",
    );

    const beginOperation = flat(enclosingBody(store, "function beginOperationTx("));
    expect(beginOperation, "stale operation revision refusal").toContain(
      'reason: "stale-revision"',
    );
    expect(beginOperation, "over-budget operation refusal").toContain(
      'reason: "reservation-exceeds-budget"',
    );
    expect(beginOperation, "nonterminal reservation sum").toContain(
      "nonterminalReservationGiB(db) + input.reservationGiB > input.nodeBudgetGiB",
    );

    const transition = flat(enclosingBody(store, "function transitionResidencyStateTx("));
    expect(transition, "optional desired revision anchor").toContain(
      "if (input.desiredRevision !== undefined) {",
    );
    expect(transition, "transition is not budget-gated").not.toContain("nodeBudgetGiB");

    const fencedSwitch = flat(enclosingBody(applyProfile, "async function runFencedSwitch("));
    expect(fencedSwitch, "profile switch passes a resolved budget").toContain(
      "...(nodeBudgetGiB === undefined ? {} : { nodeBudgetGiB }),",
    );
    expect(
      readOrEmpty(join(REPO, "docs/dynamic-residency.md")),
      "cancel and crash recovery anchor",
    ).toContain("## Cancel and crash recovery");
  });

  // Kills: reverting (A); the reconciler starting to pass a gateway dispatcher
  // without a doc update; applyOne no longer returning Pending when it has no
  // dispatcher; fencing rpcServerStart, or unfencing serverStart or
  // modelHostStart, without a doc update; startWorkers bypassing
  // rpcServerStart.
  test("open items state which reconciler starts are fenced", () => {
    expect(openItemsBullet, "reconciler fencing refresh").toContain(RECONCILER);
    expect(openItemsBullet, "stale reconciler-pending sentence").not.toContain(
      "Enforcement in the reconciler is still pending #276.",
    );
    expect(openItemsBullet, "gateway fallthrough is not the reconciler rule").not.toContain(
      "only when `gatewayDispatch` returns `null`",
    );

    const reconcileRun = flat(enclosingBody(reconciler, "async function reconcileModelRun("));
    expect(reconcileRun, "ModelRun reconcile calls applyOne").toContain("await applyOne(");
    expect(reconcileRun, "ModelRun reconcile passes no gateway dispatcher").toContain(
      "}, undefined, { workloadsDir: dir,",
    );
    expect(
      flat(enclosingBody(reconciler, "async function reconcileUnmanagedModelHost(")),
      "ModelHost reconcile calls applyOneModelHost",
    ).toContain("applyOneModelHost(");

    expect(
      flat(enclosingBody(apply, "export async function applyOne(")),
      "applyOne pending",
    ).toContain("return gatewayPendingResult(manifest, onEvent);");
    const pendingResult = flat(enclosingBody(apply, "function gatewayPendingResult("));
    expect(pendingResult, "gateway pending phase").toContain('phase: "Pending",');
    expect(pendingResult, "gateway pending reason").toContain("no gateway dispatcher provided");

    expect(
      flat(enclosingBody(apply, "async function startCoordinator(")),
      "server start",
    ).toContain("client.serverStart.subscribe(");
    expect(
      flat(enclosingBody(apply, "async function startModelHostProcess(")),
      "ModelHost start",
    ).toContain("client.modelHostStart.subscribe(");
    expect(flat(enclosingBody(apply, "async function startWorkers(")), "worker start").toContain(
      "wc.rpcServerStart.subscribe(",
    );

    const rpcStart = flat(procedureBody(router, "rpcServerStart"));
    expect(rpcStart, "rpcServerStart direct implementation anchor").toContain(
      "rpcServerMod.startRpcServer({",
    );
    expect(rpcStart, "rpcServerStart is unfenced").not.toContain("runDirectResidencyStart");
    expect(flat(procedureBody(router, "serverStart")), "serverStart delegates").toContain(
      "runModelRunStart(input, sig, emit, managed)",
    );
    expect(
      flat(enclosingBody(router, "async function runModelRunStart(")),
      "serverStart fenced",
    ).toContain("runDirectResidencyStart(");
    expect(flat(procedureBody(router, "modelHostStart")), "modelHostStart fenced").toContain(
      "runDirectResidencyStart<",
    );
  });

  // Kills: reverting (C); dropping ignoreModel from any keep-alive gate; the
  // keep-alive worker no longer recording its own row; the matrix or
  // perf-launch gate starting to ignore self rows or no longer calling
  // exclusiveGroupLaunchRefusal; moving the perf-launch refusal after
  // preflight; a refused model writing fewer than all of its workloads' error
  // cells, or a refused judge writing more than its one; unwiring the matrix
  // gate in main.
  test("item 4 lists the keep-alive own-row exemption and the eval perf --launch and matrix paths", () => {
    expect(states, "read-only pre-launch gate refresh").toContain(ITEM4_NEW);
    expect(states, "stale no-row launch blanket").not.toContain(
      "Launches that record no `residency_states` row read the local residency store",
    );
    expect(states, "stale matrix error-cell blanket").not.toContain(
      "writes the workload's error cell without spawning",
    );

    expect(
      flat(enclosingBody(keepAliveCli, "async function keepAliveRecordedStart(")),
      "keep-alive start records its row",
    ).toContain("runDirectResidencyStart(");
    expect(
      flat(enclosingBody(keepAliveCli, "async function keepAliveRecordedStop(")),
      "keep-alive stop records its row",
    ).toContain("runDirectResidencyStop(");
    expect(flat(enclosingBody(keepAliveCli, "async function runStart(")), "CLI gate").toContain(
      "keepAliveLaunchRefusal(resolvedRel, target)",
    );
    const worker = flat(enclosingBody(keepAliveCli, "async function runWorker("));
    expect(worker, "worker beforeStart gate").toContain(
      "beforeStart: (rel) => keepAliveLaunchRefusal(rel, target),",
    );
    expect(worker, "worker recorded start").toContain("start: keepAliveRecordedStart,");
    expect(worker, "worker recorded stop").toContain("stop: keepAliveRecordedStop,");

    expect(
      flat(enclosingBody(router, "function keepAliveStartRefusal(")),
      "agent keep-alive own-row exemption",
    ).toContain("ignoreModel: target");
    expect(
      flat(enclosingBody(directLifecycle, "export function exclusiveGroupLaunchRefusal(")),
      "gate ignores only the named row",
    ).toContain("row.model !== opts.ignoreModel");

    const matrixGate = flat(enclosingBody(launchGate, "export function matrixLaunchRefusal("));
    expect(matrixGate, "matrix delegates to the shared gate").toContain(
      "return exclusiveGroupLaunchRefusal({",
    );
    expect(matrixGate, "matrix gate counts self rows").not.toContain("ignoreModel");
    const perfGate = flat(enclosingBody(evalPerfLaunch, "export function launchRefusal("));
    expect(perfGate, "perf launch delegates to the shared gate").toContain(
      "return exclusiveGroupLaunchRefusal({",
    );
    expect(perfGate, "perf launch gate counts self rows").not.toContain("ignoreModel");

    const prepare = flat(enclosingBody(evalPerf, "async function prepareLaunch("));
    const refusalBeforePreflight = "if (refusal !== null) return { ok: false, error: refusal };";
    expect(prepare, "perf launch refusal return").toContain(refusalBeforePreflight);
    expect(prepare, "perf launch preflight anchor").toContain("preflightLaunch(");
    expect(
      prepare.indexOf(refusalBeforePreflight),
      "perf launch refusal precedes preflight",
    ).toBeLessThan(prepare.indexOf("preflightLaunch("));
    const failBody = flat(enclosingBody(evalPerf, "function fail("));
    expect(failBody, "eval perf stderr").toContain(
      "process.stderr.write(`eval perf: ${message}\\n`);",
    );
    expect(failBody, "eval perf exit").toContain("return 1;");

    expect(
      flat(enclosingBody(matrixLifecycle, "export async function ensureModelServing(")),
      "matrix boot refusal",
    ).toContain("throw new Error(`eval matrix: ${refusal}`);");
    expect(
      flat(enclosingBody(matrixRunner, "async function runModelCells(")),
      "model cells",
    ).toContain("recordBootError(model, opts.workloads, runId, opts.db)");
    expect(
      flat(enclosingBody(matrixRunner, "async function runWorkloadCell(")),
      "judge workload cell",
    ).toContain("recordBootError(model, [workload], runId, opts.db)");
    expect(flat(enclosingBody(matrixCli, "async function main(")), "matrix CLI wiring").toContain(
      "launchRefusal: matrixLaunchRefusal,",
    );
  });
});
