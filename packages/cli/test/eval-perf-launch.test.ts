// RED pins for #521: `llamactl eval perf --launch` boots llama-server
// through the eval matrix lifecycle inside the perf suite's load hooks,
// measures cold/warm load on the injected fake clock, and tears the owned
// boot down in `finally`. The launch seam, engine fetch and provenance
// readers are faked; at base `--launch` is an unknown flag, so every case
// fails on its assertion rather than on a missing import.

import type { GttObservation } from "@llamactl/core/resources/memory";
import type { BootResult, EngineVersionInfo, MetricValue, ModelSpec } from "@llamactl/eval";
import type { ChildProcess } from "node:child_process";

import { listPerfRuns } from "@llamactl/eval";
import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../remote/src/residency/apply-profile.js";
import { openResidencyOperationStore } from "../../remote/src/residency/store.js";
import { LAUNCH_IO_REASON } from "../src/commands/eval-perf-launch.js";
import * as evalCmd from "../src/commands/eval.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { captureProcessStreams, isPlainRecord } from "./helpers.js";

const { runEval } = evalCmd;

const LOOPBACK_URL = "http://127.0.0.1:18080";
const GLM_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";
const GROUP = "z13-large-gpu";
const NOW = 1_000_000_000;
const ENV_KEYS = ["LLAMA_CPP_MODELS", "LLAMACTL_RESIDENCY_STORE"] as const;

const GTT_OK: GttObservation = {
  status: "ok",
  totalBytes: 1000,
  usedBytes: 123,
  observedAtMs: 1,
  source: "/sys/class/drm/card1/device",
  scope: "shared",
};

interface EvalPerfProvenanceReaders {
  sha256File(path: string): string | Promise<string>;
  engineVersion(binaryPath: string): EngineVersionInfo | Promise<EngineVersionInfo>;
  hostname(): string;
}

type ProcPidRusage = (pid: number, flavor: number, buffer: Uint8Array) => number | Promise<number>;

const unexpectedRusageCalls: { pid: number; flavor: number }[] = [];

function unexpectedRusage(pid: number, flavor: number, _buffer: Uint8Array): number {
  unexpectedRusageCalls.push({ pid, flavor });
  throw new Error("unexpected proc_pid_rusage call");
}

interface LaunchSeam {
  ensure(spec: ModelSpec): Promise<BootResult>;
  teardown(boot: BootResult): Promise<void>;
}

interface EvalPerfTestSeams {
  runPerfSuite?: (db: Database, opts: unknown) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  provenanceReaders?: EvalPerfProvenanceReaders;
  platform?: NodeJS.Platform;
  readFile?: (path: string) => Promise<string>;
  procPidRusage?: ProcPidRusage;
  probeGtt?: () => Promise<GttObservation>;
  clock?: { now(): number };
  launch?: LaunchSeam;
}

interface ManualClock {
  now(): number;
  advance(ms: number): void;
}

type LaunchLogEntry = readonly ["ensure", ModelSpec] | readonly ["teardown"];

interface LaunchHarness {
  calls: LaunchLogEntry[];
  ensureSpecs: ModelSpec[];
  fetchedUrls: string[];
  readFilePaths: string[];
}

interface HarnessOptions {
  initiallyUp?: boolean;
  owned?: boolean;
  ensureError?: Error;
  teardownMs?: number;
  healthStatus?: number;
  modelsStatus?: number;
  pids?: (number | null)[];
  platform?: NodeJS.Platform;
  procPidRusage?: ProcPidRusage;
  runPerfSuite?: (db: Database, opts: unknown) => Promise<unknown>;
}

interface RunCall {
  db: Database;
  opts: unknown;
}

interface PerfArgvOptions {
  dbPath: string;
  launch?: boolean;
  url?: string;
  model?: string;
  engine?: string;
  binary?: string | null;
  gguf?: string | null;
  runId?: string | null;
  extra?: readonly string[];
}

let tmpDir = "";
let binPath = "";
let ggufPath = "";
let storePath = "";
let savedEnv: Record<string, string | undefined> = {};

function perfSeams(): (seams: EvalPerfTestSeams) => void {
  const setSeams = Reflect.get(evalCmd, "__setEvalPerfTestSeams") as unknown;
  expect(typeof setSeams).toBe("function");
  return setSeams as (seams: EvalPerfTestSeams) => void;
}

