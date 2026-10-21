import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedEnv } from "../../src/types.js";

import {
  emptyModelHostRuntimeStatus,
  modelhostConditionsFile,
  readModelHostRuntimeStatus,
  recordModelHostOomKill,
  recordModelHostReconcileError,
  recordModelHostReconcileRecovered,
  recordModelHostRestart,
  withOomKill,
  withReconcileError,
  withReconcileRecovered,
  withRestart,
} from "../../src/engines/conditions.js";
import { removeModelHostState, writeModelHostState } from "../../src/engines/state.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

const KEY = { name: "strata-host" };
const T0 = "2026-10-21T14:07:00.000Z";
const T1 = "2026-10-21T14:07:10.000Z";
const T2 = "2026-10-21T14:22:00.000Z";
const MISMATCH = { reason: "StartFailed", message: "strata run-config --native must be A; got B" };

describe("condition transitions", () => {
  test("a ReconcileError episode counts failing passes and keeps firstSeen", () => {
    const first = withReconcileError(emptyModelHostRuntimeStatus(), MISMATCH, T0);
    const second = withReconcileError(first, MISMATCH, T1);
    expect(second.conditions).toEqual([
      {
        type: "ReconcileError",
        status: "True",
        reason: "StartFailed",
        message: MISMATCH.message,
        firstSeen: T0,
        lastSeen: T1,
        lastTransitionTime: T0,
        count: 2,
      },
    ]);
  });

  test("recovery flips the condition to False and keeps the last error", () => {
    const failing = withReconcileError(emptyModelHostRuntimeStatus(), MISMATCH, T0);
    const recovered = withReconcileRecovered(failing, "Recovered", T2);
    expect(recovered?.conditions[0]).toMatchObject({
      status: "False",
      reason: "Recovered",
      message: MISMATCH.message,
      firstSeen: T0,
      lastTransitionTime: T2,
      count: 1,
    });
  });

  test("recovery is a no-op without an active error", () => {
    expect(withReconcileRecovered(emptyModelHostRuntimeStatus(), "Recovered", T0)).toBeNull();
    const failing = withReconcileError(emptyModelHostRuntimeStatus(), MISMATCH, T0);
    const recovered = withReconcileRecovered(failing, "Recovered", T1);
    expect(recovered && withReconcileRecovered(recovered, "Recovered", T2)).toBeNull();
  });

  test("an error after recovery opens a new episode", () => {
    const failing = withReconcileError(emptyModelHostRuntimeStatus(), MISMATCH, T0);
    const recovered = withReconcileRecovered(failing, "Recovered", T1);
    const again = withReconcileError(recovered ?? failing, MISMATCH, T2);
    expect(again.conditions[0]).toMatchObject({
      status: "True",
      firstSeen: T2,
      lastTransitionTime: T2,
      count: 1,
    });
  });

  test("OOMKilled accumulates and records the cgroup counter", () => {
    const once = withOomKill(emptyModelHostRuntimeStatus(), 1, T0);
    const twice = withOomKill(once, 2, T2);
    expect(twice.conditions).toEqual([
      {
        type: "OOMKilled",
        status: "True",
        reason: "CgroupOOMKill",
        message: "engine was OOM-killed (cgroup oom_kill 2)",
        firstSeen: T0,
        lastSeen: T2,
        lastTransitionTime: T0,
        count: 2,
        cgroupOomKill: 2,
      },
    ]);
  });

  test("conditions of different types coexist", () => {
    const both = withOomKill(
      withReconcileError(emptyModelHostRuntimeStatus(), MISMATCH, T0),
      1,
      T1,
    );
    expect(both.conditions.map((c) => c.type)).toEqual(["ReconcileError", "OOMKilled"]);
  });

  test("restarts count up with the latest reason", () => {
    const once = withRestart(emptyModelHostRuntimeStatus(), "EngineExited", T0);
    expect(withRestart(once, "SpecChanged", T1)).toMatchObject({
      restarts: 2,
      lastRestartAt: T1,
      lastRestartReason: "SpecChanged",
    });
  });
});

describe("conditions sidecar", () => {
  let tmp: string;
  let env: ResolvedEnv;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "llamactl-conditions-"));
    env = { LOCAL_AI_RUNTIME_DIR: tmp } as ResolvedEnv;
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("lives beside modelhost.state", () => {
    expect(modelhostConditionsFile(env, KEY)).toBe(
      join(tmp, "workloads", KEY.name, "modelhost.conditions.json"),
    );
  });

  test("records, reads back, and recovers", () => {
    expect(readModelHostRuntimeStatus(KEY, env)).toBeNull();
    recordModelHostReconcileError(KEY, MISMATCH, env, new Date(T0));
    recordModelHostReconcileError(KEY, MISMATCH, env, new Date(T1));
    recordModelHostOomKill(KEY, 4, env, new Date(T1));
    recordModelHostRestart(KEY, "EngineExited", env, new Date(T2));
    recordModelHostReconcileRecovered(KEY, "Recovered", env, new Date(T2));
    const record = readModelHostRuntimeStatus(KEY, env);
    expect(record).toMatchObject({
      restarts: 1,
      lastRestartAt: T2,
      lastRestartReason: "EngineExited",
    });
    expect(record?.conditions).toEqual([
      expect.objectContaining({ type: "OOMKilled", count: 1, cgroupOomKill: 4 }),
      expect.objectContaining({ type: "ReconcileError", status: "False", count: 2 }),
    ]);
  });

  test("a healthy pass does not create the sidecar", () => {
    recordModelHostReconcileRecovered(KEY, "Recovered", env, new Date(T0));
    expect(existsSync(modelhostConditionsFile(env, KEY))).toBe(false);
  });

  test("survives removeModelHostState", () => {
    writeModelHostState(
      {
        kind: "ModelHost",
        engine: "strata",
        pid: 4242,
        host: "127.0.0.1",
        port: 8080,
        modelAliases: ["m.gguf"],
        startedAt: T0,
      },
      KEY,
      env,
    );
    recordModelHostOomKill(KEY, 1, env, new Date(T0));
    removeModelHostState(KEY, env);
    expect(readModelHostRuntimeStatus(KEY, env)?.conditions[0]?.type).toBe("OOMKilled");
  });

  test("drops malformed entries and reads a corrupt file as absent", () => {
    const file = modelhostConditionsFile(env, KEY);
    recordModelHostRestart(KEY, "SpecChanged", env, new Date(T0));
    writeFileSync(
      file,
      JSON.stringify({
        conditions: [
          { type: "OOMKilled" },
          withOomKill(emptyModelHostRuntimeStatus(), 1, T0).conditions[0],
        ],
        restarts: "many",
        lastRestartReason: "Whatever",
      }),
    );
    expect(readModelHostRuntimeStatus(KEY, env)).toEqual({
      conditions: [withOomKill(emptyModelHostRuntimeStatus(), 1, T0).conditions[0]!],
      restarts: 0,
      lastRestartAt: null,
      lastRestartReason: null,
    });
    writeFileSync(file, "{corrupt");
    expect(readModelHostRuntimeStatus(KEY, env)).toBeNull();
  });
});
