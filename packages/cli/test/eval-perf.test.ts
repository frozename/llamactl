import type { GttObservation } from "@llamactl/core/resources/memory";

import { type EngineVersionInfo, listPerfRuns } from "@llamactl/eval";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as evalCmd from "../src/commands/eval.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { captureProcessStreams, isPlainRecord } from "./helpers.js";

/**
 * RED pins for #521: `llamactl eval perf` runs the perf suite against an
 * already-serving engine at --url. On Linux loopback it wires the engine
 * pid's /proc I/O + VmHWM readers and a GTT probe into runPerfSuite,
 * fills provenance from --binary/--gguf/--quant/--ctx/--flags/--slots,
 * refuses --pid off-loopback, and records per-reader unavailable reasons
 * everywhere else. `__setEvalPerfTestSeams` narrows every side effect —
 * engine fetches, proc reads, the GTT probe and the provenance readers —
 * so the cases stay hermetic. At base `eval perf` is an unknown
 * subcommand, so every case fails on the seam-presence assertion before
 * runEval is reached.
 */

const { runEval } = evalCmd;

interface EvalPerfProvenanceReaders {
  sha256File(path: string): string | Promise<string>;
  engineVersion(binaryPath: string): EngineVersionInfo | Promise<EngineVersionInfo>;
  hostname(): string;
}

interface EvalPerfTestSeams {
  runPerfSuite?: (db: Database, opts: unknown) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  provenanceReaders?: EvalPerfProvenanceReaders;
  platform?: NodeJS.Platform;
  readFile?: (path: string) => Promise<string>;
  procPidRusage?: (pid: number, flavor: number, buffer: Uint8Array) => number | Promise<number>;
  probeGtt?: () => Promise<GttObservation>;
  clock?: { now(): number };
}

const GTT_OK: GttObservation = {
  status: "ok",
  totalBytes: 1000,
  usedBytes: 123,
  observedAtMs: 1,
  source: "/sys/class/drm/card1/device",
  scope: "shared",
};

const LOOPBACK_URL = "http://127.0.0.1:18080";
const REMOTE_URL = "http://10.0.0.5:8080";

function perfSeams(): (seams: EvalPerfTestSeams) => void {
  const setSeams = Reflect.get(evalCmd, "__setEvalPerfTestSeams") as unknown;
  expect(typeof setSeams).toBe("function");
  return setSeams as (seams: EvalPerfTestSeams) => void;
}

interface RunCall {
  db: Database;
  opts: unknown;
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

function readersOf(opts: Record<string, unknown>): Record<string, unknown> | undefined {
  const readers: unknown = opts["readers"];
  if (readers === undefined) return undefined;
  if (!isPlainRecord(readers)) throw new Error("expected opts.readers to be a record");
  return readers;
}

function readerFn(
  opts: Record<string, unknown>,
  key: string,
): (() => Promise<unknown>) | undefined {
  const reader: unknown = readersOf(opts)?.[key];
  if (typeof reader !== "function") return undefined;
  return reader as () => Promise<unknown>;
}

function readerReasonsOf(opts: Record<string, unknown>): Record<string, unknown> {
  return recordField(opts, "readerReasons");
}

function reasonText(reasons: Record<string, unknown>, key: string): string {
  const reason: unknown = reasons[key];
  if (typeof reason !== "string") {
    throw new Error(`expected readerReasons.${key} to be a string`);
  }
  return reason;
}

function fakeProcFs(): { readFile: (path: string) => Promise<string>; ioReads: () => number } {
  let ioReads = 0;
  const readFile = (path: string): Promise<string> => {
    if (path === "/proc/4242/io") {
      ioReads += 1;
      return Promise.resolve(
        `read_bytes: ${String(ioReads * 4096)}\nwrite_bytes: ${String(ioReads * 512)}\n`,
      );
    }
    if (path === "/proc/4242/status") {
      return Promise.resolve("VmHWM:\t  2048 kB\n");
    }
    return Promise.reject(new Error(`unexpected proc read: ${path}`));
  };
  return { readFile, ioReads: () => ioReads };
}

function engineFetchWith(
  servedIds: readonly string[],
  other: (url: string) => Promise<Response>,
): typeof fetch {
  const fetchImpl = (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/v1/models")) {
      return Promise.resolve(
        Response.json({ object: "list", data: servedIds.map((id) => ({ id })) }),
      );
    }
    return other(url);
  };
  return fetchImpl as typeof fetch;
}

function fakeEngineFetch(servedIds: readonly string[]): typeof fetch {
  return engineFetchWith(servedIds, (url) =>
    Promise.reject(new Error(`unexpected engine request: ${url}`)),
  );
}

function failingEngineFetch(servedIds: readonly string[]): typeof fetch {
  return engineFetchWith(servedIds, () =>
    Promise.resolve(new Response("engine unavailable", { status: 503 })),
  );
}

