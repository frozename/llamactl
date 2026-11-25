// #806 phase 3: `scopeUnit` round-trips through the ModelHostStarting and
// ModelHostState record validators and is dropped when malformed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedEnv } from "../../src/types.js";

import {
  modelhostStartingFile,
  type ModelHostStartingState,
  type ModelHostState,
  modelhostStateFile,
  readModelHostStarting,
  readModelHostState,
  writeModelHostStarting,
  writeModelHostState,
} from "../../src/engines/state.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { readServerState } from "../../src/server.js";
import { workloadRuntimeDir } from "../../src/workloadRuntime.js";

const KEY = { name: "scope-unit-host" };
const UNIT = "llamactl-engine-gufo-0123456789ab.scope";

let tmp: string;
let env: ResolvedEnv;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-scope-unit-"));
  env = { LOCAL_AI_RUNTIME_DIR: tmp } as ResolvedEnv;
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

const STARTING: ModelHostStartingState = {
  kind: "ModelHostStarting",
  engine: "llamacpp",
  pid: 4242,
  startedAt: "2026-05-19T00:00:00Z",
};

const STATE: ModelHostState = {
  kind: "ModelHost",
  engine: "llamacpp",
  pid: 4321,
  host: "127.0.0.1",
  port: 8095,
  modelAliases: ["model.gguf"],
  startedAt: "2026-05-19T00:00:00Z",
};

describe("scopeUnit on the starting record", () => {
  test("round-trips a valid scopeUnit as the last key", () => {
    const record: ModelHostStartingState = { ...STARTING, scopeUnit: UNIT };
    writeModelHostStarting(record, KEY, env);
    const got = readModelHostStarting(KEY, env);
    expect(got).toEqual(record);
    expect(Object.keys(got!).at(-1)).toBe("scopeUnit");
  });

  test("omits scopeUnit when the raw value is malformed", () => {
    writeModelHostStarting({ ...STARTING, scopeUnit: UNIT }, KEY, env);
    writeFileSync(
      modelhostStartingFile(env, KEY),
      JSON.stringify({ ...STARTING, scopeUnit: "evil" }),
    );
    const got = readModelHostStarting(KEY, env);
    expect(got).toEqual(STARTING);
    expect(Object.hasOwn(got!, "scopeUnit")).toBe(false);
  });
});

describe("scopeUnit on the state record", () => {
  test("round-trips a valid scopeUnit as the last key", () => {
    const record: ModelHostState = { ...STATE, scopeUnit: UNIT };
    writeModelHostState(record, KEY, env);
    const got = readModelHostState(KEY, env);
    expect(got).toEqual({ ...record, slotSavePath: null });
    expect(Object.keys(got!).at(-1)).toBe("scopeUnit");
  });

  test("omits scopeUnit when the raw value is malformed", () => {
    writeModelHostState({ ...STATE, scopeUnit: UNIT }, KEY, env);
    writeFileSync(modelhostStateFile(env, KEY), JSON.stringify({ ...STATE, scopeUnit: "../x" }));
    const got = readModelHostState(KEY, env);
    expect(got).toEqual({ ...STATE, slotSavePath: null });
    expect(Object.hasOwn(got!, "scopeUnit")).toBe(false);
  });
});

describe("scopeUnit on the ModelRun sidecar", () => {
  const SIDECAR = {
    rel: "survival/survival-model.gguf",
    extraArgs: ["-m", "model.gguf"],
    pid: 4000,
    startedAt: "2026-05-19T00:00:00Z",
    host: "127.0.0.1",
    port: "8095",
    binary: "/usr/bin/llama-server",
    slotSavePath: null,
  };

  function writeSidecar(scopeUnit?: string): void {
    const dir = workloadRuntimeDir(env, KEY);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "llama-server.state"),
      JSON.stringify(scopeUnit === undefined ? SIDECAR : { ...SIDECAR, scopeUnit }),
    );
  }

  test("a valid scopeUnit survives as the last key", () => {
    writeSidecar(UNIT);
    const got = readServerState(KEY, env);
    expect(got?.scopeUnit).toBe(UNIT);
    expect(Object.keys(got!).at(-1)).toBe("scopeUnit");
  });

  test("malformed scopeUnit values are dropped while the record survives", () => {
    for (const bad of ["../x", "a b", "llamactl-engine-x"]) {
      writeSidecar(bad);
      const got = readServerState(KEY, env);
      expect(got?.rel).toBe(SIDECAR.rel);
      expect(Object.hasOwn(got!, "scopeUnit")).toBe(false);
    }
  });

  test("an absent scopeUnit has no key", () => {
    writeSidecar();
    const got = readServerState(KEY, env);
    expect(got?.rel).toBe(SIDECAR.rel);
    expect(Object.hasOwn(got!, "scopeUnit")).toBe(false);
  });
});
