/**
 * #517 (DF-03 amendment) — GREEN store-level contract for the already-landed
 * 8-state residency lifecycle (#662/#676 store, core lifecycle.ts, coordinator
 * mapState). Where store-lifecycle.test.ts opened the surface while it was RED,
 * this file pins the landed behavior across four axes the reconciler depends on:
 *   C1 the full transition table, state by state (the failed row is owned by C3);
 *   C2 a best-effort cross-process race under a held IMMEDIATE write lock, run
 *      through the residency-race-worker fixture;
 *   C3 failed + recovery under a fence change, plus the occupying-state set;
 *   C4 a full-state round-trip that survives close and reopen.
 * Each axis is pinned so a single documented source mutation (M1..M4) kills it.
 */

import type { ReadableStreamDefaultReader as WebStreamReader } from "node:stream/web";

import {
  isLegalResidencyTransition,
  isOccupyingResidencyState,
  OCCUPYING_RESIDENCY_STATES,
  RESIDENCY_STATES,
  type ResidencyState,
} from "@llamactl/core/residency/lifecycle";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openResidencyOperationStore,
  type ResidencyStateRecord,
  type TransitionResidencyStateResult,
} from "../../src/residency/store.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

const GROUP = "z13-large-gpu";
const WORKER = join(import.meta.dir, "..", "fixtures", "residency-race-worker.ts");
const BUN = process.execPath;

// The operational transition table, pinned independently of RESIDENCY_TRANSITIONS
// so an edit to the source table breaks C1. The failed row is intentionally
// absent here; C3 owns every claim about `failed` so its two mutations land only
// there. Every value matches the shipped RESIDENCY_TRANSITIONS rows.
const EXPECTED_TABLE: Readonly<
  Record<Exclude<ResidencyState, "failed">, readonly ResidencyState[]>
> = {
  unavailable: ["downloaded"],
  downloaded: ["loading", "unavailable"],
  loading: ["warming", "failed", "unloading"],
  warming: ["ready", "failed", "unloading"],
  ready: ["draining", "failed"],
  draining: ["unloading", "failed"],
  unloading: ["downloaded", "failed"],
};

type RaceOutcome = { ok: boolean; reason: string | null; version: number | null };

type Contender = {
  exited: Promise<number>;
  stdin: Bun.FileSink;
  stderrStream: ReadableStream<Uint8Array>;
  lines: LineReader;
};

type LineReader = {
  reader: WebStreamReader<Uint8Array>;
  decoder: TextDecoder;
  buffer: string;
};

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "residency-contract-"));
});