function provenanceFakes(digests: Record<string, string>): {
  readers: EvalPerfProvenanceReaders;
  sha256Calls: string[];
  versionCalls: string[];
} {
  const sha256Calls: string[] = [];
  const versionCalls: string[] = [];
  const readers: EvalPerfProvenanceReaders = {
    sha256File: (path: string): string => {
      sha256Calls.push(path);
      const digest = digests[path];
      if (digest === undefined) throw new Error(`no fake digest for ${path}`);
      return digest;
    },
    engineVersion: (binaryPath: string): EngineVersionInfo => {
      versionCalls.push(binaryPath);
      return { version: "b9000", commit: "abc1234" };
    },
    hostname: (): string => "h1",
  };
  return { readers, sha256Calls, versionCalls };
}

function perfArgv(dbPath: string, args: readonly string[]): string[] {
  return ["perf", "--db", dbPath, "--suite", "perf-quick", "--run-id", "r1", ...args];
}

let tmp = "";
let previousDevStorage: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-eval-perf-"));
  previousDevStorage = process.env["DEV_STORAGE"];
  process.env["DEV_STORAGE"] = tmp;
});

afterEach(() => {
  const resetSeams = Reflect.get(evalCmd, "__resetEvalPerfTestSeams") as unknown;
  if (typeof resetSeams === "function") (resetSeams as () => void)();
  if (previousDevStorage === undefined) delete process.env["DEV_STORAGE"];
  else process.env["DEV_STORAGE"] = previousDevStorage;
  rmSync(tmp, { recursive: true, force: true });
});

test("linux --pid wires createPerfHostReaders io/peakRss into runPerfSuite (kills: readers left unset)", async () => {
  const proc = fakeProcFs();
  const run = fakeRunPerfSuite();
  perfSeams()({
    platform: "linux",
    fetchImpl: fakeEngineFetch(["m"]),
    readFile: proc.readFile,
    runPerfSuite: run.runPerfSuite,
  });
  const dbPath = join(tmp, "perf.sqlite");

  const { result, stdout } = await captureProcessStreams(() =>
    runEval(
      perfArgv(dbPath, [
        "--url",
        LOOPBACK_URL,
        "--engine",
        "gufo",
        "--model",
        "m",
        "--pid",
        "4242",
      ]),
    ),
  );

  expect(result).toBe(0);
  expect(stdout).toContain("run_id: r1");
  expect(run.calls).toHaveLength(1);
  const opts = runOpts(run.calls[0]);
  expect(opts["model_name"]).toBe("m");
  expect(opts["run_id"]).toBe("r1");
  expect(opts["decodeTokens"]).toBe(16);
  expect(opts["concurrencyPromptWords"]).toBe(128);
  const io = readerFn(opts, "io");
  expect(typeof io).toBe("function");
  expect(await io!()).toEqual({
    readBytes: proc.ioReads() * 4096,
    writeBytes: proc.ioReads() * 512,
  });
  const peakRss = readerFn(opts, "peakRss");
  expect(typeof peakRss).toBe("function");
  expect(await peakRss!()).toBe(2048 * 1024);
  const provenance = recordField(opts, "provenance");
  expect(provenance["engine"]).toBe("gufo");
});

test("linux loopback engine wires a GTT reader from probeGtt (kills: gtt reader not wired)", async () => {
  const run = fakeRunPerfSuite();
  perfSeams()({
    platform: "linux",
    fetchImpl: fakeEngineFetch(["m"]),
    probeGtt: () => Promise.resolve(GTT_OK),
    runPerfSuite: run.runPerfSuite,
  });
  const dbPath = join(tmp, "perf.sqlite");

  const { result } = await captureProcessStreams(() =>
    runEval(perfArgv(dbPath, ["--url", LOOPBACK_URL, "--engine", "llamacpp", "--model", "m"])),
  );

  expect(result).toBe(0);
  expect(run.calls).toHaveLength(1);
  const opts = runOpts(run.calls[0]);
  const gtt = readerFn(opts, "gtt");
  expect(typeof gtt).toBe("function");
  const observation: unknown = await gtt!();
  expect(isPlainRecord(observation)).toBe(true);
  if (isPlainRecord(observation)) {
    expect(observation["usedBytes"]).toBe(123);
  }
});

