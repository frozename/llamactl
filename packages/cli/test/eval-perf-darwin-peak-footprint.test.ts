// RED pins for #521: `llamactl eval perf` stores macOS peak RSS from the
// proc_pid_rusage RUSAGE_INFO_V4 lifetime maximum, and a failed rusage call
// stays unavailable instead of becoming zero.

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

const LOOPBACK_URL = "http://127.0.0.1:18080";

function perfSeams(): (seams: EvalPerfTestSeams) => void {
  const setSeams = Reflect.get(evalCmd, "__setEvalPerfTestSeams") as unknown;
  expect(typeof setSeams).toBe("function");
  return setSeams as (seams: EvalPerfTestSeams) => void;
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

interface RusageCall {
  pid: number;
  flavor: number;
  byteLength: number;
}

function createRusageFake(flavor4Rc = 0): {
  procPidRusage: ProcPidRusage;
  calls: RusageCall[];
} {
  const calls: RusageCall[] = [];
  const procPidRusage: ProcPidRusage = (pid, flavor, buffer) => {
    calls.push({ pid, flavor, byteLength: buffer.byteLength });
    const view = new DataView(buffer.buffer, buffer.byteOffset);
    if (flavor === 4 && buffer.byteLength >= 296) {
      view.setBigUint64(72, 111n, true);
      view.setBigUint64(240, 3221225472n, true);
      view.setBigUint64(280, 999n, true);
      return flavor4Rc;
    }
    if (flavor === 2) {
      view.setBigUint64(144, 12288n, true);
      view.setBigUint64(152, 8192n, true);
      return 0;
    }
    return -1;
  };
  return { procPidRusage, calls };
}

function perfArgv(dbPath: string, args: readonly string[]): string[] {
  return ["perf", "--db", dbPath, "--suite", "perf-quick", "--run-id", "r1", ...args];
}

function installPerfSeams(procPidRusage: ProcPidRusage): void {
  perfSeams()({
    platform: "darwin",
    procPidRusage,
    fetchImpl: workingEngineFetch(),
    provenanceReaders: {
      sha256File: () => "ab".repeat(32),
      engineVersion: () => ({ version: "b9000", commit: "abc1234" }),
      hostname: () => "h1",
    },
    clock: { now: () => 0 },
  });
}

async function runPerf(dbPath: string): Promise<{ result: number; stdout: string }> {
  return await captureProcessStreams(() =>
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
}

let tmp = "";
let previousDevStorage: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-eval-perf-darwin-peak-"));
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

describe("#521 eval perf darwin peak RSS", () => {
  test("C1 the real runPerfSuite records the V4 lifetime maximum footprint", async () => {
    // Kills: createPerfHostReaders building no darwin peakRss reader.
    const fake = createRusageFake();
    installPerfSeams(fake.procPidRusage);
    const dbPath = join(tmp, "perf.sqlite");

    const { result, stdout } = await runPerf(dbPath);

    expect(result).toBe(0);
    expect(stdout).toContain("| peak_rss_bytes | ok | 3221225472 |");
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = listPerfRuns(db, { run_id: "r1" });
      const byName = new Map(rows.map((row) => [row.metric_name, row.metric]));
      expect(byName.get("peak_rss_bytes")).toEqual({ status: "ok", value: 3221225472 });
    } finally {
      db.close();
    }
    expect(fake.calls).toContainEqual({ pid: 4242, flavor: 4, byteLength: 296 });
  });

  test("C2 a failed V4 rusage call records the no-sample reason", async () => {
    // Kills: coercing a failed rusage call to 0.
    const fake = createRusageFake(-1);
    installPerfSeams(fake.procPidRusage);
    const dbPath = join(tmp, "perf.sqlite");

    const { result, stdout } = await runPerf(dbPath);

    expect(result).toBe(0);
    expect(stdout).toContain("peak-RSS (VmHWM) reader returned no sample");
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = listPerfRuns(db, { run_id: "r1" });
      const byName = new Map(rows.map((row) => [row.metric_name, row.metric]));
      expect(byName.get("peak_rss_bytes")).toEqual({
        status: "unavailable",
        value: null,
        reason: "peak-RSS (VmHWM) reader returned no sample",
      });
    } finally {
      db.close();
    }
    expect(fake.calls).toContainEqual({ pid: 4242, flavor: 4, byteLength: 296 });
  });
});