function fakeRunPerfSuite(): {
  runPerfSuite: (db: Database, opts: unknown) => Promise<unknown>;
  calls: RunCall[];
} {
  const calls: RunCall[] = [];
  const runPerfSuite = (db: Database, opts: unknown): Promise<unknown> => {
    calls.push({ db, opts });
    return Promise.resolve([]);
  };
  return { runPerfSuite, calls };
}

function runOpts(call: RunCall | undefined): Record<string, unknown> {
  if (call === undefined) throw new Error("expected a recorded runPerfSuite call");
  if (!isPlainRecord(call.opts)) throw new Error("expected runPerfSuite opts to be a record");
  return call.opts;
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value: unknown = record[key];
  if (!isPlainRecord(value)) throw new Error(`expected opts.${key} to be a record`);
  return value;
}

function inputUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function jsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(init.body);
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function wordCount(value: unknown): number {
  if (typeof value !== "string") return 0;
  return value.split(/\s+/).filter((word) => word.length > 0).length;
}

function tokenizeResponse(content: string): Response {
  const words = content.split(/\s+/).filter((word) => word.length > 0);
  return Response.json({
    tokens: words.map((word, index) => ({
      id: index,
      piece: index === 0 ? word : ` ${word}`,
    })),
  });
}

function sseResponse(payload: Record<string, unknown>): Response {
  const text = `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`;
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function completionResponse(body: Record<string, unknown>, chat: boolean): Response {
  const promptTokens = Math.max(1, wordCount(body["prompt"]));
  const choice: Record<string, unknown> = chat ? { delta: { content: "ok" } } : { text: "ok" };
  return sseResponse({
    choices: [choice],
    usage: { prompt_tokens: promptTokens, completion_tokens: 1 },
    timings: {
      prompt_n: promptTokens,
      prompt_per_second: 900,
      predicted_n: 1,
      predicted_per_second: 50,
    },
  });
}

function installHarness(options: HarnessOptions = {}): LaunchHarness {
  let up = options.initiallyUp ?? false;
  let now = 0;
  let ensureCount = 0;
  const calls: LaunchLogEntry[] = [];
  const ensureSpecs: ModelSpec[] = [];
  const fetchedUrls: string[] = [];
  const readFilePaths: string[] = [];
  const clock: ManualClock = {
    now: () => now,
    advance: (ms: number): void => {
      now += ms;
    },
  };

  const ensure = (spec: ModelSpec): Promise<BootResult> => {
    calls.push(["ensure", spec]);
    ensureSpecs.push(spec);
    if (options.ensureError !== undefined) return Promise.reject(options.ensureError);
    up = true;
    ensureCount += 1;
    clock.advance(ensureCount === 1 ? 1500 : 400);
    const pid = options.pids?.[ensureCount - 1];
    const proc =
      options.pids === undefined || pid === null || pid === undefined
        ? null
        : ({ pid } as ChildProcess);
    return Promise.resolve({ owned: options.owned ?? true, proc });
  };
  const teardown = (): Promise<void> => {
    calls.push(["teardown"]);
    up = false;
    clock.advance(options.teardownMs ?? 0);
    return Promise.resolve();
  };

  const healthStatus = options.healthStatus ?? 200;
  const modelsStatus = options.modelsStatus ?? 200;
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = inputUrl(input);
    fetchedUrls.push(url);
    if (!up) return Promise.reject(new TypeError("connection refused"));
    if (url.endsWith("/health")) {
      return Promise.resolve(Response.json({ status: "ok" }, { status: healthStatus }));
    }
    if (url.endsWith("/v1/models")) {
      if (modelsStatus !== 200) {
        return Promise.resolve(new Response("not found", { status: modelsStatus }));
      }
      return Promise.resolve(Response.json({ object: "list", data: [{ id: "m" }] }));
    }
    if (url.endsWith("/props")) {
      return Promise.resolve(Response.json({ total_slots: 4 }));
    }
    if (url.endsWith("/tokenize")) {
      const body = jsonBody(init);
      return Promise.resolve(
        tokenizeResponse(typeof body["content"] === "string" ? body["content"] : ""),
      );
    }
    if (url.endsWith("/v1/completions")) {
      return Promise.resolve(completionResponse(jsonBody(init), false));
    }
    if (url.endsWith("/v1/chat/completions")) {
      return Promise.resolve(completionResponse(jsonBody(init), true));
    }
    return Promise.resolve(new Response("engine unavailable", { status: 503 }));
  }) as typeof fetch;

  const readFile = (path: string): Promise<string> => {
    readFilePaths.push(path);
    if (/^\/proc\/\d+\/status$/.test(path)) return Promise.resolve("VmHWM:\t    3072 kB");
    return Promise.reject(new Error(`unexpected proc read: ${path}`));
  };

  const seams: EvalPerfTestSeams = {
    platform: options.platform ?? "darwin",
    fetchImpl,
    readFile,
    procPidRusage: options.procPidRusage ?? unexpectedRusage,
    probeGtt: () => Promise.resolve(GTT_OK),
    provenanceReaders: {
      sha256File: () => "ab".repeat(32),
      engineVersion: () => ({ version: "b9000", commit: "abc1234" }),
      hostname: () => "h1",
    },
    clock,
    launch: { ensure, teardown },
    ...(options.runPerfSuite === undefined ? {} : { runPerfSuite: options.runPerfSuite }),
  };
  perfSeams()(seams);
  return { calls, ensureSpecs, fetchedUrls, readFilePaths };
}