test("darwin --pid wires proc_pid_rusage io and keeps peakRss/GTT platform reasons (kills: hostReaders not forwarding seams.procPidRusage)", async () => {
  // Kills: dropping the procPidRusage seam before createPerfHostReaders, or
  //        reusing bench-schedule gateway reasons for the remaining readers.
  const proc = fakeProcFs();
  const run = fakeRunPerfSuite();
  const rusageCalls: number[] = [];
  perfSeams()({
    platform: "darwin",
    fetchImpl: fakeEngineFetch(["m"]),
    readFile: proc.readFile,
    procPidRusage: (pid, _flavor, buffer) => {
      rusageCalls.push(pid);
      const view = new DataView(buffer.buffer, buffer.byteOffset);
      view.setBigUint64(144, 12288n, true);
      view.setBigUint64(152, 8192n, true);
      return 0;
    },
    probeGtt: () => Promise.resolve(GTT_OK),
    runPerfSuite: run.runPerfSuite,
  });
  const dbPath = join(tmp, "perf.sqlite");

  const { result } = await captureProcessStreams(() =>
    runEval(
      perfArgv(dbPath, [
        "--url",
        LOOPBACK_URL,
        "--engine",
        "llamacpp",
        "--model",
        "m",
        "--pid",
        "4242",
      ]),
    ),
  );

  expect(result).toBe(0);
  expect(run.calls).toHaveLength(1);
  const opts = runOpts(run.calls[0]);
  const readers = readersOf(opts) ?? {};
  expect(typeof readers["io"]).toBe("function");
  const io = readerFn(opts, "io");
  expect(await io!()).toEqual({ readBytes: 12288, writeBytes: 8192 });
  expect(rusageCalls).toEqual([4242]);
  expect(readers["peakRss"]).toBeUndefined();
  expect(readers["gtt"]).toBeUndefined();
  const reasons = readerReasonsOf(opts);
  expect(reasons["io"]).toBeUndefined();
  expect(reasonText(reasons, "gtt")).toBe(
    "GTT counters (/sys/class/drm/card*/device/mem_info_gtt_used) are Linux-only; " +
      "no GTT reader on darwin",
  );
  for (const key of ["peakRss", "gtt"] as const) {
    expect(reasonText(reasons, key).toLowerCase()).not.toContain("agent gateway");
  }
});

test("no --pid records the engine-PID-unknown reason (kills: inventing a pid)", async () => {
  const run = fakeRunPerfSuite();
  perfSeams()({
    platform: "linux",
    fetchImpl: fakeEngineFetch(["m"]),
    readFile: fakeProcFs().readFile,
    probeGtt: () => Promise.resolve(GTT_OK),
    runPerfSuite: run.runPerfSuite,
  });
  const dbPath = join(tmp, "perf.sqlite");

  const { result } = await captureProcessStreams(() =>
    runEval(perfArgv(dbPath, ["--url", LOOPBACK_URL, "--engine", "llamacpp", "--model", "m"])),
  );

  expect(result).toBe(0);
  expect(run.calls).toHaveLength(1);
  const opts = runOpts(run.calls[0]);
  const readers = readersOf(opts) ?? {};
  expect(readers["io"]).toBeUndefined();
  expect(readers["peakRss"]).toBeUndefined();
  const reasons = readerReasonsOf(opts);
  expect(reasonText(reasons, "io")).toBe(
    "engine PID unknown; per-process I/O and VmHWM counters need the engine process id",
  );
});

test("--pid with a non-loopback --url is refused (kills: removing the loopback guard)", async () => {
  const run = fakeRunPerfSuite();
  perfSeams()({
    platform: "linux",
    fetchImpl: fakeEngineFetch(["m"]),
    runPerfSuite: run.runPerfSuite,
  });
  const dbPath = join(tmp, "perf.sqlite");

  const { result, stderr } = await captureProcessStreams(() =>
    runEval(
      perfArgv(dbPath, [
        "--url",
        REMOTE_URL,
        "--engine",
        "llamacpp",
        "--model",
        "m",
        "--pid",
        "4242",
      ]),
    ),
  );

  expect(result).toBe(1);
  expect(stderr).toContain(
    "eval perf: --pid needs a loopback --url (got 10.0.0.5); " +
      "host counters are read on this machine",
  );
  expect(run.calls).toHaveLength(0);
});

for (const [host, kills] of [
  ["127.evil.example", 'hostname.startsWith("127.") loopback check'],
  ["127.0.0.1.evil.example", "dropping the loopback regex end anchor"],
  ["127.evil.example.com", "widening the loopback regex \\d+ to \\w+"],
] as const) {
  test(`--pid with the 127.-prefixed DNS name ${host} is refused (kills: ${kills})`, async () => {
    const run = fakeRunPerfSuite();
    perfSeams()({
      platform: "linux",
      fetchImpl: fakeEngineFetch(["m"]),
      readFile: fakeProcFs().readFile,
      runPerfSuite: run.runPerfSuite,
    });
    const dbPath = join(tmp, "perf.sqlite");

    const { result, stderr } = await captureProcessStreams(() =>
      runEval(
        perfArgv(dbPath, [
          "--url",
          `http://${host}:80`,
          "--engine",
          "llamacpp",
          "--model",
          "m",
          "--pid",
          "4242",
        ]),
      ),
    );

    expect(result).toBe(1);
    expect(stderr).toContain(
      `eval perf: --pid needs a loopback --url (got ${host}); ` +
        "host counters are read on this machine",
    );
    expect(run.calls).toHaveLength(0);
  });
}

