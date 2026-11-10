import { expect, test } from "bun:test";

// #283: guarded llama.cpp sleep/wake with process fallback lands with the
// fix. A variable specifier keeps tsc from resolving the not-yet-existing
// module, so each case fails by assertion at the pinned base rather than
// by a resolution error.
const MODULE = "../src/residency/llamacpp-sleep.js";

type EngineInfo = {
  engine: string;
  fork?: string | undefined;
  build?: string | undefined;
};

type QualifiedBuild = {
  fork: string;
  build: string;
};

type SleepCapability =
  | { kind: "guarded-sleep"; fork: string; build: string }
  | { kind: "process-fallback"; reason: string };

type SleepObservation = {
  processAlive?: boolean | undefined;
  isSleeping?: boolean | undefined;
  healthStatus?: number | undefined;
};

type SleepState = "unknown" | "stopped" | "sleeping" | "ready" | "loading" | "unhealthy";

type SleepDesired = "awake" | "asleep";

type SleepReconcile = {
  action: { kind: string; reason?: string | undefined };
  wakingProbesAllowed: boolean;
};

type SleepMemberSpec = {
  id: string;
  runtimeKey: string;
  specDigest: string;
  allocationGiB: number;
  capability: SleepCapability;
};

type SleepMemberSnapshot = {
  state: string;
  reservation: string;
};

type SleepAuditEntry = {
  id: string;
  observed: SleepState;
  kept: string;
  reason: string;
};

type SleepSnapshot = {
  committedGiB: number;
  members: Record<string, SleepMemberSnapshot>;
  audit: SleepAuditEntry[];
};

type SleepControllerResult = {
  kind: string;
  reason?: string | undefined;
  chargedGiB?: number | undefined;
  committedGiB?: number | undefined;
  slots?: string | undefined;
};

type LlamacppSleepController = {
  register: (member: SleepMemberSpec, state: SleepState) => void;
  requestWake: (id: string, opts?: { cacheIdentity?: string | undefined }) => SleepControllerResult;
  wakeSettled: (id: string, outcome: string) => void;
  requestSleep: (id: string) => SleepControllerResult;
  sleepSettled: (id: string, outcome: string, cacheIdentity?: string) => void;
  observe: (id: string, state: SleepState) => void;
  snapshot: () => SleepSnapshot;
};

type Mod = {
  qualifySleepCapability: (
    engine: EngineInfo,
    qualified: readonly QualifiedBuild[],
  ) => SleepCapability;
  classifySleepObservation: (
    observation: SleepObservation,
    capability: SleepCapability,
  ) => SleepState;
  decideSleepReconcile: (input: {
    desired: SleepDesired;
    observed: SleepState;
    capability: SleepCapability;
  }) => SleepReconcile;
  createLlamacppSleepController: (opts: {
    budgetGiB?: number | undefined;
  }) => LlamacppSleepController;
};

async function load(): Promise<Mod> {
  const mod = (await import(MODULE).catch(() => undefined)) as Mod | undefined;
  expect(typeof mod?.qualifySleepCapability).toBe("function");
  expect(typeof mod?.classifySleepObservation).toBe("function");
  expect(typeof mod?.decideSleepReconcile).toBe("function");
  expect(typeof mod?.createLlamacppSleepController).toBe("function");
  return mod!;
}

const GUARDED: SleepCapability = { kind: "guarded-sleep", fork: "ggml-org", build: "b7000" };
const FALLBACK: SleepCapability = { kind: "process-fallback", reason: "NotQualified" };
const QUALIFIED: QualifiedBuild[] = [{ fork: "ggml-org", build: "b7000" }];

const reconcile = (
  mod: Mod,
  desired: SleepDesired,
  observed: SleepState,
  capability: SleepCapability,
): SleepReconcile => mod.decideSleepReconcile({ desired, observed, capability });

const ctl = (mod: Mod, budgetGiB?: number): LlamacppSleepController =>
  mod.createLlamacppSleepController(budgetGiB === undefined ? {} : { budgetGiB });

const registerMember = (
  controller: LlamacppSleepController,
  id: string,
  state: SleepState,
  capability: SleepCapability = GUARDED,
  allocationGiB = 24,
): void => {
  controller.register(
    { id, runtimeKey: id, specDigest: `d${id}`, allocationGiB, capability },
    state,
  );
};

const snapMember = (controller: LlamacppSleepController, id: string): SleepMemberSnapshot => {
  const member = controller.snapshot().members[id];
  expect(member).toBeDefined();
  return member!;
};

// ── qualifySleepCapability ─────────────────────────────────────────────────

test("#283 Q1: a qualified ggml-org build reports guarded-sleep with its fork and build", async () => {
  const mod = await load();
  expect(
    mod.qualifySleepCapability({ engine: "llamacpp", fork: "ggml-org", build: "b7000" }, [
      { fork: "ggml-org", build: "b7000" },
    ]),
  ).toEqual({ kind: "guarded-sleep", fork: "ggml-org", build: "b7000" });
  expect(
    mod.qualifySleepCapability({ engine: "llamacpp", fork: "gufo", build: "b8000" }, [
      { fork: "ggml-org", build: "b7000" },
      { fork: "gufo", build: "b8000" },
    ]),
  ).toEqual({ kind: "guarded-sleep", fork: "gufo", build: "b8000" });
});

