// RED pins for #521: `llamactl eval perf` forwards the injected
// proc_pid_rusage seam into createPerfHostReaders on darwin, and the real
// perf suite stores increasing rusage deltas as SSD read/write bytes.

import type { GttObservation } from "@llamactl/core/resources/memory";

import { type EngineVersionInfo, listPerfRuns } from "@llamactl/eval";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as evalCmd from "../src/commands/eval.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import { captureProcessStreams, isPlainRecord } from "./helpers.js";

const { runEval } = evalCmd;

interface EvalPerfProvenanceReaders {
  sha256File(path: string): string | Promise<string>;
  engineVersion(binaryPath: string): EngineVersionInfo | Promise<EngineVersionInfo>;
  hostname(): string;
}

type ProcPidRusage = (pid: number, flavor: number, buffer: Uint8Array) => number | Promise<number>;

interface EvalPerfTestSeams {
  runPerfSuite?: (db: Database, opts: unknown) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  provenanceReaders?: EvalPerfProvenanceReaders;
  platform?: NodeJS.Platform;
  readFile?: (path: string) => Promise<string>;
  procPidRusage?: ProcPidRusage;
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

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value: unknown = record[key];
  if (!isPlainRecord(value)) throw new Error(`expected opts.${key} to be a record`);
  return value;
}

function readerReasonsOf(opts: Record<string, unknown>): Record<string, unknown> {
  return recordField(opts, "readerReasons");
}

function inputUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function engineFetchWith(
  servedIds: readonly string[],
  other: (url: string) => Promise<Response>,
): typeof fetch {
  const fetchImpl = (input: string | URL | Request): Promise<Response> => {
    const url = inputUrl(input);
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

function workingEngineFetch(): typeof fetch {
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = inputUrl(input);
    if (url.endsWith("/v1/models")) {
      return Promise.resolve(
        Response.json({
          object: "list",
          data: [{ id: "m", object: "model", meta: { n_ctx_train: 40960 } }],
        }),
      );
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
  };
  return fetchImpl as typeof fetch;
}

function writeRusage(buffer: Uint8Array, readBytes: bigint, writeBytes: bigint): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  view.setBigUint64(144, readBytes, true);
  view.setBigUint64(152, writeBytes, true);
}

function perfArgv(dbPath: string, args: readonly string[]): string[] {
  return ["perf", "--db", dbPath, "--suite", "perf-quick", "--run-id", "r1", ...args];
}

let tmp = "";
let previousDevStorage: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-eval-perf-darwin-io-"));
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

describe("#521 eval perf darwin SSD I/O", () => {
  test("C1 hostReaders forwards procPidRusage and clears only the io reason", async () => {
    // Kills: hostReaders not forwarding seams.procPidRusage.
    const run = fakeRunPerfSuite();
    const rusageCalls: { pid: number; flavor: number; byteLength: number }[] = [];
    perfSeams()({
      platform: "darwin",
      procPidRusage: (pid, flavor, buffer) => {
        rusageCalls.push({ pid, flavor, byteLength: buffer.byteLength });
        writeRusage(buffer, 12288n, 8192n);
        return 0;
      },
      runPerfSuite: run.runPerfSuite,
      fetchImpl: fakeEngineFetch(["m"]),
      probeGtt: () => Promise.resolve(GTT_OK),
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
    const io = readerFn(opts, "io");
    expect(typeof io).toBe("function");
    expect(await io!()).toEqual({ readBytes: 12288, writeBytes: 8192 });
    expect(rusageCalls).toHaveLength(1);
    expect(rusageCalls[0]?.pid).toBe(4242);
    expect(rusageCalls[0]?.flavor).toBe(2);
    expect(rusageCalls[0]?.byteLength).toBeGreaterThanOrEqual(160);
    const reasons = readerReasonsOf(opts);
    expect(reasons["io"]).toBeUndefined();
    expect(reasons["gtt"]).toBe(
      "GTT counters (/sys/class/drm/card*/device/mem_info_gtt_used) are Linux-only; no GTT reader on darwin",
    );
  });

  test("C2 the real runPerfSuite stores increasing proc_pid_rusage deltas", async () => {
    // Kills: the reader not reaching the suite, or a reversed diff order.
    let rusageCalls = 0;
    perfSeams()({
      platform: "darwin",
      procPidRusage: (_pid, _flavor, buffer) => {
        const first = rusageCalls === 0;
        rusageCalls += 1;
        writeRusage(buffer, first ? 1000n : 5000n, first ? 10n : 30n);
        return 0;
      },
      fetchImpl: workingEngineFetch(),
      provenanceReaders: {
        sha256File: () => "ab".repeat(32),
        engineVersion: () => ({ version: "b9000", commit: "abc1234" }),
        hostname: () => "h1",
      },
      probeGtt: () => Promise.resolve(GTT_OK),
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
    expect(stdout).toContain("| ssd_read_bytes | ok |");
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = listPerfRuns(db, { run_id: "r1" });
      const byName = new Map(rows.map((row) => [row.metric_name, row.metric]));
      expect(byName.get("ssd_read_bytes")).toEqual({ status: "ok", value: 4000 });
      expect(byName.get("ssd_write_bytes")).toEqual({ status: "ok", value: 20 });
    } finally {
      db.close();
    }
  });
});