for (const [url, kills] of [
  ["http://127.1:18080", "rejecting WHATWG-normalized IPv4 shorthand"],
  ["http://127.0.0.5:18080", "narrowing loopback to 127.0.0.1 only"],
  ["http://localhost:18080", "dropping the localhost branch"],
  ["http://[::1]:18080", "dropping the [::1] branch"],
] as const) {
  test(`--pid with loopback --url ${url} wires host readers (kills: ${kills})`, async () => {
    const proc = fakeProcFs();
    const run = fakeRunPerfSuite();
    perfSeams()({
      platform: "linux",
      fetchImpl: fakeEngineFetch(["m"]),
      readFile: proc.readFile,
      probeGtt: () => Promise.resolve(GTT_OK),
      runPerfSuite: run.runPerfSuite,
    });
    const dbPath = join(tmp, "perf.sqlite");

    const { result, stderr } = await captureProcessStreams(() =>
      runEval(
        perfArgv(dbPath, ["--url", url, "--engine", "llamacpp", "--model", "m", "--pid", "4242"]),
      ),
    );

    expect(stderr).not.toContain("--pid needs a loopback --url");
    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const opts = runOpts(run.calls[0]);
    const io = readerFn(opts, "io");
    expect(typeof io).toBe("function");
    expect(typeof readerFn(opts, "gtt")).toBe("function");
  });
}

test("--hf-revision is recorded verbatim in provenance (kills: dropping the hf_revision spread in buildProvenance)", async () => {
  const rev = "fedcba9876543210fedcba9876543210fedcba98";
  const prov = provenanceFakes({});
  const run = fakeRunPerfSuite();
  perfSeams()({
    platform: "darwin",
    fetchImpl: fakeEngineFetch(["m"]),
    provenanceReaders: prov.readers,
    runPerfSuite: run.runPerfSuite,
  });
  const dbPath = join(tmp, "perf.sqlite");

  const { result } = await captureProcessStreams(() =>
    runEval(
      perfArgv(dbPath, [
        "--url",
        LOOPBACK_URL,
        "--engine",
        "llamacpp",
        "--model",
        "m",
        "--hf-revision",
        rev,
      ]),
    ),
  );

  expect(result).toBe(0);
  expect(run.calls).toHaveLength(1);
  const provenance = recordField(runOpts(run.calls[0]), "provenance");
  expect(provenance["hf_revision"]).toBe(rev);
  const unavailable: unknown = provenance["unavailable"];
  if (!isPlainRecord(unavailable)) {
    throw new Error("expected provenance.unavailable to be a record");
  }
  expect("hf_revision" in unavailable).toBe(false);
});

test("non-loopback --url without --pid sets no host readers and names the remote host (kills: reading this host's GTT for a remote engine)", async () => {
  const run = fakeRunPerfSuite();
  perfSeams()({
    platform: "linux",
    fetchImpl: fakeEngineFetch(["m"]),
    probeGtt: () => Promise.resolve(GTT_OK),
    runPerfSuite: run.runPerfSuite,
  });
  const dbPath = join(tmp, "perf.sqlite");

  const { result } = await captureProcessStreams(() =>
    runEval(perfArgv(dbPath, ["--url", REMOTE_URL, "--engine", "llamacpp", "--model", "m"])),
  );

  expect(result).toBe(0);
  expect(run.calls).toHaveLength(1);
  const opts = runOpts(run.calls[0]);
  const readers = readersOf(opts);
  for (const key of ["io", "peakRss", "gtt"] as const) {
    expect(readers?.[key]).toBeUndefined();
  }
  const reasons = readerReasonsOf(opts);
  expect(reasonText(reasons, "gtt")).toBe(
    "engine at http://10.0.0.5:8080 is not on this host; " +
      "GTT counters are read from the local /sys/class/drm",
  );
});