function perfArgv(opts: PerfArgvOptions): string[] {
  const args = ["perf", "--db", opts.dbPath, "--suite", "perf-quick"];
  const runId = opts.runId === undefined ? "r1" : opts.runId;
  if (runId !== null) args.push("--run-id", runId);
  args.push(
    "--url",
    opts.url ?? LOOPBACK_URL,
    "--engine",
    opts.engine ?? "llamacpp",
    "--model",
    opts.model ?? "m",
  );
  const binary = opts.binary === undefined ? binPath : opts.binary;
  if (binary !== null) args.push("--binary", binary);
  const gguf = opts.gguf === undefined ? ggufPath : opts.gguf;
  if (gguf !== null) args.push("--gguf", gguf);
  if (opts.launch ?? false) args.push("--launch");
  args.push(...(opts.extra ?? []));
  return args;
}

function dbPath(): string {
  return join(tmpDir, "perf.sqlite");
}

function metricsByName(path: string, runId: string): Map<string, MetricValue> {
  const db = new Database(path, { readonly: true });
  try {
    return new Map(listPerfRuns(db, { run_id: runId }).map((row) => [row.metric_name, row.metric]));
  } finally {
    db.close();
  }
}

function callKinds(calls: readonly LaunchLogEntry[]): string[] {
  return calls.map((entry) => entry[0]);
}

function ensureCallCount(calls: readonly LaunchLogEntry[]): number {
  return calls.filter((entry) => entry[0] === "ensure").length;
}

function seedReady(model: string): void {
  mkdirSync(dirname(storePath), { recursive: true });
  const store = openResidencyOperationStore({ path: storePath });
  try {
    const fence = store.claimOwnership({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "seed",
    });
    for (const to of ["downloaded", "loading", "warming", "ready"] as const) {
      const result = store.transitionResidencyState({
        fenceToken: fence.fenceToken,
        model,
        ...(to === "loading" ? { group: GROUP } : {}),
        to,
        expectedVersion: store.getResidencyState(model)?.version ?? 0,
        nowMs: NOW,
      });
      expect(result.ok).toBe(true);
    }
  } finally {
    store.close();
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "llamactl-eval-perf-launch-"));
  binPath = join(tmpDir, "llama-server");
  ggufPath = join(tmpDir, "m.gguf");
  storePath = join(tmpDir, "residency", "operations.sqlite");
  writeFileSync(binPath, "fake llama-server");
  writeFileSync(ggufPath, "fake gguf");
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env["LLAMA_CPP_MODELS"] = join(tmpDir, "models");
  process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
});

afterEach(() => {
  const resetSeams = Reflect.get(evalCmd, "__resetEvalPerfTestSeams") as unknown;
  if (typeof resetSeams === "function") (resetSeams as () => void)();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
});

afterAll(() => {
  expect(unexpectedRusageCalls).toEqual([]);
});