test("#283 Q2: non-llamacpp engines always report process-fallback EngineNotLlamacpp", async () => {
  const mod = await load();
  const engines: EngineInfo[] = [
    { engine: "strata", fork: "ggml-org", build: "b7000" },
    { engine: "strata", fork: "gufo", build: "b1" },
    { engine: "strata", fork: "", build: "" },
    { engine: "strata" },
    { engine: "omlx", fork: "ggml-org", build: "b7000" },
  ];
  for (const engine of engines) {
    expect(mod.qualifySleepCapability(engine, QUALIFIED)).toEqual({
      kind: "process-fallback",
      reason: "EngineNotLlamacpp",
    });
  }
});

test("#283 Q3: the llamacpp engine label alone does not qualify an unlisted fork", async () => {
  const mod = await load();
  expect(
    mod.qualifySleepCapability({ engine: "llamacpp", fork: "gufo", build: "b7000" }, [
      { fork: "ggml-org", build: "b7000" },
    ]),
  ).toEqual({ kind: "process-fallback", reason: "NotQualified" });
});

test("#283 Q4: an unlisted build on either fork is NotQualified", async () => {
  const mod = await load();
  for (const fork of ["ggml-org", "gufo"]) {
    expect(
      mod.qualifySleepCapability({ engine: "llamacpp", fork, build: "b6999" }, QUALIFIED),
    ).toEqual({ kind: "process-fallback", reason: "NotQualified" });
  }
});

test("#283 Q5: a missing or empty fork or build is BuildUnknown", async () => {
  const mod = await load();
  const engines: EngineInfo[] = [
    { engine: "llamacpp" },
    { engine: "llamacpp", fork: "ggml-org" },
    { engine: "llamacpp", build: "b7000" },
    { engine: "llamacpp", fork: "", build: "b7000" },
    { engine: "llamacpp", fork: "ggml-org", build: "" },
    { engine: "llamacpp", fork: "", build: "" },
    { engine: "llamacpp", fork: "gufo" },
  ];
  for (const engine of engines) {
    expect(mod.qualifySleepCapability(engine, QUALIFIED)).toEqual({
      kind: "process-fallback",
      reason: "BuildUnknown",
    });
  }
});

// ── classifySleepObservation ────────────────────────────────────────────────

test("#283 C1: a missing process liveness signal classifies as unknown", async () => {
  const mod = await load();
  const observations: SleepObservation[] = [
    { processAlive: undefined },
    { processAlive: undefined, isSleeping: true, healthStatus: 200 },
    { processAlive: undefined, isSleeping: false, healthStatus: 503 },
  ];
  for (const observation of observations) {
    expect(mod.classifySleepObservation(observation, GUARDED)).toBe("unknown");
  }
});

test("#283 C2: a dead process is stopped even when it claims to be sleeping", async () => {
  const mod = await load();
  for (const capability of [GUARDED, FALLBACK]) {
    expect(
      mod.classifySleepObservation(
        { processAlive: false, isSleeping: true, healthStatus: 200 },
        capability,
      ),
    ).toBe("stopped");
    expect(mod.classifySleepObservation({ processAlive: false }, capability)).toBe("stopped");
  }
});

test("#283 C3: guarded sleep reports sleeping only for a live flagged healthy process", async () => {
  const mod = await load();
  expect(
    mod.classifySleepObservation(
      { processAlive: true, isSleeping: true, healthStatus: 200 },
      GUARDED,
    ),
  ).toBe("sleeping");
});

test("#283 C4: process-fallback never invents a sleeping state", async () => {
  const mod = await load();
  expect(
    mod.classifySleepObservation(
      { processAlive: true, isSleeping: true, healthStatus: 200 },
      FALLBACK,
    ),
  ).toBe("ready");
});

test("#283 C5: a live process still loading reports 503 as loading", async () => {
  const mod = await load();
  for (const isSleeping of [false, undefined]) {
    expect(
      mod.classifySleepObservation({ processAlive: true, isSleeping, healthStatus: 503 }, GUARDED),
    ).toBe("loading");
  }
});

test("#283 C6: a live process with a missing or 500 health status is unhealthy", async () => {
  const mod = await load();
  for (const healthStatus of [undefined, 500]) {
    expect(
      mod.classifySleepObservation(
        { processAlive: true, isSleeping: false, healthStatus },
        GUARDED,
      ),
    ).toBe("unhealthy");
  }
});

test("#283 C7: a live healthy process that is not sleeping is ready", async () => {
  const mod = await load();
  for (const capability of [GUARDED, FALLBACK]) {
    for (const isSleeping of [false, undefined]) {
      expect(
        mod.classifySleepObservation(
          { processAlive: true, isSleeping, healthStatus: 200 },
          capability,
        ),
      ).toBe("ready");
    }
  }
});