test("real binary/gguf/quant/ctx/flags/slots reach provenance and the suite (kills: gateway-style unavailable provenance)", async () => {
  const rev = "0123456789abcdef0123456789abcdef01234567";
  const ggufDir = join(tmp, "models--o--r", "snapshots", rev);
  mkdirSync(ggufDir, { recursive: true });
  const ggufPath = join(ggufDir, "m.gguf");
  writeFileSync(ggufPath, "fake gguf", "utf8");
  const prov = provenanceFakes({
    "/fake/llama-server": "a".repeat(64),
    [ggufPath]: "b".repeat(64),
  });
  const run = fakeRunPerfSuite();
  perfSeams()({
    platform: "darwin",
    fetchImpl: fakeEngineFetch(["m"]),
    provenanceReaders: prov.readers,
    runPerfSuite: run.runPerfSuite,
  });
  const dbPath = join(tmp, "perf.sqlite");

  const { result } = await captureProcessStreams(() =>
    runEval(
      perfArgv(dbPath, [
        "--url",
        LOOPBACK_URL,
        "--engine",
        "llamacpp",
        "--model",
        "m",
        "--binary",
        "/fake/llama-server",
        "--gguf",
        ggufPath,
        "--quant",
        "Q4_K_M",
        "--ctx",
        "32768",
        "--slots",
        "4",
        "--flags=-ngl 99 --flash-attn",
      ]),
    ),
  );

  expect(result).toBe(0);
  expect(run.calls).toHaveLength(1);
  expect(prov.versionCalls).toEqual(["/fake/llama-server"]);
  const opts = runOpts(run.calls[0]);
  const provenance = recordField(opts, "provenance");
  expect(provenance["binary_sha256"]).toBe("a".repeat(64));
  expect(provenance["gguf_sha256"]).toBe("b".repeat(64));
  expect(provenance["engine_version"]).toBe("b9000");
  expect(provenance["engine_commit"]).toBe("abc1234");
  expect(provenance["hf_revision"]).toBe(rev);
  expect(provenance["quant"]).toBe("Q4_K_M");
  expect(provenance["ctx"]).toBe(32768);
  expect(provenance["flags"]).toEqual(["-ngl", "99", "--flash-attn"]);
  expect(provenance["host"]).toBe("h1");
  const unavailable: unknown = provenance["unavailable"];
  if (!isPlainRecord(unavailable)) {
    throw new Error("expected provenance.unavailable to be a record");
  }
  for (const key of ["binary_sha256", "gguf_sha256", "quant", "ctx"] as const) {
    expect(key in unavailable).toBe(false);
  }
  expect(opts["ctx"]).toBe(32768);
  expect(opts["slots"]).toBe(4);
});

test("unknown --engine is rejected (kills: dropping the EVAL_ENGINES check)", async () => {
  const run = fakeRunPerfSuite();
  perfSeams()({
    platform: "linux",
    fetchImpl: fakeEngineFetch(["m"]),
    runPerfSuite: run.runPerfSuite,
  });
  const dbPath = join(tmp, "perf.sqlite");

  const { result, stderr } = await captureProcessStreams(() =>
    runEval(perfArgv(dbPath, ["--url", LOOPBACK_URL, "--engine", "vllm", "--model", "m"])),
  );

  expect(result).toBe(1);
  expect(stderr).toContain(
    "eval perf: unknown engine 'vllm' (expected one of llamacpp, omlx, gufo, kapitsa)",
  );
  expect(run.calls).toHaveLength(0);
});

test("engine not serving --model is refused before running (kills: skipping the served-model check)", async () => {
  const run = fakeRunPerfSuite();
  perfSeams()({
    platform: "linux",
    fetchImpl: fakeEngineFetch(["other"]),
    runPerfSuite: run.runPerfSuite,
  });
  const dbPath = join(tmp, "perf.sqlite");

  const { result, stderr } = await captureProcessStreams(() =>
    runEval(perfArgv(dbPath, ["--url", LOOPBACK_URL, "--engine", "llamacpp", "--model", "m"])),
  );

  expect(result).toBe(1);
  expect(stderr).toContain(
    "eval perf: engine at http://127.0.0.1:18080 is not serving 'm' (serving: other)",
  );
  expect(run.calls).toHaveLength(0);
});

test("missing --url or --model is a usage error", async () => {
  perfSeams()({});
  const dbPath = join(tmp, "perf.sqlite");

  const neither = await captureProcessStreams(() =>
    runEval(perfArgv(dbPath, ["--engine", "llamacpp"])),
  );
  expect(neither.result).toBe(1);
  expect(neither.stderr).toContain("eval perf: --url and --model are required");

  const noModel = await captureProcessStreams(() =>
    runEval(perfArgv(dbPath, ["--engine", "llamacpp", "--url", LOOPBACK_URL])),
  );
  expect(noModel.result).toBe(1);
  expect(noModel.stderr).toContain("eval perf: --url and --model are required");
});

test("end-to-end with the real runPerfSuite writes host-reader rows to --db (kills: readers built but not passed)", async () => {
  const proc = fakeProcFs();
  const prov = provenanceFakes({});
  perfSeams()({
    platform: "linux",
    fetchImpl: failingEngineFetch(["m"]),
    readFile: proc.readFile,
    probeGtt: () => Promise.resolve(GTT_OK),
    provenanceReaders: prov.readers,
    clock: { now: () => 0 },
  });
  const dbPath = join(tmp, "perf.sqlite");

  const { result, stdout } = await captureProcessStreams(() =>
    runEval(
      perfArgv(dbPath, [
        "--url",
        LOOPBACK_URL,
        "--engine",
        "llamacpp",
        "--model",
        "m",
        "--pid",
        "4242",
      ]),
    ),
  );

  expect(result).toBe(0);
  expect(stdout).toContain("peak_rss_bytes");
  expect(stdout).toContain("unavailable");
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = listPerfRuns(db, { run_id: "r1" });
    const byName = new Map(rows.map((row) => [row.metric_name, row.metric]));
    expect(byName.get("peak_rss_bytes")).toEqual({ status: "ok", value: 2097152 });
    const ssdRead = byName.get("ssd_read_bytes");
    if (ssdRead?.status !== "ok") {
      throw new Error("expected ssd_read_bytes to be an ok metric");
    }
    expect(ssdRead.value).toBeGreaterThan(0);
    expect(byName.get("peak_gtt_bytes")).toEqual({ status: "ok", value: 123 });
    expect(byName.get("prefill_4k_tps")?.status).toBe("unavailable");
  } finally {
    db.close();
  }
});

