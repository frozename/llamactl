// Pins for #335: ModelHostStarting/StartAttempt record validation and
// computeModelHostSpecHash launch-field coverage.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ResolvedEnv } from "../../src/types.js";

import {
  computeModelHostSpecHash,
  modelhostStartAttemptFile,
  modelhostStartingFile,
  type ModelHostStartingState,
  type ModelHostState,
  modelhostStateFile,
  readModelHostStartAttempt,
  readModelHostStarting,
  readModelHostState,
  removeModelHostStartAttempt,
  removeModelHostStarting,
  removeModelHostState,
  writeModelHostStartAttempt,
  writeModelHostStarting,
  writeModelHostState,
} from "../../src/engines/state.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

const KEY = { name: "mlx-host-records" };

const STARTING: ModelHostStartingState = {
  kind: "ModelHostStarting",
  engine: "omlx",
  pid: 4242,
  startedAt: "2026-05-19T00:00:00Z",
};

type SpecForHash = Parameters<typeof computeModelHostSpecHash>[0];

const BASE_SPEC: SpecForHash = {
  engine: "omlx",
  binary: "/opt/omlx",
  endpoint: { host: "127.0.0.1", port: 8094 },
  hostedModels: [{ rel: "a" }],
  extraArgs: [],
  restartPolicy: "Always",
  timeoutSeconds: 60,
};

let tmp: string;
let env: ResolvedEnv;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-state-records-"));
  env = { LOCAL_AI_RUNTIME_DIR: tmp } as ResolvedEnv;
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; failures are not actionable here.
  }
});

describe("starting record", () => {
  test("readModelHostStarting roundtrips a kapitsa starting record", () => {
    const record: ModelHostStartingState = {
      kind: "ModelHostStarting",
      engine: "kapitsa",
      pid: 4242,
      startedAt: "2026-05-19T00:00:00Z",
      specHash: "h1",
    };
    writeModelHostStarting(record, KEY, env);
    expect(readModelHostStarting(KEY, env)).toEqual(record);
  });

  test.each(["llamacpp", "omlx", "strata"] as const)(
    "readModelHostStarting roundtrips a %s starting record",
    (engine) => {
      const record: ModelHostStartingState = {
        kind: "ModelHostStarting",
        engine,
        pid: 4242,
        startedAt: "2026-05-19T00:00:00Z",
        specHash: "h1",
      };
      writeModelHostStarting(record, KEY, env);
      expect(readModelHostStarting(KEY, env)).toEqual(record);
    },
  );

  test("a record written without specHash reads back with no specHash key", () => {
    writeModelHostStarting(STARTING, KEY, env);
    const got = readModelHostStarting(KEY, env);
    expect(got).toEqual(STARTING);
    expect(Object.hasOwn(got!, "specHash")).toBe(false);
  });

  test("a non-string specHash in the raw file is dropped and other fields are kept", () => {
    writeModelHostStarting(STARTING, KEY, env);
    writeFileSync(modelhostStartingFile(env, KEY), JSON.stringify({ ...STARTING, specHash: 7 }));
    const got = readModelHostStarting(KEY, env);
    expect(got).toEqual(STARTING);
    expect(Object.hasOwn(got!, "specHash")).toBe(false);
  });

  test("returns null for a record with the wrong kind", () => {
    writeModelHostStarting(STARTING, KEY, env);
    writeFileSync(
      modelhostStartingFile(env, KEY),
      JSON.stringify({ ...STARTING, kind: "ModelHost" }),
    );
    expect(readModelHostStarting(KEY, env)).toBeNull();
  });

  test("returns null for pid 0", () => {
    writeModelHostStarting({ ...STARTING, pid: 0 }, KEY, env);
    expect(readModelHostStarting(KEY, env)).toBeNull();
  });

  test("returns null for a non-integer pid", () => {
    writeModelHostStarting({ ...STARTING, pid: 1.5 }, KEY, env);
    expect(readModelHostStarting(KEY, env)).toBeNull();
  });

  test("returns null for an unknown engine", () => {
    writeModelHostStarting(
      { ...STARTING, engine: "not-an-engine" as ModelHostStartingState["engine"] },
      KEY,
      env,
    );
    expect(readModelHostStarting(KEY, env)).toBeNull();
  });

  test("returns null for an unparseable startedAt", () => {
    writeModelHostStarting({ ...STARTING, startedAt: "not-a-date" }, KEY, env);
    expect(readModelHostStarting(KEY, env)).toBeNull();
  });

  test("returns null on a corrupt starting file", () => {
    writeModelHostStarting(STARTING, KEY, env);
    writeFileSync(modelhostStartingFile(env, KEY), "not json");
    expect(readModelHostStarting(KEY, env)).toBeNull();
  });

  test("returns null when no starting file exists", () => {
    expect(readModelHostStarting(KEY, env)).toBeNull();
  });

  test("removeModelHostStarting deletes the record and is safe to repeat", () => {
    writeModelHostStarting(STARTING, KEY, env);
    removeModelHostStarting(KEY, env);
    expect(readModelHostStarting(KEY, env)).toBeNull();
    expect(existsSync(modelhostStartingFile(env, KEY))).toBe(false);
    expect(() => {
      removeModelHostStarting(KEY, env);
    }).not.toThrow();
  });

  test("removeModelHostState does not delete the starting record", () => {
    writeModelHostStarting(STARTING, KEY, env);
    removeModelHostState(KEY, env);
    expect(readModelHostStarting(KEY, env)).toEqual(STARTING);
  });

  test("the starting record lives in a different file from the state sidecar", () => {
    const startingPath = modelhostStartingFile(env, KEY);
    const statePath = modelhostStateFile(env, KEY);
    expect(startingPath).not.toBe(statePath);
    expect(dirname(startingPath)).toBe(dirname(statePath));
  });
});