// ── decideSleepReconcile ────────────────────────────────────────────────────

test("#283 R1: asleep desired + sleeping observed -> none without wake probes", async () => {
  const mod = await load();
  const decision = reconcile(mod, "asleep", "sleeping", GUARDED);
  expect(decision.action.kind).toBe("none");
  expect(decision.wakingProbesAllowed).toBe(false);
});

test("#283 R2: awake desired + sleeping observed -> request-wake, never restart", async () => {
  const mod = await load();
  const decision = reconcile(mod, "awake", "sleeping", GUARDED);
  expect(decision.action.kind).toBe("request-wake");
  expect(decision.action.kind).not.toBe("restart");
  expect(decision.wakingProbesAllowed).toBe(false);
});

test("#283 R3: asleep desired + stopped observed -> none; a cold workload is not restarted", async () => {
  const mod = await load();
  for (const capability of [GUARDED, FALLBACK]) {
    const decision = reconcile(mod, "asleep", "stopped", capability);
    expect(decision.action.kind).toBe("none");
    expect(decision.wakingProbesAllowed).toBe(false);
  }
});

test("#283 R4: awake desired + stopped observed -> start", async () => {
  const mod = await load();
  for (const capability of [GUARDED, FALLBACK]) {
    const decision = reconcile(mod, "awake", "stopped", capability);
    expect(decision.action.kind).toBe("start");
    expect(decision.wakingProbesAllowed).toBe(false);
  }
});

test("#283 R5: asleep desired + ready observed -> request-sleep guarded, process-stop fallback", async () => {
  const mod = await load();
  const guarded = reconcile(mod, "asleep", "ready", GUARDED);
  expect(guarded.action.kind).toBe("request-sleep");
  expect(guarded.wakingProbesAllowed).toBe(false);
  const fallback = reconcile(mod, "asleep", "ready", FALLBACK);
  expect(fallback.action.kind).toBe("process-stop");
  expect(fallback.wakingProbesAllowed).toBe(false);
});

test("#283 R6: awake desired + ready observed -> none with wake probes allowed", async () => {
  const mod = await load();
  for (const capability of [GUARDED, FALLBACK]) {
    const decision = reconcile(mod, "awake", "ready", capability);
    expect(decision.action.kind).toBe("none");
    expect(decision.wakingProbesAllowed).toBe(true);
  }
});

test("#283 R7: observed loading -> none without wake probes for either desired state", async () => {
  const mod = await load();
  for (const desired of ["awake", "asleep"] as const) {
    const decision = reconcile(mod, desired, "loading", GUARDED);
    expect(decision.action.kind).toBe("none");
    expect(decision.wakingProbesAllowed).toBe(false);
  }
});

test("#283 R8: unhealthy restarts only when awake is desired; unknown holds with ResidencyUnknown", async () => {
  const mod = await load();
  const unhealthyAwake = reconcile(mod, "awake", "unhealthy", GUARDED);
  expect(unhealthyAwake.action.kind).toBe("restart");
  expect(unhealthyAwake.wakingProbesAllowed).toBe(false);
  const unhealthyAsleep = reconcile(mod, "asleep", "unhealthy", GUARDED);
  expect(unhealthyAsleep.action.kind).toBe("process-stop");
  expect(unhealthyAsleep.wakingProbesAllowed).toBe(false);
  for (const desired of ["awake", "asleep"] as const) {
    const unknown = reconcile(mod, desired, "unknown", GUARDED);
    expect(unknown.action.kind).toBe("hold");
    expect(unknown.action.reason).toBe("ResidencyUnknown");
    expect(unknown.wakingProbesAllowed).toBe(false);
  }
});

test("#283 R-invariant: observed sleeping never yields restart and never enables wake probes", async () => {
  const mod = await load();
  for (const desired of ["awake", "asleep"] as const) {
    for (const capability of [GUARDED, FALLBACK]) {
      const decision = reconcile(mod, desired, "sleeping", capability);
      expect(decision.action.kind).not.toBe("restart");
      expect(decision.wakingProbesAllowed).not.toBe(true);
    }
  }
});

// ── createLlamacppSleepController ───────────────────────────────────────────

test("#283 W1: waking one sleeping member charges its allocation against the budget", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  registerMember(controller, "a", "sleeping");
  registerMember(controller, "b", "sleeping");
  const wakeA = controller.requestWake("a", { cacheIdentity: "ka" });
  expect(wakeA.kind).toBe("wake");
  expect(wakeA.chargedGiB).toBe(24);
  const wakeB = controller.requestWake("b", { cacheIdentity: "kb" });
  expect(wakeB.kind).toBe("refuse");
  expect(wakeB.reason).toBe("BudgetExceeded");
  expect(controller.snapshot().committedGiB).toBe(24);
});