describe("#521 eval perf --launch", () => {
  test("(a) records cold/warm load timings (kills: hooks not passed, loadReason still used, or warm not relaunching)", async () => {
    installHarness();

    const { result } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true })),
    );

    expect(result).toBe(0);
    const byName = metricsByName(dbPath(), "r1");
    expect(byName.get("load_cold_ms")).toEqual({ status: "ok", value: 1500 });
    expect(byName.get("load_warm_ms")).toEqual({ status: "ok", value: 400 });
  });

  test("(a2) load_warm_ms excludes the cold boot's teardown (kills: tearing down inside the timed warm hook)", async () => {
    const harness = installHarness({ teardownMs: 250 });

    const { result } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true })),
    );

    expect(result).toBe(0);
    expect(callKinds(harness.calls)).toEqual(["ensure", "teardown", "ensure", "teardown"]);
    const byName = metricsByName(dbPath(), "r1");
    expect(byName.get("load_cold_ms")).toEqual({ status: "ok", value: 1500 });
    expect(byName.get("load_warm_ms")).toEqual({ status: "ok", value: 400 });
  });

  test("(b) lifecycle kinds are exact (kills: missing the warm teardown, or missing the final teardown)", async () => {
    const harness = installHarness();

    const { result } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true })),
    );

    expect(result).toBe(0);
    expect(callKinds(harness.calls)).toEqual(["ensure", "teardown", "ensure", "teardown"]);
  });

  test("(c) --flags and --quant map onto the first ensure ModelSpec (kills: wrong mapping)", async () => {
    const harness = installHarness();

    const { result } = await captureProcessStreams(() =>
      runEval(
        perfArgv({
          dbPath: dbPath(),
          launch: true,
          extra: ["--flags=-ngl 99", "--quant", "Q4_K_M"],
        }),
      ),
    );

    expect(result).toBe(0);
    expect(harness.ensureSpecs[0]).toEqual({
      name: "m",
      engine: "llamacpp",
      gguf_path: ggufPath,
      binary: binPath,
      host: "127.0.0.1",
      port: 18080,
      managed: true,
      request_model_id: "m",
      extra_args: ["-ngl", "99"],
      quant: "Q4_K_M",
      family: "",
      size_params: "",
    });
  });

  test("(d) a runPerfSuite throw still tears down (kills: teardown outside the finally block)", async () => {
    const runPerfSuite = async (_db: Database, opts: unknown): Promise<unknown> => {
      if (!isPlainRecord(opts)) throw new Error("expected runPerfSuite opts to be a record");
      const load = recordField(opts, "load");
      const cold: unknown = load["cold"];
      if (typeof cold !== "function") throw new Error("expected opts.load.cold to be a function");
      await (cold as () => Promise<void>)();
      throw new Error("boom");
    };
    const harness = installHarness({ runPerfSuite });

    let caught: unknown = null;
    try {
      await captureProcessStreams(() => runEval(perfArgv({ dbPath: dbPath(), launch: true })));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("boom");
    expect(callKinds(harness.calls).at(-1)).toBe("teardown");
    expect(ensureCallCount(harness.calls)).toBe(1);
  });

  test("(e) no --slots skips /props and forwards slotsReason (kills: probing /props before boot)", async () => {
    const run = fakeRunPerfSuite();
    const harness = installHarness({ runPerfSuite: run.runPerfSuite });

    const { result } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true })),
    );

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(harness.fetchedUrls.some((url) => url.endsWith("/props"))).toBe(false);
    expect(runOpts(run.calls[0])["slotsReason"]).toBe(
      "--launch starts the engine inside the perf suite, so GET /props is not probed before the run; pass --slots <n> to measure c2/c4",
    );
  });

  test("(e) explicit --slots reaches runPerfSuite (kills: probing /props before boot)", async () => {
    const run = fakeRunPerfSuite();
    installHarness({ runPerfSuite: run.runPerfSuite });

    const { result } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true, extra: ["--slots", "4"] })),
    );

    expect(result).toBe(0);
    const opts = runOpts(run.calls[0]);
    expect(opts["slots"]).toBe(4);
    expect(opts["slotsReason"]).toBeUndefined();
  });

  test("(f) --launch forwards hooks without loadReason (kills: loadReason still used)", async () => {
    const run = fakeRunPerfSuite();
    installHarness({ runPerfSuite: run.runPerfSuite });

    const { result } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true })),
    );

    expect(result).toBe(0);
    const opts = runOpts(run.calls[0]);
    const load = recordField(opts, "load");
    expect(typeof load["cold"]).toBe("function");
    expect(typeof load["warm"]).toBe("function");
    expect(opts["loadReason"]).toBeUndefined();
  });

  test("(f) guard: without --launch no load hooks are injected and loadReason is unchanged", async () => {
    const run = fakeRunPerfSuite();
    installHarness({ initiallyUp: true, runPerfSuite: run.runPerfSuite });

    const { result } = await captureProcessStreams(() => runEval(perfArgv({ dbPath: dbPath() })));

    expect(result).toBe(0);
    const opts = runOpts(run.calls[0]);
    expect(opts["load"]).toBeUndefined();
    expect(opts["loadReason"]).toBe(
      "eval perf runs against an engine already serving 'm' at http://127.0.0.1:18080; it does not launch or reload the engine, so cold/warm model-load time is not measured",
    );
  });

  test("(g) an occupied port refuses before ensure (kills: dropping the preflight)", async () => {
    const harness = installHarness({ initiallyUp: true });

    const { result, stderr } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true })),
    );

    expect(result).toBe(1);
    expect(stderr).toContain(
      "eval perf: --launch needs a free port, but something is already answering at http://127.0.0.1:18080 (GET /health returned HTTP 200)",
    );
    expect(harness.ensureSpecs).toHaveLength(0);
  });

  test("(g2) non-2xx /health is occupied (kills: treating a non-2xx as free)", async () => {
    const harness = installHarness({ initiallyUp: true, healthStatus: 503, modelsStatus: 404 });

    const { result, stderr } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true })),
    );

    expect(result).toBe(1);
    expect(stderr).toContain(
      "eval perf: --launch needs a free port, but something is already answering at http://127.0.0.1:18080 (GET /health returned HTTP 503)",
    );
    expect(harness.ensureSpecs).toHaveLength(0);
  });

  test("(h) a not-owned boot is unmeasured and exits 1 (kills: treating a not-owned boot as a measured load)", async () => {
    installHarness({ owned: false });

    const { result, stderr } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true, runId: "r1" })),
    );

    expect(result).toBe(1);
    expect(stderr).toContain(
      "eval perf: --launch did not start the engine at http://127.0.0.1:18080; run r1 measured an engine it did not launch",
    );
    const byName = metricsByName(dbPath(), "r1");
    expect(byName.get("load_cold_ms")).toEqual({
      status: "unavailable",
      value: null,
      reason:
        "load_cold_ms failed: an engine was already serving at 127.0.0.1:18080 before --launch started one; cold/warm load is measured only for an engine eval perf starts",
    });
  });

  test("(h2) a failed launch stores the run before exiting 1 (kills: a failed launch exiting 0)", async () => {
    installHarness({
      ensureError: new Error("model m managed=true but llama-server exited before /health"),
    });

    const { result, stdout, stderr } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true, runId: "r1" })),
    );

    expect(result).toBe(1);
    expect(stderr).toContain(
      "eval perf: --launch failed to start the engine at http://127.0.0.1:18080: model m managed=true but llama-server exited before /health",
    );
    expect(stdout).toContain("run_id: r1");
  });

  const refusalCases: readonly {
    name: string;
    args: () => string[];
    stderr: () => string;
  }[] = [
    {
      name: "--engine gufo",
      args: () => perfArgv({ dbPath: dbPath(), launch: true, engine: "gufo" }),
      stderr: () =>
        "eval perf: --launch starts llama-server through the eval matrix lifecycle and supports only --engine llamacpp (got gufo)\n",
    },
    {
      name: "non-loopback --url",
      args: () => perfArgv({ dbPath: dbPath(), launch: true, url: "http://10.0.0.5:8080" }),
      stderr: () =>
        "eval perf: --launch needs a loopback --url (got 10.0.0.5); the engine is started on this machine\n",
    },
    {
      name: "IPv6 loopback --url",
      args: () => perfArgv({ dbPath: dbPath(), launch: true, url: "http://[::1]:18080" }),
      stderr: () =>
        "eval perf: --launch does not support an IPv6 --url (got [::1]); use 127.0.0.1 or localhost\n",
    },
    {
      name: "--url without a port",
      args: () => perfArgv({ dbPath: dbPath(), launch: true, url: "http://127.0.0.1" }),
      stderr: () => "eval perf: --launch needs an explicit port in --url\n",
    },
    {
      name: "missing --gguf",
      args: () => perfArgv({ dbPath: dbPath(), launch: true, gguf: null }),
      stderr: () => "eval perf: --launch needs --binary <path> and --gguf <path>\n",
    },
    {
      name: "missing --binary file",
      args: () => perfArgv({ dbPath: dbPath(), launch: true, binary: join(tmpDir, "nope") }),
      stderr: () =>
        `eval perf: --launch needs an existing --binary (not found: ${join(tmpDir, "nope")})\n`,
    },
    {
      name: "missing --gguf file",
      args: () => perfArgv({ dbPath: dbPath(), launch: true, gguf: join(tmpDir, "nope.gguf") }),
      stderr: () =>
        `eval perf: --launch needs an existing --gguf (not found: ${join(tmpDir, "nope.gguf")})\n`,
    },
    {
      name: "--pid",
      args: () => perfArgv({ dbPath: dbPath(), launch: true, extra: ["--pid", "42"] }),
      stderr: () =>
        "eval perf: --pid cannot be combined with --launch; the launched engine's PID is not known before the suite starts\n",
    },
    {
      name: "--launch=1",
      args: () => perfArgv({ dbPath: dbPath(), extra: ["--launch=1"] }),
      stderr: () => "eval perf: --launch takes no value\n",
    },
  ];

  for (const refusal of refusalCases) {
    test(`(i) refuses ${refusal.name} (kills: deleting the ${refusal.name} validation)`, async () => {
      const harness = installHarness();

      const { result, stderr } = await captureProcessStreams(() => runEval(refusal.args()));

      expect(result).toBe(1);
      expect(stderr).toBe(refusal.stderr());
      expect(harness.ensureSpecs).toHaveLength(0);
    });
  }

  test("(j1) a gguf inside LLAMA_CPP_MODELS derives the group (kills: keying the gate on --model only)", async () => {
    seedReady("qwen-prod");
    const modelsDir = process.env["LLAMA_CPP_MODELS"];
    if (modelsDir === undefined) throw new Error("expected LLAMA_CPP_MODELS");
    const glmPath = join(modelsDir, GLM_REL);
    mkdirSync(dirname(glmPath), { recursive: true });
    writeFileSync(glmPath, "fake glm gguf");
    const harness = installHarness();

    const { result, stderr } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true, gguf: glmPath })),
    );

    expect(result).toBe(1);
    expect(stderr).toContain("eval perf: residency lifecycle refused");
    expect(stderr).toContain("ExclusiveGroupOccupied");
    expect(harness.ensureSpecs).toHaveLength(0);
  });

  test("(j2) --model is the catalog-rel fallback (kills: dropping the --model fallback)", async () => {
    seedReady("qwen-prod");
    const harness = installHarness();

    const { result, stderr } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true, model: GLM_REL })),
    );

    expect(result).toBe(1);
    expect(stderr).toContain("eval perf: residency lifecycle refused");
    expect(stderr).toContain("ExclusiveGroupOccupied");
    expect(harness.ensureSpecs).toHaveLength(0);
  });

  test("(j3) guard: an unrelated gguf is not refused by the seeded exclusive group", async () => {
    seedReady("qwen-prod");
    const harness = installHarness();

    const { result, stderr } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true })),
    );

    expect(stderr).not.toContain("residency lifecycle refused");
    expect(result).toBe(0);
    expect(harness.ensureSpecs.length).toBeGreaterThan(0);
  });

  test("(k) launch provenance flags are explicit empty (kills: recording a false not-known flags reason for an engine eval perf launched)", async () => {
    const run = fakeRunPerfSuite();
    installHarness({ runPerfSuite: run.runPerfSuite });

    const { result } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true })),
    );

    expect(result).toBe(0);
    const provenance = recordField(runOpts(run.calls[0]), "provenance");
    expect(provenance["flags"]).toEqual([]);
    expect(JSON.stringify(provenance)).not.toContain("launch flags of the engine");
  });

  test("(k) guard: without --launch the absent --flags reason is unchanged", async () => {
    const run = fakeRunPerfSuite();
    installHarness({ initiallyUp: true, runPerfSuite: run.runPerfSuite });

    const { result } = await captureProcessStreams(() => runEval(perfArgv({ dbPath: dbPath() })));

    expect(result).toBe(0);
    const provenance = recordField(runOpts(run.calls[0]), "provenance");
    expect(provenance["flags"]).toBeNull();
    const unavailable = recordField(provenance, "unavailable");
    expect(unavailable["flags"]).toBe(
      "no --flags given; the launch flags of the engine at http://127.0.0.1:18080 are not known",
    );
  });
});