test("eval --help lists the perf subcommand (kills: usage not updated)", async () => {
  perfSeams()({});

  const { result, stdout } = await captureProcessStreams(() => runEval(["--help"]));

  expect(result).toBe(0);
  expect(stdout).toContain(
    "perf --url <http://...> --engine <llamacpp|omlx|gufo|kapitsa> --model <id>",
  );
});

test("eval --help lists --hf-revision for perf (kills: dropping [--hf-revision <rev>] from USAGE)", async () => {
  perfSeams()({});

  const { result, stdout } = await captureProcessStreams(() => runEval(["--help"]));

  expect(result).toBe(0);
  expect(stdout).toContain("[--gguf <path>] [--hf-revision <rev>] [--quant <q>]");
});

test("eval --help says GTT is read on any loopback Linux run (kills: USAGE gating GTT on --pid)", async () => {
  perfSeams()({});

  const { result, stdout } = await captureProcessStreams(() => runEval(["--help"]));

  expect(result).toBe(0);
  expect(stdout).toContain(
    "It records SSD\n      I/O and VmHWM when --pid names a local engine, and GTT on any\n      loopback Linux run, with or without --pid.",
  );
  expect(stdout).not.toContain("VmHWM and GTT when --pid");
});

describe("#521 eval perf slot discovery", () => {
  function slotFetch(respond: () => Response): {
    fetchImpl: typeof fetch;
    propsCalls: () => number;
  } {
    let calls = 0;
    const fetchImpl = engineFetchWith(["m"], (url) => {
      if (!url.endsWith("/props")) {
        return Promise.reject(new Error(`unexpected engine request: ${url}`));
      }
      calls += 1;
      return Promise.resolve(respond());
    });
    return { fetchImpl, propsCalls: () => calls };
  }

  test("llamacpp without --slots probes GET /props and forwards total_slots (kills: the probe result not reaching runPerfSuite)", async () => {
    const probe = slotFetch(() => Response.json({ total_slots: 4 }));
    const run = fakeRunPerfSuite();
    perfSeams()({
      platform: "darwin",
      fetchImpl: probe.fetchImpl,
      runPerfSuite: run.runPerfSuite,
    });
    const dbPath = join(tmp, "perf.sqlite");

    const { result } = await captureProcessStreams(() =>
      runEval(perfArgv(dbPath, ["--url", LOOPBACK_URL, "--engine", "llamacpp", "--model", "m"])),
    );

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const opts = runOpts(run.calls[0]);
    expect(opts["slots"]).toBe(4);
    expect(opts["slotsReason"]).toBeUndefined();
    expect(probe.propsCalls()).toBe(1);
  });

  test("a failed /props probe forwards slotsReason naming the GET and --slots (kills: dropping the probe reason)", async () => {
    const probe = slotFetch(() => new Response("nope", { status: 404 }));
    const run = fakeRunPerfSuite();
    perfSeams()({
      platform: "darwin",
      fetchImpl: probe.fetchImpl,
      runPerfSuite: run.runPerfSuite,
    });
    const dbPath = join(tmp, "perf.sqlite");

    const { result } = await captureProcessStreams(() =>
      runEval(perfArgv(dbPath, ["--url", LOOPBACK_URL, "--engine", "llamacpp", "--model", "m"])),
    );

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const opts = runOpts(run.calls[0]);
    expect(opts["slots"]).toBeUndefined();
    const reason: unknown = opts["slotsReason"];
    expect(typeof reason).toBe("string");
    if (typeof reason !== "string") throw new Error("expected slotsReason to be a string");
    expect(reason).toContain("GET http://127.0.0.1:18080/props returned HTTP 404");
    expect(reason).toContain("--slots");
  });

  test("guard: --slots wins and /props is never probed", async () => {
    const probe = slotFetch(() => Response.json({ total_slots: 8 }));
    const run = fakeRunPerfSuite();
    perfSeams()({
      platform: "darwin",
      fetchImpl: probe.fetchImpl,
      runPerfSuite: run.runPerfSuite,
    });
    const dbPath = join(tmp, "perf.sqlite");

    const { result } = await captureProcessStreams(() =>
      runEval(
        perfArgv(dbPath, [
          "--url",
          LOOPBACK_URL,
          "--engine",
          "llamacpp",
          "--model",
          "m",
          "--slots",
          "2",
        ]),
      ),
    );

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const opts = runOpts(run.calls[0]);
    expect(opts["slots"]).toBe(2);
    expect(probe.propsCalls()).toBe(0);
  });

  test("discovered slots reach the real runPerfSuite concurrency gate", async () => {
    const fetchImpl = engineFetchWith(["m"], (url) => {
      if (url.endsWith("/props")) {
        return Promise.resolve(Response.json({ total_slots: 1 }));
      }
      return Promise.resolve(new Response("engine unavailable", { status: 503 }));
    });
    const prov = provenanceFakes({});
    perfSeams()({
      platform: "linux",
      fetchImpl,
      probeGtt: () => Promise.resolve(GTT_OK),
      provenanceReaders: prov.readers,
      clock: { now: () => 0 },
    });
    const dbPath = join(tmp, "perf.sqlite");

    const { result } = await captureProcessStreams(() =>
      runEval(perfArgv(dbPath, ["--url", LOOPBACK_URL, "--engine", "llamacpp", "--model", "m"])),
    );

    expect(result).toBe(0);
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = listPerfRuns(db, { run_id: "r1" });
      const byName = new Map(rows.map((row) => [row.metric_name, row.metric]));
      expect(byName.get("c2_tps")).toEqual({
        status: "unavailable",
        value: null,
        reason: "engine slots 1 < concurrency 2",
      });
    } finally {
      db.close();
    }
  });

  test("omlx without --slots never probes /props and points at --slots (kills: probing llama-server /props for non-llamacpp engines)", async () => {
    const probe = slotFetch(() => Response.json({ total_slots: 4 }));
    const run = fakeRunPerfSuite();
    perfSeams()({
      platform: "darwin",
      fetchImpl: probe.fetchImpl,
      runPerfSuite: run.runPerfSuite,
    });
    const dbPath = join(tmp, "perf.sqlite");

    const { result } = await captureProcessStreams(() =>
      runEval(perfArgv(dbPath, ["--url", LOOPBACK_URL, "--engine", "omlx", "--model", "m"])),
    );

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const opts = runOpts(run.calls[0]);
    expect(opts["slots"]).toBeUndefined();
    expect(probe.propsCalls()).toBe(0);
    const reason: unknown = opts["slotsReason"];
    expect(typeof reason).toBe("string");
    if (typeof reason !== "string") throw new Error("expected slotsReason to be a string");
    expect(reason).toContain("engine 'omlx'");
    expect(reason).toContain("--slots");
  });
});