test("#283 W2: the wake reservation is held until sleep is confirmed, then frees the budget", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  registerMember(controller, "a", "sleeping");
  registerMember(controller, "b", "sleeping");
  expect(controller.requestWake("a", { cacheIdentity: "ka" }).kind).toBe("wake");
  controller.wakeSettled("a", "ready");
  const sleepA = controller.requestSleep("a");
  expect(sleepA.kind).toBe("sleep");
  expect(controller.snapshot().committedGiB).toBe(24);
  controller.sleepSettled("a", "slept", "ka");
  expect(controller.snapshot().committedGiB).toBe(0);
  const wakeB = controller.requestWake("b", { cacheIdentity: "kb" });
  expect(wakeB.kind).toBe("wake");
  expect(wakeB.chargedGiB).toBe(24);
});

test("#283 W3: an unknown budget refuses every guarded wake", async () => {
  const mod = await load();
  const controller = ctl(mod);
  registerMember(controller, "a", "sleeping");
  const wake = controller.requestWake("a", { cacheIdentity: "ka" });
  expect(wake.kind).toBe("refuse");
  expect(wake.reason).toBe("BudgetUnknown");
});

test("#283 W4: process-fallback members switch processes and never touch committedGiB", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  registerMember(controller, "f", "sleeping", FALLBACK);
  const beforeWake = controller.snapshot().committedGiB;
  const wake = controller.requestWake("f", { cacheIdentity: "kf" });
  expect(wake.kind).toBe("process-switch");
  expect(wake.reason).toBe("NotQualified");
  expect(controller.snapshot().committedGiB).toBe(beforeWake);
  registerMember(controller, "g", "ready", FALLBACK);
  const beforeSleep = controller.snapshot().committedGiB;
  const sleep = controller.requestSleep("g");
  expect(sleep.kind).toBe("process-stop");
  expect(controller.snapshot().committedGiB).toBe(beforeSleep);
});

test("#283 W5: a ready member reports already-awake and a waking member joins once", async () => {
  const mod = await load();
  const readyCtl = ctl(mod, 40);
  registerMember(readyCtl, "r", "ready");
  const already = readyCtl.requestWake("r", { cacheIdentity: "kr" });
  expect(already.kind).toBe("already-awake");

  const wakingCtl = ctl(mod, 40);
  registerMember(wakingCtl, "w", "sleeping");
  expect(wakingCtl.requestWake("w", { cacheIdentity: "kw" }).kind).toBe("wake");
  const join = wakingCtl.requestWake("w", { cacheIdentity: "kw" });
  expect(join.kind).toBe("join-wake");
  expect(wakingCtl.snapshot().committedGiB).toBe(24);
});

test("#283 W6: wake requests refuse unknown members and deliberately stopped members", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  const ghost = controller.requestWake("ghost", { cacheIdentity: "kg" });
  expect(ghost.kind).toBe("refuse");
  expect(ghost.reason).toBe("UnknownMember");
  registerMember(controller, "s", "stopped");
  const stopped = controller.requestWake("s", { cacheIdentity: "ks" });
  expect(stopped.kind).toBe("refuse");
  expect(stopped.reason).toBe("NotSleeping");
});

test("#283 W7: a cancelled wake leaves the member unknown, uncertain and still charged", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  registerMember(controller, "a", "sleeping");
  expect(controller.requestWake("a", { cacheIdentity: "ka" }).kind).toBe("wake");
  controller.wakeSettled("a", "cancelled");
  const member = snapMember(controller, "a");
  expect(member.state).toBe("unknown");
  expect(member.reservation).toBe("uncertain");
  expect(controller.snapshot().committedGiB).toBe(24);
});

test("#283 W8: a wake readiness failure leaves the member unknown, uncertain and still charged", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  registerMember(controller, "a", "sleeping");
  expect(controller.requestWake("a", { cacheIdentity: "ka" }).kind).toBe("wake");
  controller.wakeSettled("a", "readiness-failed");
  const member = snapMember(controller, "a");
  expect(member.state).toBe("unknown");
  expect(member.reservation).toBe("uncertain");
  expect(controller.snapshot().committedGiB).toBe(24);
});

test("#283 W9: a failed sleep leaves the member unknown, uncertain and still charged", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  registerMember(controller, "a", "sleeping");
  expect(controller.requestWake("a", { cacheIdentity: "ka" }).kind).toBe("wake");
  controller.wakeSettled("a", "ready");
  expect(controller.requestSleep("a").kind).toBe("sleep");
  controller.sleepSettled("a", "failed");
  const member = snapMember(controller, "a");
  expect(member.state).toBe("unknown");
  expect(member.reservation).toBe("uncertain");
  expect(controller.snapshot().committedGiB).toBe(24);
});

test("#283 W10: an unknown member refuses wake and keeps charging so peers stay blocked", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  registerMember(controller, "u", "sleeping");
  registerMember(controller, "v", "sleeping");
  expect(controller.requestWake("u", { cacheIdentity: "ku" }).kind).toBe("wake");
  controller.wakeSettled("u", "cancelled");
  const retry = controller.requestWake("u", { cacheIdentity: "ku" });
  expect(retry.kind).toBe("refuse");
  expect(retry.reason).toBe("ResidencyUnknown");
  const peer = controller.requestWake("v", { cacheIdentity: "kv" });
  expect(peer.kind).toBe("refuse");
  expect(peer.reason).toBe("BudgetExceeded");
  expect(controller.snapshot().committedGiB).toBe(24);
});

