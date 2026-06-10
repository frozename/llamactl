import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedEnv } from "../../src/types.js";

import {
  type ModelHostState,
  modelhostStateFile,
  readModelHostState,
  removeModelHostState,
  writeModelHostState,
} from "../../src/engines/state.js";

const KEY = { name: "mlx-host-test" };

let tmp: string;
let env: ResolvedEnv;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-state-"));
  env = { LOCAL_AI_RUNTIME_DIR: tmp } as ResolvedEnv;
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; failures are not actionable here.
  }
});

describe("engines/state", () => {
  test("roundtrips a ModelHostState through write + read", () => {
    const state: ModelHostState = {
      kind: "ModelHost",
      engine: "omlx",
      pid: 4242,
      host: "127.0.0.1",
      port: 8094,
      modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit", "Qwen3-8B-MLX-4bit"],
      startedAt: "2026-05-19T00:00:00Z",
    };
    writeModelHostState(state, KEY, env);
    // readModelHostState normalizes a missing slotSavePath to null (legacy sidecars).
    expect(readModelHostState(KEY, env)).toEqual({ ...state, slotSavePath: null });
  });

  test("returns null when no state file exists", () => {
    expect(readModelHostState(KEY, env)).toBeNull();
  });

  test("returns null on a corrupt state file", () => {
    const state: ModelHostState = {
      kind: "ModelHost",
      engine: "omlx",
      pid: 1,
      host: "127.0.0.1",
      port: 1,
      modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit"],
      startedAt: "2026-05-19T00:00:00Z",
    };
    writeModelHostState(state, KEY, env);
    writeFileSync(modelhostStateFile(env, KEY), "not json");
    expect(readModelHostState(KEY, env)).toBeNull();
  });

  test("rejects invalid model host aliases, engine, host, port, pid, and startedAt", () => {
    const base: ModelHostState = {
      kind: "ModelHost",
      engine: "omlx",
      pid: 1,
      host: "127.0.0.1",
      port: 8094,
      modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit"],
      startedAt: "2026-05-19T00:00:00Z",
    };

    writeModelHostState({ ...base, modelAliases: [] }, KEY, env);
    expect(readModelHostState(KEY, env)).toBeNull();

    writeModelHostState({ ...base, modelAliases: ["bad\talias"] }, KEY, env);
    expect(readModelHostState(KEY, env)).toBeNull();

    writeModelHostState({ ...base, engine: "not-an-engine" as ModelHostState["engine"] }, KEY, env);
    expect(readModelHostState(KEY, env)).toBeNull();

    writeModelHostState({ ...base, startedAt: "not-a-date" }, KEY, env);
    expect(readModelHostState(KEY, env)).toBeNull();

    writeModelHostState({ ...base, pid: 0 }, KEY, env);
    expect(readModelHostState(KEY, env)).toBeNull();

    writeModelHostState({ ...base, host: "10.0.0.5" }, KEY, env);
    expect(readModelHostState(KEY, env)).toBeNull();

    writeModelHostState({ ...base, port: 70000 }, KEY, env);
    expect(readModelHostState(KEY, env)).toBeNull();
  });

  test("removeModelHostState clears both pid + state files", () => {
    const state: ModelHostState = {
      kind: "ModelHost",
      engine: "omlx",
      pid: 1,
      host: "127.0.0.1",
      port: 1,
      modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit"],
      startedAt: "2026-05-19T00:00:00Z",
    };
    writeModelHostState(state, KEY, env);
    expect(readModelHostState(KEY, env)).not.toBeNull();
    removeModelHostState(KEY, env);
    expect(readModelHostState(KEY, env)).toBeNull();
  });
});