afterEach(() => {
  if (dir !== "") {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function openStore(name: string): ReturnType<typeof openResidencyOperationStore> {
  return openResidencyOperationStore({ path: join(dir, name) });
}

function walk(
  store: ReturnType<typeof openResidencyOperationStore>,
  fenceToken: number,
  model: string,
  states: readonly ResidencyState[],
  group: string | undefined,
  startVersion = 0,
): void {
  for (const [index, to] of states.entries()) {
    const result = store.transitionResidencyState({
      fenceToken,
      model,
      ...(group === undefined ? {} : { group }),
      to,
      expectedVersion: startVersion + index,
      nowMs: 1000 + index,
    });
    expect(result.ok).toBe(true);
  }
}

function makeLineReader(stdout: ReadableStream<Uint8Array>): LineReader {
  return { reader: stdout.getReader(), decoder: new TextDecoder(), buffer: "" };
}

async function nextLine(source: LineReader): Promise<string | null> {
  for (;;) {
    const newline = source.buffer.indexOf("\n");
    if (newline >= 0) {
      const line = source.buffer.slice(0, newline);
      source.buffer = source.buffer.slice(newline + 1);
      return line;
    }
    const chunk = await source.reader.read();
    if (chunk.done) {
      if (source.buffer.length > 0) {
        const line = source.buffer;
        source.buffer = "";
        return line;
      }
      return null;
    }
    source.buffer += source.decoder.decode(chunk.value, { stream: true });
  }
}

function raceOutcome(raw: string): RaceOutcome {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("race worker emitted a non-object result");
  }
  const shape = parsed as Record<string, unknown>;
  if (shape["ok"] === true) {
    const record = shape["record"];
    const version =
      typeof record === "object" && record !== null
        ? (record as Record<string, unknown>)["version"]
        : null;
    return { ok: true, reason: null, version: typeof version === "number" ? version : null };
  }
  const reason = shape["reason"];
  return { ok: false, reason: typeof reason === "string" ? reason : null, version: null };
}

function workerEnv(dbPath: string, model: string, nowMs: number): Record<string, string> {
  return {
    ...process.env,
    RESIDENCY_RACE_DB: dbPath,
    RESIDENCY_RACE_MODEL: model,
    RESIDENCY_RACE_TO: "downloaded",
    RESIDENCY_RACE_GROUP: GROUP,
    RESIDENCY_RACE_FENCE: "1",
    RESIDENCY_RACE_EXPECTED_VERSION: "0",
    RESIDENCY_RACE_NOW: String(nowMs),
  };
}

function spawnWorker(dbPath: string, model: string, nowMs: number): Contender {
  const child = Bun.spawn({
    cmd: [BUN, WORKER],
    env: workerEnv(dbPath, model, nowMs),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exited: child.exited,
    stdin: child.stdin,
    stderrStream: child.stderr,
    lines: makeLineReader(child.stdout),
  };
}

async function sendGo(sink: Bun.FileSink): Promise<void> {
  await sink.write("go\n");
  await sink.flush();
  await sink.end();
}

async function spawnReady(dbPath: string, model: string, nowMs: number): Promise<Contender> {
  const contender = spawnWorker(dbPath, model, nowMs);
  expect(await nextLine(contender.lines)).toBe("ready");
  return contender;
}

describe("residency lifecycle store contract (#517)", () => {
  // M1 (warming row loses "unloading") and M1b (unavailable row gains "ready").
  test("C1 the transition table is pinned for every state but failed", () => {
    for (const from of RESIDENCY_STATES) {
      if (from === "failed") {
        continue;
      }
      const legal = EXPECTED_TABLE[from];
      for (const to of RESIDENCY_STATES) {
        const expected = legal.includes(to);
        expect(isLegalResidencyTransition(from, to)).toBe(expected);
      }
    }
  });

  // M2 (transition transaction demoted from IMMEDIATE to deferred).
  test("C2 two processes racing one CAS row: the write lock admits exactly one winner", async () => {
    const dbPath = join(dir, "race.sqlite");
    const owner = openResidencyOperationStore({ path: dbPath });
    try {
      expect(owner.claimOwnership({ ownerId: "o1", incarnation: "i1" }).fenceToken).toBe(1);
    } finally {
      owner.close();
    }

    // Serialize the opens (two live migrators would collide on the schema), so
    // the only thing the contenders still share is the go barrier: both sit
    // ready, then fire the same CAS row together.
    const first = await spawnReady(dbPath, "race-model", 1000);
    const second = await spawnReady(dbPath, "race-model", 1001);
    const contenders = [first, second];
    for (const contender of contenders) {
      await sendGo(contender.stdin);
    }

    const outcomes: RaceOutcome[] = [];
    for (const contender of contenders) {
      const line = await nextLine(contender.lines);
      if (line === null) {
        throw new Error("race worker closed stdout before sending an outcome");
      }
      outcomes.push(raceOutcome(line));
      expect(await contender.exited).toBe(0);
    }

    const winners = outcomes.filter((outcome) => outcome.ok);
    const losers = outcomes.filter((outcome) => !outcome.ok);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(winners[0]?.version).toBe(1);
    expect(losers[0]?.reason).toBe("version-conflict");

    const reader = openResidencyOperationStore({ path: dbPath });
    try {
      expect(reader.listResidencyStates().length).toBe(1);
      expect(reader.getResidencyState("race-model")).toMatchObject({
        group: GROUP,
        state: "downloaded",
        version: 1,
      });
    } finally {
      reader.close();
    }
  }, 30_000);

  // M3 (OCCUPYING_RESIDENCY_STATES gains "failed") and M3b (RESIDENCY_TRANSITIONS
  // failed row gains "loading").
  test("C3 failed is not occupying, cannot revive to loading, and recovers under a new fence", () => {
    const store = openStore("failed.sqlite");
    try {
      expect([...OCCUPYING_RESIDENCY_STATES]).toEqual(["loading", "warming", "ready"]);
      expect(isOccupyingResidencyState("failed")).toBe(false);
      expect(isOccupyingResidencyState("draining")).toBe(false);
      expect(isLegalResidencyTransition("failed", "downloaded")).toBe(true);
      expect(isLegalResidencyTransition("failed", "unavailable")).toBe(true);
      expect(isLegalResidencyTransition("failed", "loading")).toBe(false);

      store.claimOwnership({ ownerId: "o1", incarnation: "i1" });
      walk(store, 1, "glm", ["downloaded", "loading", "warming", "ready"], GROUP);
      walk(store, 1, "mimo", ["downloaded"], GROUP);

      const failed = store.transitionResidencyState({
        fenceToken: 1,
        model: "glm",
        group: GROUP,
        to: "failed",
        expectedVersion: 4,
        nowMs: 2000,
      });
      expect(failed.ok).toBe(true);
      if (failed.ok) {
        expect(failed.record).toMatchObject({ state: "failed", version: 5 });
      }

      const revive = store.transitionResidencyState({
        fenceToken: 1,
        model: "glm",
        group: GROUP,
        to: "loading",
        expectedVersion: 5,
        nowMs: 2100,
      });
      expect(revive).toMatchObject({
        ok: false,
        reason: "lifecycle-refused",
        decision: { reason: "IllegalTransition", from: "failed", to: "loading" },
      });

      const admitted = store.transitionResidencyState({
        fenceToken: 1,
        model: "mimo",
        group: GROUP,
        to: "loading",
        expectedVersion: 1,
        nowMs: 2200,
      });
      expect(admitted.ok).toBe(true);
      if (admitted.ok) {
        expect(admitted.record).toMatchObject({ state: "loading", version: 2 });
      }

      expect(store.claimOwnership({ ownerId: "o2", incarnation: "i2" }).fenceToken).toBe(2);
      const stale = store.transitionResidencyState({
        fenceToken: 1,
        model: "glm",
        group: GROUP,
        to: "downloaded",
        expectedVersion: 5,
        nowMs: 3000,
      });
      expect(stale).toEqual({ ok: false, reason: "stale-fence" });

      const recovered = store.transitionResidencyState({
        fenceToken: 2,
        model: "glm",
        group: GROUP,
        to: "downloaded",
        expectedVersion: 5,
        nowMs: 3100,
      });
      expect(recovered.ok).toBe(true);
      if (recovered.ok) {
        expect(recovered.record).toMatchObject({ state: "downloaded", version: 6 });
      }

      const blocked = store.transitionResidencyState({
        fenceToken: 2,
        model: "glm",
        group: GROUP,
        to: "loading",
        expectedVersion: 6,
        nowMs: 3200,
      });
      expect(blocked).toMatchObject({
        ok: false,
        reason: "lifecycle-refused",
        decision: { reason: "ExclusiveGroupOccupied", peer: { id: "mimo", state: "loading" } },
      });

      walk(store, 2, "mimo", ["unloading"], GROUP, 2);
      const rearmed = store.transitionResidencyState({
        fenceToken: 2,
        model: "glm",
        group: GROUP,
        to: "loading",
        expectedVersion: 6,
        nowMs: 3300,
      });
      expect(rearmed.ok).toBe(true);
      if (rearmed.ok) {
        expect(rearmed.record).toMatchObject({ state: "loading", version: 7 });
      }
    } finally {
      store.close();
    }
  });

  // M4 (listResidencyStates ORDER BY model ASC flipped to DESC).
  test("C4 a full-state walk round-trips sorted through close and reopen", () => {
    const dbPath = join(dir, "roundtrip.sqlite");
    const first = openResidencyOperationStore({ path: dbPath });
    let before: ResidencyStateRecord[] = [];
    try {
      first.claimOwnership({ ownerId: "o1", incarnation: "i1" });
      walk(
        first,
        1,
        "b-model",
        ["downloaded", "loading", "warming", "ready", "failed", "downloaded"],
        undefined,
      );
      walk(first, 1, "c-model", ["downloaded", "loading"], undefined);
      walk(first, 1, "a-model", ["downloaded"], undefined);
      before = first.listResidencyStates();
      expect(before.map((record) => record.model)).toEqual(["a-model", "b-model", "c-model"]);
      expect(before.map((record) => record.state)).toEqual(["downloaded", "downloaded", "loading"]);
    } finally {
      first.close();
    }

    const reopened = openResidencyOperationStore({ path: dbPath });
    try {
      const after = reopened.listResidencyStates();
      expect(after).toEqual(before);
      expect(after.map((record) => record.model)).toEqual(["a-model", "b-model", "c-model"]);
      for (const record of after) {
        expect(record.group).toBeNull();
        expect(record.ownerId).toBe("o1");
        expect(record.incarnation).toBe("i1");
      }
      expect(reopened.claimOwnership({ ownerId: "o2", incarnation: "i2" }).fenceToken).toBe(2);
      const result: TransitionResidencyStateResult = reopened.transitionResidencyState({
        fenceToken: 2,
        model: "a-model",
        to: "loading",
        expectedVersion: 1,
        nowMs: 4000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.record).toMatchObject({ state: "loading", version: 2, ownerId: "o2" });
      }
    } finally {
      reopened.close();
    }
  });
});