describe("start attempt", () => {
  test("roundtrips a spec hash", () => {
    writeModelHostStartAttempt(KEY, "hash-a", env);
    expect(readModelHostStartAttempt(KEY, env)).toBe("hash-a");
  });

  test("returns null when the raw specHash is a number", () => {
    writeModelHostStartAttempt(KEY, "hash-a", env);
    writeFileSync(modelhostStartAttemptFile(env, KEY), JSON.stringify({ specHash: 7 }));
    expect(readModelHostStartAttempt(KEY, env)).toBeNull();
  });

  test("returns null on a corrupt attempt file", () => {
    writeModelHostStartAttempt(KEY, "hash-a", env);
    writeFileSync(modelhostStartAttemptFile(env, KEY), "not json");
    expect(readModelHostStartAttempt(KEY, env)).toBeNull();
  });

  test("returns null when no attempt file exists", () => {
    expect(readModelHostStartAttempt(KEY, env)).toBeNull();
  });

  test("removeModelHostStartAttempt clears the record and is safe to repeat", () => {
    writeModelHostStartAttempt(KEY, "hash-a", env);
    removeModelHostStartAttempt(KEY, env);
    expect(readModelHostStartAttempt(KEY, env)).toBeNull();
    expect(() => {
      removeModelHostStartAttempt(KEY, env);
    }).not.toThrow();
  });
});