describe("#521 eval perf load reason", () => {
  test("forwards a loadReason naming --url, --model and eval perf (kills: buildOpts dropping loadReason)", async () => {
    const run = fakeRunPerfSuite();
    perfSeams()({
      platform: "darwin",
      fetchImpl: fakeEngineFetch(["m"]),
      runPerfSuite: run.runPerfSuite,
    });
    const dbPath = join(tmp, "perf.sqlite");

    const { result } = await captureProcessStreams(() =>
      runEval(
        perfArgv(dbPath, [
          "--url",
          LOOPBACK_URL,
          "--engine",
          "llamacpp",
          "--model",
          "m",
          "--slots",
          "1",
        ]),
      ),
    );

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const reason: unknown = runOpts(run.calls[0])["loadReason"];
    expect(typeof reason).toBe("string");
    if (typeof reason !== "string") throw new Error("expected loadReason to be a string");
    expect(reason).toContain(LOOPBACK_URL);
    expect(reason).toContain("'m'");
    expect(reason).toContain("eval perf");
    expect(reason).toMatch(/does not (launch|load|reload)/);
  });

  test("names the remote --url in loadReason without a loopback constant (kills: a hard-coded loopback URL in the reason)", async () => {
    const run = fakeRunPerfSuite();
    perfSeams()({
      platform: "darwin",
      fetchImpl: fakeEngineFetch(["m"]),
      runPerfSuite: run.runPerfSuite,
    });
    const dbPath = join(tmp, "perf.sqlite");

    const { result } = await captureProcessStreams(() =>
      runEval(
        perfArgv(dbPath, [
          "--url",
          REMOTE_URL,
          "--engine",
          "llamacpp",
          "--model",
          "m",
          "--slots",
          "1",
        ]),
      ),
    );

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const reason: unknown = runOpts(run.calls[0])["loadReason"];
    expect(typeof reason).toBe("string");
    if (typeof reason !== "string") throw new Error("expected loadReason to be a string");
    expect(reason).toContain(REMOTE_URL);
    expect(reason).not.toContain("127.0.0.1");
    expect(reason).toContain("'m'");
    expect(reason).toContain("eval perf");
    expect(reason).toMatch(/does not (launch|load|reload)/);
  });

  test("end-to-end: the loadReason reaches the recorded load metric reasons (kills: the reason not reaching runPerfSuite)", async () => {
    const prov = provenanceFakes({});
    perfSeams()({
      platform: "darwin",
      fetchImpl: failingEngineFetch(["m"]),
      provenanceReaders: prov.readers,
      clock: { now: () => 0 },
    });
    const dbPath = join(tmp, "perf.sqlite");

    const { result } = await captureProcessStreams(() =>
      runEval(
        perfArgv(dbPath, [
          "--url",
          LOOPBACK_URL,
          "--engine",
          "llamacpp",
          "--model",
          "m",
          "--slots",
          "1",
        ]),
      ),
    );

    expect(result).toBe(0);
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = listPerfRuns(db, { run_id: "r1" });
      const byName = new Map(rows.map((row) => [row.metric_name, row.metric]));
      for (const name of ["load_cold_ms", "load_warm_ms"] as const) {
        const m = byName.get(name);
        expect(m?.status).toBe("unavailable");
        if (m?.status !== "unavailable") {
          throw new Error(`expected ${name} to be an unavailable metric`);
        }
        expect(m.reason).toContain("eval perf");
        expect(m.reason).toContain("'m'");
        expect(m.reason).not.toContain("no load hooks injected");
      }
    } finally {
      db.close();
    }
  });
});