const LAUNCH_PEAK_RSS_NULL_REASON =
  "peak-RSS (VmHWM) reader failed: engine PID not known when the reader ran";

function expectUnavailable(metric: MetricValue | undefined, reason: string): void {
  expect(metric).toEqual({ status: "unavailable", value: null, reason });
}

describe("#521 eval perf --launch peak RSS", () => {
  test("(B1) linux records VmHWM from the warm relaunch pid", async () => {
    // Kills: passing null as the launch pid (the base behaviour, which
    //        gives the 'engine PID unknown' reason), or caching the cold
    //        boot's pid.
    const harness = installHarness({ platform: "linux", pids: [1111, 2222] });

    const { result, stdout } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true })),
    );

    expect(result).toBe(0);
    expect(stdout).toContain("run_id: r1");
    const byName = metricsByName(dbPath(), "r1");
    expect(byName.get("peak_rss_bytes")).toEqual({ status: "ok", value: 3145728 });
    expect(harness.readFilePaths).toContain("/proc/2222/status");
    expect(harness.readFilePaths).not.toContain("/proc/1111/status");
  });

  test("(B2) linux names why no per-process SSD I/O spans the relaunch", async () => {
    // Kills: keeping the lazy io reader, which would produce a bogus delta
    //        or 'I/O reader returned no sample'.
    const harness = installHarness({ platform: "linux", pids: [1111, 2222] });

    const { result, stdout } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true })),
    );

    expect(result).toBe(0);
    expect(stdout).toContain("run_id: r1");
    const byName = metricsByName(dbPath(), "r1");
    expectUnavailable(byName.get("ssd_read_bytes"), LAUNCH_IO_REASON);
    expectUnavailable(byName.get("ssd_write_bytes"), LAUNCH_IO_REASON);
    expect(harness.readFilePaths.some((path) => /^\/proc\/\d+\/io$/.test(path))).toBe(false);
  });

  test("(B3) linux surfaces a missing warm-boot pid as a reader failure", async () => {
    // Kills: returning null for a missing pid.
    installHarness({ platform: "linux", pids: [1111, null] });

    const { result, stdout } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true })),
    );

    expect(result).toBe(0);
    expect(stdout).toContain("run_id: r1");
    const byName = metricsByName(dbPath(), "r1");
    expectUnavailable(byName.get("peak_rss_bytes"), LAUNCH_PEAK_RSS_NULL_REASON);
  });

  test("(B4) launch reads darwin peak RSS from the relaunched engine and drops io", async () => {
    // Kills: the launch pid getter not reaching the darwin peakRss reader, or
    //        io being kept under --launch.
    const procPidRusageCalls: { pid: number; flavor: number }[] = [];
    const procPidRusage: ProcPidRusage = (pid, flavor, buffer) => {
      procPidRusageCalls.push({ pid, flavor });
      if (flavor === 4) {
        const view = new DataView(buffer.buffer, buffer.byteOffset);
        view.setBigUint64(240, 3221225472n, true);
      }
      return 0;
    };
    installHarness({ platform: "darwin", pids: [1111, 2222], procPidRusage });

    const { result, stdout } = await captureProcessStreams(() =>
      runEval(perfArgv({ dbPath: dbPath(), launch: true })),
    );

    expect(result).toBe(0);
    expect(stdout).toContain("run_id: r1");
    const byName = metricsByName(dbPath(), "r1");
    expect(byName.get("peak_rss_bytes")).toEqual({ status: "ok", value: 3221225472 });
    expectUnavailable(byName.get("ssd_read_bytes"), LAUNCH_IO_REASON);
    expectUnavailable(byName.get("ssd_write_bytes"), LAUNCH_IO_REASON);
    expect(procPidRusageCalls.length).toBeGreaterThan(0);
    for (const call of procPidRusageCalls) {
      expect(call).toEqual({ pid: 2222, flavor: 4 });
    }
    expect(unexpectedRusageCalls).toEqual([]);
  });
});