test("#283 W11: observing a stopped process releases the uncertain reservation", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  registerMember(controller, "a", "sleeping");
  expect(controller.requestWake("a", { cacheIdentity: "ka" }).kind).toBe("wake");
  controller.wakeSettled("a", "cancelled");
  controller.observe("a", "stopped");
  const member = snapMember(controller, "a");
  expect(member.state).toBe("stopped");
  expect(member.reservation).toBe("released");
  expect(controller.snapshot().committedGiB).toBe(0);
});

test("#283 W12: wake restores slots only when the cache identity matches the sleep", async () => {
  const mod = await load();

  const restoreCtl = ctl(mod, 40);
  registerMember(restoreCtl, "r", "sleeping");
  expect(restoreCtl.requestWake("r", { cacheIdentity: "k1" }).kind).toBe("wake");
  restoreCtl.wakeSettled("r", "ready");
  expect(restoreCtl.requestSleep("r").kind).toBe("sleep");
  restoreCtl.sleepSettled("r", "slept", "k1");
  const restore = restoreCtl.requestWake("r", { cacheIdentity: "k1" });
  expect(restore.kind).toBe("wake");
  expect(restore.slots).toBe("restore");

  const mismatchCtl = ctl(mod, 40);
  registerMember(mismatchCtl, "m", "sleeping");
  expect(mismatchCtl.requestWake("m", { cacheIdentity: "k1" }).kind).toBe("wake");
  mismatchCtl.wakeSettled("m", "ready");
  expect(mismatchCtl.requestSleep("m").kind).toBe("sleep");
  mismatchCtl.sleepSettled("m", "slept", "k1");
  const mismatch = mismatchCtl.requestWake("m", { cacheIdentity: "k2" });
  expect(mismatch.kind).toBe("wake");
  expect(mismatch.slots).toBe("discard");

  const coldCtl = ctl(mod, 40);
  registerMember(coldCtl, "c", "sleeping");
  const cold = coldCtl.requestWake("c", { cacheIdentity: "k1" });
  expect(cold.kind).toBe("wake");
  expect(cold.slots).toBe("discard");
});

// ── DF-10 (#283) overlapping sleep/wake guards ──────────────────────────────

test("#283 W13: requestWake on sleep-pending refuses with SleepInFlight", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  registerMember(controller, "a", "ready");
  expect(controller.requestSleep("a").kind).toBe("sleep");
  const snap = controller.snapshot();
  expect(snap.members["a"]?.state).toBe("sleep-pending");
  // sleep-pending still holds the reservation (resident = 24 GiB)
  expect(controller.snapshot().committedGiB).toBe(24);
  const wake = controller.requestWake("a", { cacheIdentity: "ka" });
  expect(wake.kind).toBe("refuse");
  expect(wake.reason).toBe("SleepInFlight");
  // Budget is still held, nothing changed
  expect(controller.snapshot().committedGiB).toBe(24);
});

test("#283 W14: the repro from #283 — committed never exceeds budget", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  // Two guarded 24 GiB members, a ready, b sleeping
  registerMember(controller, "a", "ready");
  registerMember(controller, "b", "sleeping");
  // requestSleep(a) -> a becomes sleep-pending, still charges 24 (sleep-pending
  // from ready keeps the reservation = 'resident' = 24 GiB)
  const sleepA = controller.requestSleep("a");
  expect(sleepA.kind).toBe("sleep");
  expect(controller.snapshot().committedGiB).toBe(24);
  // requestWake(a) on sleep-pending -> refused SleepInFlight
  const wakeA = controller.requestWake("a", { cacheIdentity: "ka" });
  expect(wakeA.kind).toBe("refuse");
  expect(wakeA.reason).toBe("SleepInFlight");
  // sleepSettled(a, 'slept') -> a goes to 'sleeping', released, committed 0
  controller.sleepSettled("a", "slept", "ka");
  expect(controller.snapshot().committedGiB).toBe(0);
  // requestWake(b) -> wake 24
  const wakeB = controller.requestWake("b", { cacheIdentity: "kb" });
  expect(wakeB.kind).toBe("wake");
  expect(wakeB.chargedGiB).toBe(24);
  // wakeSettled(b, 'ready') -> b resident, committed 24 (within budget)
  controller.wakeSettled("b", "ready");
  expect(controller.snapshot().committedGiB).toBe(24);
  // The budget was never exceeded: 24 <= 40
  expect(controller.snapshot().committedGiB).toBeLessThanOrEqual(40);
});

