import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateManagedProfileStart,
  managedProfileMemberProfiles,
  managedProfileTargetState,
  readManagedProfileSelection,
} from "../../src/residency/managed-profile-selection.js";
import {
  recoverProfileSwitchOperations,
  recoverProfileSwitchOperationsUnverified,
} from "../../src/residency/recovery.js";
import { openResidencyOperationStore } from "../../src/residency/store.js";
import { mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

const identity = { ownerId: "profile-manager", incarnation: "one" };
const node = "owner-node";
const key = `profile-switch:${node}`;

type Store = ReturnType<typeof openResidencyOperationStore>;
function temporaryStore(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "managed-profile-"));
  return {
    path: join(dir, "operations.sqlite"),
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function begin(
  store: Store,
  operationId: string,
  targetState: string,
  nowMs = 100,
  model = key,
): { operationId: string; fenceToken: number; nowMs: number; expectedVersion: number } {
  const result = store.claimAndBeginOperation(identity, {
    operationId,
    model,
    targetState,
    nowMs,
    desiredRevision: 0,
    reservationGiB: 0,
  });
  if (!result.ok) throw new Error(`begin failed: ${result.reason}`);
  return {
    operationId,
    fenceToken: result.record.fenceToken,
    nowMs,
    expectedVersion: result.record.version,
  };
}

type Switch = ReturnType<typeof begin>;
type Outcome = Parameters<Store["finishOperation"]>[0]["outcome"];

function commit(store: Store, op: Switch): Switch {
  expect(store.commitReservation(op)).toEqual({ ok: true });
  return { ...op, expectedVersion: op.expectedVersion + 1 };
}

function finish(store: Store, op: Switch, outcome: Outcome): void {
  expect(store.finishOperation({ ...op, outcome })).toEqual({ ok: true });
}

test("the newest succeeded managed profile survives a reopen and ignores legacy terminal rows", () => {
  const { path, cleanup } = temporaryStore();
  try {
    const store = openResidencyOperationStore({ path });
    try {
      finish(
        store,
        commit(store, begin(store, "first", managedProfileTargetState("chat"), 200)),
        "succeeded",
      );
      finish(
        store,
        commit(store, begin(store, "second", managedProfileTargetState("vision"), 100)),
        "succeeded",
      );
      finish(store, commit(store, begin(store, "legacy", "profile:chat", 400)), "succeeded");
    } finally {
      store.close();
    }
    const selected = readManagedProfileSelection(path, node);
    expect(selected).toEqual({ kind: "selected", profile: "vision", operationId: "second" });
    expect(evaluateManagedProfileStart(selected, ["chat"])).toMatchObject({
      ok: false,
      reason: "ProfileInactive",
    });
    expect(evaluateManagedProfileStart(selected, ["chat", "vision"])).toEqual({ ok: true });
    expect(evaluateManagedProfileStart(selected, [])).toEqual({ ok: true });
    expect(
      evaluateManagedProfileStart(selected, ["vision"], { operationId: "second", fenceToken: 1 }),
    ).toMatchObject({
      ok: false,
      reason: "ProfileSwitchBusy",
    });
    expect(readManagedProfileSelection(path, "another-node")).toEqual({ kind: "unselected" });
  } finally {
    cleanup();
  }
});

test("a competing committed selection invalidates an older reservation without moving the fence", () => {
  const { path, cleanup } = temporaryStore();
  const planner = openResidencyOperationStore({ path });
  const competitor = openResidencyOperationStore({ path });
  try {
    const profile = managedProfileTargetState("chat");
    const previous = commit(planner, begin(planner, "prior", profile));
    finish(planner, previous, "succeeded");
    const stale = {
      operationId: "stale-reservation",
      model: key,
      targetState: managedProfileTargetState("vision"),
      desiredRevision: 0,
      reservationGiB: 1,
      nowMs: 400,
      nodeBudgetGiB: 8,
      expectedManagedProfileOperationId: previous.operationId,
    };
    const concurrent = commit(competitor, begin(competitor, "newer", profile, 300));
    finish(competitor, concurrent, "succeeded");

    expect(planner.claimAndBeginOperation(identity, stale)).toEqual({
      ok: false,
      reason: "profile-selection-changed",
    });
    expect(planner.getOperation(stale.operationId)).toBeNull();
    expect(planner.currentFence()?.fenceToken).toBe(concurrent.fenceToken);
    expect(planner.listNonterminal()).toEqual([]);
    expect(readManagedProfileSelection(path, node)).toEqual({
      kind: "selected",
      profile: "chat",
      operationId: concurrent.operationId,
    });
  } finally {
    planner.close();
    competitor.close();
    cleanup();
  }
});

test("only the current committed managed switch permit can start a member of its target", () => {
  const { path, cleanup } = temporaryStore();
  const store = openResidencyOperationStore({ path });
  try {
    finish(
      store,
      commit(store, begin(store, "previous", managedProfileTargetState("chat"))),
      "succeeded",
    );
    const switchOp = begin(store, "change", managedProfileTargetState("vision"));
    const pending = readManagedProfileSelection(path, node);
    expect(evaluateManagedProfileStart(pending, ["vision"], switchOp)).toMatchObject({
      ok: false,
      reason: "ProfileSwitchBusy",
      operationId: "change",
    });
    expect(evaluateManagedProfileStart(pending, ["chat"])).toMatchObject({
      ok: false,
      reason: "ProfileSwitchBusy",
    });
    expect(evaluateManagedProfileStart(pending, [])).toEqual({ ok: true });

    const committed = commit(store, switchOp);
    const during = readManagedProfileSelection(path, node);
    expect(evaluateManagedProfileStart(during, ["vision"], committed)).toEqual({ ok: true });
    expect(evaluateManagedProfileStart(during, ["chat"], committed)).toMatchObject({
      ok: false,
      reason: "ProfileSwitchBusy",
    });
    expect(
      evaluateManagedProfileStart(during, ["vision"], { ...committed, operationId: "other" }),
    ).toMatchObject({
      ok: false,
      reason: "ProfileSwitchBusy",
    });
    store.claimOwnership({ ...identity, incarnation: "two" });
    expect(
      evaluateManagedProfileStart(readManagedProfileSelection(path, node), ["vision"], committed),
    ).toMatchObject({
      ok: false,
      reason: "ProfileSwitchBusy",
      operationId: "change",
    });
  } finally {
    store.close();
    cleanup();
  }
});

test("pre-dispatch boot recovery preserves selection while committed and terminal-unknown dispatch stay held", () => {
  const { path, cleanup } = temporaryStore();
  const store = openResidencyOperationStore({ path });
  try {
    finish(
      store,
      commit(store, begin(store, "initial", managedProfileTargetState("chat"))),
      "succeeded",
    );
    const pending = begin(store, "interrupted-early", managedProfileTargetState("vision"));
    const secondOwner = store.claimOwnership({ ...identity, incarnation: "two" });
    const recovered = recoverProfileSwitchOperationsUnverified({
      store,
      fenceToken: secondOwner.fenceToken,
      nowMs: () => 300,
    });
    expect(recovered.recovered).toMatchObject([
      { operationId: pending.operationId, outcome: "unknown", recorded: true },
    ]);
    expect(readManagedProfileSelection(path, node)).toEqual({
      kind: "selected",
      profile: "chat",
      operationId: "initial",
    });

    const dispatched = commit(
      store,
      begin(store, "interrupted-dispatch", managedProfileTargetState("vision")),
    );
    const thirdOwner = store.claimOwnership({ ...identity, incarnation: "three" });
    const interrupted = recoverProfileSwitchOperationsUnverified({
      store,
      fenceToken: thirdOwner.fenceToken,
      nowMs: () => 400,
    });
    expect(interrupted.dispatchUnverified).toBe(1);
    const running = readManagedProfileSelection(path, node);
    expect(evaluateManagedProfileStart(running, ["chat"])).toMatchObject({
      ok: false,
      reason: "ProfileSwitchBusy",
    });

    finish(store, { ...dispatched, fenceToken: thirdOwner.fenceToken }, "unknown");
    const unknown = readManagedProfileSelection(path, node);
    expect(unknown).toEqual({ kind: "unknown", operationId: "interrupted-dispatch" });
    expect(evaluateManagedProfileStart(unknown, ["chat"])).toMatchObject({
      ok: false,
      reason: "ProfileSelectionUnknown",
    });
    expect(evaluateManagedProfileStart(unknown, ["vision"], dispatched)).toMatchObject({
      ok: false,
      reason: "ProfileSelectionUnknown",
    });
  } finally {
    store.close();
    cleanup();
  }
});

test("a read failure is unknown and a missing store stays absent", async () => {
  const { path, cleanup } = temporaryStore();
  try {
    expect(readManagedProfileSelection(path, node)).toEqual({ kind: "unselected" });
    expect(await Bun.file(path).exists()).toBe(false);
    writeFileSync(path, "not a SQLite store");
    const malformed = readManagedProfileSelection(path, node);
    expect(malformed).toMatchObject({ kind: "unknown" });
    expect(evaluateManagedProfileStart(malformed, [])).toEqual({ ok: true });
    expect(evaluateManagedProfileStart(malformed, ["chat"])).toMatchObject({
      ok: false,
      reason: "ProfileSelectionUnknown",
    });
  } finally {
    cleanup();
  }
});

test("profile membership honors protected workloads and the shared annotation syntax", () => {
  const annotations = { "llamactl.io/residency-profiles": " chat, vision,chat,  " };
  expect(managedProfileMemberProfiles(annotations)).toEqual(["chat", "vision"]);
  expect(
    managedProfileMemberProfiles({ ...annotations, "llamactl.io/residency-protected": "true" }),
  ).toEqual([]);
  expect(managedProfileMemberProfiles()).toEqual([]);
});

test("a legacy in-flight switch holds profile starts but cannot authorize a managed permit", () => {
  const { path, cleanup } = temporaryStore();
  const store = openResidencyOperationStore({ path });
  try {
    const committed = commit(store, begin(store, "legacy", "profile:chat"));
    const selection = readManagedProfileSelection(path, node);
    expect(evaluateManagedProfileStart(selection, ["chat"], committed)).toMatchObject({
      ok: false,
      reason: "ProfileSwitchBusy",
      operationId: "legacy",
    });
    expect(evaluateManagedProfileStart(selection, [])).toEqual({ ok: true });
  } finally {
    store.close();
    cleanup();
  }
});

test("generic readiness cannot publish a managed pre-dispatch intent", async () => {
  const { path, cleanup } = temporaryStore();
  const store = openResidencyOperationStore({ path });
  try {
    finish(
      store,
      commit(store, begin(store, "prior", managedProfileTargetState("chat"))),
      "succeeded",
    );
    begin(store, "never-dispatched", managedProfileTargetState("vision"));
    const newFence = store.claimOwnership({ ...identity, incarnation: "two" });
    const recovered = await recoverProfileSwitchOperations({
      store,
      fenceToken: newFence.fenceToken,
      verifyTargetReady: () => true,
    });
    expect(recovered.recovered).toMatchObject([
      { operationId: "never-dispatched", outcome: "unknown" },
    ]);
    expect(readManagedProfileSelection(path, node)).toEqual({
      kind: "selected",
      profile: "chat",
      operationId: "prior",
    });
  } finally {
    store.close();
    cleanup();
  }
});
