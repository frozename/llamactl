import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { basename, join, resolve } from "node:path";

import { resolveEnv } from "../src/env.js";
import { mkdirSync, writeFileSync } from "../src/safe-fs.js";
import { readServerPid, readServerState, startServer } from "../src/server.js";
import { ensureWorkloadRuntimeDir } from "../src/workloadRuntime.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

const TEST_KEY = { name: "draft-wl" };

// llama-server-compatible forks take a draft model path on these flags;
// llamactl resolves relative values against LLAMA_CPP_MODELS (#516).
const DRAFT_PATH_FLAGS = ["-md", "--model-draft", "--spec-draft-model", "--dspark"];
const DRAFT_REL = "drafters/d.gguf";

function mockSpawnedProcess(pid: number): childProcess.ChildProcessWithoutNullStreams {
  return {
    pid,
    unref: () => undefined,
  } as unknown as childProcess.ChildProcessWithoutNullStreams;
}

function mockSpawnImplementation(pid: number): typeof childProcess.spawn {
  return (() => mockSpawnedProcess(pid)) as unknown as typeof childProcess.spawn;
}

function mockReadinessFetch(): ReturnType<typeof spyOn<typeof globalThis, "fetch">> {
  let fetchCalls = 0;
  return spyOn(globalThis, "fetch").mockImplementation((() => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return Promise.reject(new Error("connection refused"));
    }
    return Promise.resolve(new Response("ok", { status: 200 }));
  }) as unknown as typeof fetch);
}

interface DraftStartCapture {
  result: Awaited<ReturnType<typeof startServer>>;
  argv: readonly string[];
  spawnCalls: number;
}

async function startDraftWorkload(extraArgs: string[]): Promise<DraftStartCapture> {
  const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(
    mockSpawnImplementation(process.pid),
  );
  const fetchSpy = mockReadinessFetch();
  try {
    const result = await startServer({ key: TEST_KEY, target: "Demo/demo.gguf", extraArgs });
    // mockRestore() clears the recorded calls, so read argv + counts before the finally runs.
    const argv = spawnSpy.mock.calls[0]?.[1] ?? [];
    return { result, argv, spawnCalls: spawnSpy.mock.calls.length };
  } finally {
    spawnSpy.mockRestore();
    fetchSpy.mockRestore();
  }
}