test("#283 W15: out-of-order wakeSettled on a non-waking member is ignored", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  registerMember(controller, "a", "sleeping");
  // Wake a -> state becomes 'waking'
  expect(controller.requestWake("a", { cacheIdentity: "ka" }).kind).toBe("wake");
  // Simulate a sleepSettled arriving before wakeSettled (out of order)
  controller.sleepSettled("a", "slept", "ka");
  // a was 'waking', not 'sleep-pending', so sleepSettled is ignored
  expect(snapMember(controller, "a").state).toBe("waking");
  expect(snapMember(controller, "a").reservation).toBe("pending");
  expect(controller.snapshot().committedGiB).toBe(24);
  // Now the proper wakeSettled applies
  controller.wakeSettled("a", "ready");
  expect(snapMember(controller, "a").state).toBe("ready");
  expect(snapMember(controller, "a").reservation).toBe("resident");
  expect(controller.snapshot().committedGiB).toBe(24);
});

test("#283 W16: out-of-order sleepSettled on a non-sleep-pending member is ignored", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  registerMember(controller, "a", "ready");
  // Sleep a -> state becomes 'sleep-pending'
  expect(controller.requestSleep("a").kind).toBe("sleep");
  // Simulate a wakeSettled arriving before sleepSettled (out of order)
  controller.wakeSettled("a", "ready");
  // a was 'sleep-pending', not 'waking', so wakeSettled is ignored
  expect(snapMember(controller, "a").state).toBe("sleep-pending");
  expect(snapMember(controller, "a").reservation).toBe("resident");
  expect(controller.snapshot().committedGiB).toBe(24);
  // Now the proper sleepSettled applies
  controller.sleepSettled("a", "slept", "ka");
  expect(snapMember(controller, "a").state).toBe("sleeping");
  expect(snapMember(controller, "a").reservation).toBe("released");
  expect(controller.snapshot().committedGiB).toBe(0);
});

test("#283 W17: requestSleep from 'waking' is refused with WakeInFlight", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  registerMember(controller, "a", "sleeping");
  expect(controller.requestWake("a", { cacheIdentity: "ka" }).kind).toBe("wake");
  expect(snapMember(controller, "a").state).toBe("waking");
  const sleep = controller.requestSleep("a");
  expect(sleep.kind).toBe("refuse");
  expect(sleep.reason).toBe("WakeInFlight");
  expect(controller.snapshot().committedGiB).toBe(24);
});

test("#283 W18: requestWake on 'sleeping' (not yet sleep-pending) goes through admission", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  registerMember(controller, "a", "sleeping");
  registerMember(controller, "b", "sleeping");
  // requestWake(a) -> a becomes 'waking', charges 24
  expect(controller.requestWake("a", { cacheIdentity: "ka" }).kind).toBe("wake");
  expect(controller.snapshot().committedGiB).toBe(24);
  // requestWake(b) -> budget exceeded
  const wakeB = controller.requestWake("b", { cacheIdentity: "kb" });
  expect(wakeB.kind).toBe("refuse");
  expect(wakeB.reason).toBe("BudgetExceeded");
  // Resolve a's wake first (a is 'waking', not 'sleep-pending', so sleepSettled
  // is ignored — only wakeSettled applies).
  controller.wakeSettled("a", "ready");
  // Now a is 'ready', reservation 'resident' (24 GiB still charged)
  expect(controller.snapshot().committedGiB).toBe(24);
  // Sleep a to release its reservation
  controller.requestSleep("a");
  controller.sleepSettled("a", "slept", "ka");
  expect(controller.snapshot().committedGiB).toBe(0);
  // Now b can wake
  const wakeB2 = controller.requestWake("b", { cacheIdentity: "kb" });
  expect(wakeB2.kind).toBe("wake");
  expect(wakeB2.chargedGiB).toBe(24);
  expect(controller.snapshot().committedGiB).toBe(24);
  expect(controller.snapshot().committedGiB).toBeLessThanOrEqual(40);
});

test("#283 W19: the full sleep->wake cycle with SleepInFlight guard", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  registerMember(controller, "a", "ready");
  // Sleep -> sleep-pending
  expect(controller.requestSleep("a").kind).toBe("sleep");
  expect(snapMember(controller, "a").state).toBe("sleep-pending");
  // Wake refused (SleepInFlight)
  const wakeRefused = controller.requestWake("a", { cacheIdentity: "ka" });
  expect(wakeRefused.kind).toBe("refuse");
  expect(wakeRefused.reason).toBe("SleepInFlight");
  // Sleep settles -> sleeping, released
  controller.sleepSettled("a", "slept", "ka");
  expect(snapMember(controller, "a").state).toBe("sleeping");
  expect(snapMember(controller, "a").reservation).toBe("released");
  // Now wake is allowed
  const wakeOk = controller.requestWake("a", { cacheIdentity: "ka" });
  expect(wakeOk.kind).toBe("wake");
  expect(wakeOk.chargedGiB).toBe(24);
  expect(snapMember(controller, "a").state).toBe("waking");
  // Wake settles -> ready, resident
  controller.wakeSettled("a", "ready");
  expect(snapMember(controller, "a").state).toBe("ready");
  expect(snapMember(controller, "a").reservation).toBe("resident");
  expect(controller.snapshot().committedGiB).toBe(24);
  // Full cycle budget: max 24, never exceeded 40
  expect(controller.snapshot().committedGiB).toBeLessThanOrEqual(40);
});