// #516: binaryNames lets a llama-server-compatible fork (e.g. the Gufo
// `llama-server-fork-pristine` shim) pass pid-identity checks. The field is
// seeded as raw JSON — the writers' types do not carry it yet.
describe("record binaryNames (#516)", () => {
  const LLAMA_STATE: ModelHostState = {
    kind: "ModelHost",
    engine: "llamacpp",
    pid: 4321,
    host: "127.0.0.1",
    port: 8095,
    modelAliases: ["gufo/model.gguf", "model.gguf"],
    startedAt: "2026-05-19T00:00:00Z",
  };
  const LLAMA_STARTING: ModelHostStartingState = {
    kind: "ModelHostStarting",
    engine: "llamacpp",
    pid: 4242,
    startedAt: "2026-05-19T00:00:00Z",
  };
  const FORK_NAMES = ["llama-server-fork-pristine"];

  test("readModelHostStarting keeps binaryNames on a llamacpp record", () => {
    writeModelHostStarting(LLAMA_STARTING, KEY, env);
    writeFileSync(
      modelhostStartingFile(env, KEY),
      JSON.stringify({ ...LLAMA_STARTING, binaryNames: FORK_NAMES }),
    );
    expect(readModelHostStarting(KEY, env)).toEqual({
      ...LLAMA_STARTING,
      binaryNames: FORK_NAMES,
    });
  });

  test("readModelHostState keeps binaryNames on a llamacpp record", () => {
    writeModelHostState(LLAMA_STATE, KEY, env);
    writeFileSync(
      modelhostStateFile(env, KEY),
      JSON.stringify({ ...LLAMA_STATE, binaryNames: FORK_NAMES }),
    );
    expect(readModelHostState(KEY, env)).toEqual({
      ...LLAMA_STATE,
      binaryNames: FORK_NAMES,
      slotSavePath: null,
    });
  });

  test.each([
    ["a string", "llama-server"],
    ["an empty list", []],
    ["a non-string entry", [1]],
    ["an empty entry", [""]],
    ["a path entry", ["a/b"]],
    ["a whitespace entry", ["a b"]],
  ] as const)(
    "drops invalid binaryNames (%s) and keeps the rest of the record",
    (_label, binaryNames) => {
      writeModelHostState(LLAMA_STATE, KEY, env);
      writeFileSync(modelhostStateFile(env, KEY), JSON.stringify({ ...LLAMA_STATE, binaryNames }));
      writeModelHostStarting(LLAMA_STARTING, KEY, env);
      writeFileSync(
        modelhostStartingFile(env, KEY),
        JSON.stringify({ ...LLAMA_STARTING, binaryNames }),
      );

      const state = readModelHostState(KEY, env);
      expect(state).toEqual({ ...LLAMA_STATE, slotSavePath: null });
      expect(Object.hasOwn(state!, "binaryNames")).toBe(false);
      expect(readModelHostStarting(KEY, env)).toEqual(LLAMA_STARTING);
      expect(Object.hasOwn(readModelHostStarting(KEY, env)!, "binaryNames")).toBe(false);
    },
  );
});

describe("computeModelHostSpecHash", () => {
  test("is deterministic", () => {
    expect(computeModelHostSpecHash(BASE_SPEC)).toBe(computeModelHostSpecHash(BASE_SPEC));
  });

  test("an explicit undefined resources hashes the same as absent", () => {
    expect(computeModelHostSpecHash({ ...BASE_SPEC, resources: undefined })).toBe(
      computeModelHostSpecHash(BASE_SPEC),
    );
  });

  test("an explicit undefined env hashes the same as absent", () => {
    expect(computeModelHostSpecHash({ ...BASE_SPEC, env: undefined })).toBe(
      computeModelHostSpecHash(BASE_SPEC),
    );
  });

  test.each([
    ["engine", { ...BASE_SPEC, engine: "strata" }],
    ["binary", { ...BASE_SPEC, binary: "/opt/other" }],
    ["endpoint.port", { ...BASE_SPEC, endpoint: { ...BASE_SPEC.endpoint, port: 8095 } }],
    ["hostedModels", { ...BASE_SPEC, hostedModels: [{ rel: "b" }] }],
    ["extraArgs", { ...BASE_SPEC, extraArgs: ["--flag"] }],
    ["resources", { ...BASE_SPEC, resources: { expectedMemoryGiB: 8 } }],
    ["restartPolicy", { ...BASE_SPEC, restartPolicy: "Never" }],
    ["timeoutSeconds", { ...BASE_SPEC, timeoutSeconds: 61 }],
    ["env", { ...BASE_SPEC, env: { A: "1" } }],
  ] as [string, SpecForHash][])("changing %s changes the hash", (_field, spec) => {
    expect(computeModelHostSpecHash(spec)).not.toBe(computeModelHostSpecHash(BASE_SPEC));
  });

  test("a key outside the hashed set does not change the hash", () => {
    const withExtra = { ...BASE_SPEC, extra: "x" } as unknown as SpecForHash;
    expect(computeModelHostSpecHash(withExtra)).toBe(computeModelHostSpecHash(BASE_SPEC));
  });

  test("binaryNames is outside the hashed set (#516)", () => {
    expect(computeModelHostSpecHash(BASE_SPEC)).toBe(
      '{"engine":"omlx","binary":"/opt/omlx","endpoint":{"host":"127.0.0.1","port":8094},"hostedModels":[{"rel":"a"}],"extraArgs":[],"resources":null,"restartPolicy":"Always","timeoutSeconds":60,"env":null}',
    );
    const withBinaryNames = { ...BASE_SPEC, binaryNames: ["x"] };
    expect(computeModelHostSpecHash(withBinaryNames)).toBe(computeModelHostSpecHash(BASE_SPEC));
  });
});