describe("server.startServer draft-path resolution (#516)", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
    process.env["LLAMA_CPP_PORT"] = "8091";
    const binDir = join(temp.devStorage, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "llama-server"), "#!/bin/sh\nexit 0\n");
    process.env["LLAMA_CPP_BIN"] = binDir;
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "");
    const draftDir = join(temp.modelsDir, "drafters");
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(join(draftDir, "d.gguf"), "");
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test.each(DRAFT_PATH_FLAGS.map((flag) => [flag, DRAFT_REL]))(
    "startServer resolves the %s %s draft path against the models dir",
    async (flag: string, rel: string) => {
      const { result, argv } = await startDraftWorkload([flag, rel]);
      expect(result.ok).toBe(true);
      const flagIndex = argv.indexOf(flag);
      expect(flagIndex).toBeGreaterThanOrEqual(0);
      expect(argv[flagIndex + 1]).toBe(resolve(temp.modelsDir, rel));
    },
  );

  test.each(DRAFT_PATH_FLAGS.map((flag) => [flag, DRAFT_REL]))(
    "startServer resolves the inline %s=%s draft path against the models dir",
    async (flag: string, rel: string) => {
      const { result, argv } = await startDraftWorkload([`${flag}=${rel}`]);
      expect(result.ok).toBe(true);
      expect(argv).toContain(`${flag}=${resolve(temp.modelsDir, rel)}`);
      expect(argv).not.toContain(`${flag}=${rel}`);
    },
  );

  test("startServer refuses a relative draft path that escapes the models dir before spawning", async () => {
    const { result, spawnCalls } = await startDraftWorkload([
      "--model-draft",
      "../../outside.gguf",
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(
      /--model-draft path escapes models dir: \.\.\/\.\.\/outside\.gguf/,
    );
    expect(spawnCalls).toBe(0);
    expect(readServerPid(TEST_KEY, resolveEnv())).toBeNull();
  });

  test("startServer refuses an inline escaping draft path before spawning", async () => {
    const { result, spawnCalls } = await startDraftWorkload(["-md=../x.gguf"]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/-md path escapes models dir: \.\.\/x\.gguf/);
    expect(spawnCalls).toBe(0);
  });

  test.each([
    ["--model-draft", "../../outside.gguf"],
    ["-md=../x.gguf", null],
  ])(
    "startServer refuses an escaping draft path (%s) before stopping the tracked server or probing the port",
    async (first: string, second: string | null) => {
      const dir = ensureWorkloadRuntimeDir(resolveEnv(), TEST_KEY);
      writeFileSync(join(dir, "llama-server.pid"), "4194305\n");

      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() =>
        Promise.resolve(new Response("occupied", { status: 200 }))) as unknown as typeof fetch);
      const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(
        mockSpawnImplementation(12345),
      );

      const extraArgs = second === null ? [first] : [first, second];
      let result: Awaited<ReturnType<typeof startServer>>;
      let fetchCalls = -1;
      let spawnCalls = -1;
      try {
        result = await startServer({ key: TEST_KEY, target: "Demo/demo.gguf", extraArgs });
      } finally {
        // mockRestore() clears the recorded calls, so capture counts before restoring.
        fetchCalls = fetchSpy.mock.calls.length;
        spawnCalls = spawnSpy.mock.calls.length;
        spawnSpy.mockRestore();
        fetchSpy.mockRestore();
      }
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/path escapes models dir/);
      expect(fetchCalls).toBe(0);
      expect(spawnCalls).toBe(0);
      expect(readServerPid(TEST_KEY, resolveEnv())).toBe(4194305);
    },
  );

  test("startServer refuses a sibling-prefix draft path that escapes the models dir", async () => {
    const sibling = `../${basename(temp.modelsDir)}-evil/x.gguf`;
    const { result, spawnCalls } = await startDraftWorkload(["--model-draft", sibling]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`--model-draft path escapes models dir: ${sibling}`);
    expect(spawnCalls).toBe(0);
  });

  test("guard: startServer passes an absolute draft path through unchanged", async () => {
    const absDraft = resolve(temp.devStorage, "abs-draft.gguf");
    const { result, argv } = await startDraftWorkload(["--model-draft", absDraft]);
    expect(result.ok).toBe(true);
    const flagIndex = argv.indexOf("--model-draft");
    expect(argv[flagIndex + 1]).toBe(absDraft);
  });

  test("guard: startServer passes an unknown flag pair through verbatim", async () => {
    const { result, argv } = await startDraftWorkload(["--foo", DRAFT_REL]);
    expect(result.ok).toBe(true);
    const flagIndex = argv.indexOf("--foo");
    expect(argv[flagIndex + 1]).toBe(DRAFT_REL);
    expect(argv).not.toContain(resolve(temp.modelsDir, DRAFT_REL));
  });

  test("guard: the sidecar keeps raw extraArgs after draft-path resolution", async () => {
    const { result } = await startDraftWorkload(["--model-draft", DRAFT_REL]);
    expect(result.ok).toBe(true);
    expect(readServerState(TEST_KEY, resolveEnv())?.extraArgs).toEqual([
      "--model-draft",
      DRAFT_REL,
    ]);
  });

  test("guard: the -m argv value stays the models-dir model path and appears once", async () => {
    const { result, argv } = await startDraftWorkload(["--model-draft", DRAFT_REL]);
    expect(result.ok).toBe(true);
    const modelPath = join(temp.modelsDir, "Demo/demo.gguf");
    const mIndex = argv.indexOf("-m");
    expect(argv[mIndex + 1]).toBe(modelPath);
    expect(argv.filter((arg) => arg === modelPath)).toHaveLength(1);
  });
});