// ── DF-10 (#283) observe() pending-transition guards ────────────────────────

test("#283 W20: a stale 'sleeping' probe cannot release a waking member's reservation", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  registerMember(controller, "a", "sleeping");
  registerMember(controller, "b", "sleeping");
  expect(controller.requestWake("a", { cacheIdentity: "ka" }).kind).toBe("wake");
  expect(controller.snapshot().committedGiB).toBe(24);

  // The probe still reports 'sleeping' right after requestWake — it must not
  // downgrade the pending wake or free the reservation underneath it.
  controller.observe("a", "sleeping");
  expect(snapMember(controller, "a").state).toBe("waking");
  expect(snapMember(controller, "a").reservation).toBe("pending");
  expect(controller.snapshot().committedGiB).toBe(24);

  // The slot stays closed: a second wake is still refused and committed
  // never exceeds the budget (the #283 repro ended at 48 > 40).
  const wakeB = controller.requestWake("b", { cacheIdentity: "kb" });
  expect(wakeB.kind).toBe("refuse");
  expect(wakeB.reason).toBe("BudgetExceeded");
  expect(controller.snapshot().committedGiB).toBeLessThanOrEqual(40);

  // The gated probe is recorded in the audit.
  const audit = controller.snapshot().audit;
  expect(audit).toHaveLength(1);
  expect(audit[0]).toEqual({
    id: "a",
    observed: "sleeping",
    kept: "waking",
    reason: "WakeInFlight",
  });

  // The pending wake still settles normally.
  controller.wakeSettled("a", "ready");
  expect(snapMember(controller, "a").state).toBe("ready");
  expect(snapMember(controller, "a").reservation).toBe("resident");
  expect(controller.snapshot().committedGiB).toBe(24);
  expect(controller.snapshot().committedGiB).toBeLessThanOrEqual(40);
});

test("#283 W21: observe during waking accepts loading and ready, audits the rest", async () => {
  const mod = await load();
  const controller = ctl(mod, 200);
  for (const id of ["a", "b", "c", "d", "e"]) {
    registerMember(controller, id, "sleeping");
    expect(controller.requestWake(id, { cacheIdentity: `k${id}` }).kind).toBe("wake");
  }
  expect(controller.snapshot().committedGiB).toBe(120);

  controller.observe("a", "loading");
  controller.observe("b", "ready");
  controller.observe("c", "stopped");
  controller.observe("d", "sleeping");
  controller.observe("e", "unhealthy");

  expect(snapMember(controller, "a").state).toBe("waking");
  expect(snapMember(controller, "b").state).toBe("ready");
  expect(snapMember(controller, "b").reservation).toBe("resident");
  for (const id of ["c", "d", "e"]) {
    expect(snapMember(controller, id).state).toBe("waking");
    expect(snapMember(controller, id).reservation).toBe("pending");
  }
  expect(controller.snapshot().committedGiB).toBe(120);

  const audit = controller.snapshot().audit;
  expect(audit.map((entry) => `${entry.id}:${entry.observed}`)).toEqual([
    "c:stopped",
    "d:sleeping",
    "e:unhealthy",
  ]);
  for (const entry of audit) {
    expect(entry.kept).toBe("waking");
    expect(entry.reason).toBe("WakeInFlight");
  }

  // Every pending wake still resolves through its settle.
  controller.wakeSettled("a", "ready");
  controller.wakeSettled("b", "ready");
  controller.wakeSettled("c", "cancelled");
  controller.wakeSettled("d", "readiness-failed");
  controller.wakeSettled("e", "ready");
  expect(snapMember(controller, "a").state).toBe("ready");
  expect(snapMember(controller, "b").state).toBe("ready");
  expect(snapMember(controller, "c").state).toBe("unknown");
  expect(snapMember(controller, "d").state).toBe("unknown");
  expect(snapMember(controller, "e").state).toBe("ready");
});

test("#283 W22: observe during sleep-pending is gated until the settle", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  registerMember(controller, "a", "ready");
  registerMember(controller, "b", "sleeping");
  expect(controller.requestSleep("a").kind).toBe("sleep");
  expect(snapMember(controller, "a").state).toBe("sleep-pending");
  expect(controller.snapshot().committedGiB).toBe(24);

  // Every probe waits for the settle — including 'ready' (which would orphan
  // the pending sleep) and 'sleeping' (the settle outcome itself).
  for (const observed of ["ready", "sleeping", "stopped", "loading", "unhealthy"] as const) {
    controller.observe("a", observed);
    expect(snapMember(controller, "a").state).toBe("sleep-pending");
    expect(snapMember(controller, "a").reservation).toBe("resident");
  }
  expect(controller.snapshot().committedGiB).toBe(24);

  const audit = controller.snapshot().audit;
  expect(audit).toHaveLength(5);
  for (const entry of audit) {
    expect(entry.id).toBe("a");
    expect(entry.kept).toBe("sleep-pending");
    expect(entry.reason).toBe("SleepInFlight");
  }

  controller.sleepSettled("a", "slept", "ka");
  expect(snapMember(controller, "a").state).toBe("sleeping");
  expect(snapMember(controller, "a").reservation).toBe("released");
  expect(controller.snapshot().committedGiB).toBe(0);

  // After the settle, observe applies normally again.
  controller.observe("a", "ready");
  expect(snapMember(controller, "a").state).toBe("ready");
  expect(snapMember(controller, "a").reservation).toBe("resident");
  expect(controller.snapshot().committedGiB).toBe(24);
  const wakeB = controller.requestWake("b", { cacheIdentity: "kb" });
  expect(wakeB.kind).toBe("refuse");
  expect(wakeB.reason).toBe("BudgetExceeded");
});