describe("#521 eval perf GTT reader status", () => {
  test("a denied GTT probe is stored and printed with its status (kills: eval perf dropping the probe status between probeGpuGtt and the stored row)", async () => {
    const proc = fakeProcFs();
    const prov = provenanceFakes({});
    perfSeams()({
      platform: "linux",
      fetchImpl: failingEngineFetch(["m"]),
      readFile: proc.readFile,
      probeGtt: () =>
        Promise.resolve({
          status: "denied",
          totalBytes: null,
          usedBytes: null,
          observedAtMs: null,
          source: "",
          scope: "shared",
        }),
      provenanceReaders: prov.readers,
      clock: { now: () => 0 },
    });
    const dbPath = join(tmp, "perf.sqlite");

    const { result, stdout } = await captureProcessStreams(() =>
      runEval(
        perfArgv(dbPath, [
          "--url",
          LOOPBACK_URL,
          "--engine",
          "llamacpp",
          "--model",
          "m",
          "--pid",
          "4242",
        ]),
      ),
    );

    expect(result).toBe(0);
    expect(stdout).toContain(
      "| peak_gtt_bytes | unavailable | unavailable | GTT reader returned no sample (status: denied) |",
    );
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = listPerfRuns(db, { run_id: "r1" });
      const byName = new Map(rows.map((row) => [row.metric_name, row.metric]));
      expect(byName.get("peak_gtt_bytes")).toEqual({
        value: null,
        status: "unavailable",
        reason: "GTT reader returned no sample (status: denied)",
      });
    } finally {
      db.close();
    }
  });
});

describe("#521 eval perf launch flags", () => {
  test("no --flags records provenance.flags null with the engine-url reason", async () => {
    // Kills: splitFlags returning [] for an absent --flags.
    const prov = provenanceFakes({});
    const run = fakeRunPerfSuite();
    perfSeams()({
      platform: "darwin",
      fetchImpl: fakeEngineFetch(["m"]),
      provenanceReaders: prov.readers,
      runPerfSuite: run.runPerfSuite,
    });
    const dbPath = join(tmp, "perf.sqlite");

    const { result } = await captureProcessStreams(() =>
      runEval(perfArgv(dbPath, ["--url", LOOPBACK_URL, "--engine", "llamacpp", "--model", "m"])),
    );

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const provenance = recordField(runOpts(run.calls[0]), "provenance");
    expect(provenance["flags"]).toBeNull();
    const unavailable = recordField(provenance, "unavailable");
    expect(unavailable["flags"]).toBe(
      `no --flags given; the launch flags of the engine at ${LOOPBACK_URL} are not known`,
    );
  });

  test("guard: --flags records the split list with no unavailable entry", async () => {
    const prov = provenanceFakes({});
    const run = fakeRunPerfSuite();
    perfSeams()({
      platform: "darwin",
      fetchImpl: fakeEngineFetch(["m"]),
      provenanceReaders: prov.readers,
      runPerfSuite: run.runPerfSuite,
    });
    const dbPath = join(tmp, "perf.sqlite");

    const { result } = await captureProcessStreams(() =>
      runEval(
        perfArgv(dbPath, [
          "--url",
          LOOPBACK_URL,
          "--engine",
          "llamacpp",
          "--model",
          "m",
          "--flags=-ngl 99",
        ]),
      ),
    );

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const provenance = recordField(runOpts(run.calls[0]), "provenance");
    expect(provenance["flags"]).toEqual(["-ngl", "99"]);
    const unavailable = recordField(provenance, "unavailable");
    expect("flags" in unavailable).toBe(false);
  });
});