test("#283 W23: requestSleep reports AlreadySleeping for asleep members", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  registerMember(controller, "s", "sleeping");
  const sleeping = controller.requestSleep("s");
  expect(sleeping.kind).toBe("refuse");
  expect(sleeping.reason).toBe("AlreadySleeping");

  registerMember(controller, "p", "ready");
  expect(controller.requestSleep("p").kind).toBe("sleep");
  const pending = controller.requestSleep("p");
  expect(pending.kind).toBe("refuse");
  expect(pending.reason).toBe("AlreadySleeping");
});

// ── DF-10 (#283) shared-runtime admission joins ────────────────────────────

const sharedRuntimeMember = (id: string): SleepMemberSpec => ({
  id,
  runtimeKey: "rk",
  specDigest: "d",
  allocationGiB: 10,
  capability: GUARDED,
});

test("#283 W24: waking a sleeper whose runtime is already resident joins without a second charge", async () => {
  const mod = await load();
  const controller = ctl(mod, 15);
  controller.register(sharedRuntimeMember("a"), "ready");
  controller.register(sharedRuntimeMember("b"), "sleeping");
  expect(controller.snapshot().committedGiB).toBe(10);

  const wakeB = controller.requestWake("b", { cacheIdentity: "kb" });
  expect(wakeB.kind).toBe("already-awake");
  expect(snapMember(controller, "b").state).toBe("ready");
  // One runtime, one charge: the join must not push committed to 20 > 15.
  expect(controller.snapshot().committedGiB).toBe(10);
  expect(controller.snapshot().committedGiB).toBeLessThanOrEqual(15);

  // The joiner can still sleep; the resident sibling keeps the single charge.
  expect(controller.requestSleep("b").kind).toBe("sleep");
  controller.sleepSettled("b", "slept", "kb");
  expect(snapMember(controller, "b").state).toBe("sleeping");
  expect(controller.snapshot().committedGiB).toBe(10);
  expect(controller.snapshot().committedGiB).toBeLessThanOrEqual(15);
});

test("#283 W25: a second wake on a shared runtime joins the pending wake without a second charge", async () => {
  const mod = await load();
  const controller = ctl(mod, 15);
  controller.register(sharedRuntimeMember("a"), "sleeping");
  controller.register(sharedRuntimeMember("b"), "sleeping");
  controller.register(
    { id: "c", runtimeKey: "rc", specDigest: "dc", allocationGiB: 10, capability: GUARDED },
    "sleeping",
  );

  const wakeA = controller.requestWake("a", { cacheIdentity: "ka" });
  expect(wakeA.kind).toBe("wake");
  expect(controller.snapshot().committedGiB).toBe(10);

  const wakeB = controller.requestWake("b", { cacheIdentity: "kb" });
  expect(wakeB.kind).toBe("join-wake");
  expect(snapMember(controller, "b").state).toBe("waking");
  expect(controller.snapshot().committedGiB).toBe(10);
  expect(controller.snapshot().committedGiB).toBeLessThanOrEqual(15);

  // Both members settle on the single shared wake; still one charge.
  controller.wakeSettled("a", "ready");
  controller.wakeSettled("b", "ready");
  expect(controller.snapshot().committedGiB).toBe(10);
  expect(controller.snapshot().committedGiB).toBeLessThanOrEqual(15);

  // A distinct runtime is still charged and budget-checked on its own.
  const wakeC = controller.requestWake("c", { cacheIdentity: "kc" });
  expect(wakeC.kind).toBe("refuse");
  expect(wakeC.reason).toBe("BudgetExceeded");
  expect(controller.snapshot().committedGiB).toBe(10);
});

test("#283 W26: a same-runtimeKey member with a different specDigest is refused WorkloadBusy", async () => {
  const mod = await load();
  const controller = ctl(mod, 40);
  controller.register(sharedRuntimeMember("a"), "ready");
  controller.register(
    { id: "b", runtimeKey: "rk", specDigest: "other", allocationGiB: 10, capability: GUARDED },
    "sleeping",
  );
  const wakeB = controller.requestWake("b", { cacheIdentity: "kb" });
  expect(wakeB.kind).toBe("refuse");
  expect(wakeB.reason).toBe("WorkloadBusy");
  expect(controller.snapshot().committedGiB).toBe(10);
});
