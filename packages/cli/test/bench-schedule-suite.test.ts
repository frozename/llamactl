import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  __resetBenchScheduleTestSeams,
  __setBenchScheduleTestSeams,
  createPerfBenchSuiteRunner,
  runBenchSchedule,
} from "../src/commands/bench-schedule.js";
import { resetGlobals } from "../src/dispatcher.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { captureProcessStreams, isPlainRecord } from "./helpers.js";

/**
 * RED pins for #521 (F-3 follow-up): with no `caller` seam,
 * `runBenchSchedule` must build the router caller with a
 * `benchSuiteRunner` that resolves the suite id, endpoint and eval DB
 * CLI-side (remote never imports eval), then runs `runPerfSuite`.
 * `__setBenchScheduleTestSeams({ perfSuite })` narrows each seam so the
 * tests stay hermetic — fake engine fetches, temp dirs, no processes.
 * At base the router ignores the context, so every suite kick records
 * "no suite runner configured" and the dispatch assertions fail.
 */

type RunPerfSuiteSeam = (db: Database, opts: unknown) => Promise<unknown[]>;

type ResolveEndpointSeam = (node: string) => {
  baseUrl: string;
  fetchImpl?: typeof fetch;
};

interface PerfSuiteSeamBag {
  runPerfSuite?: RunPerfSuiteSeam;
  resolveEndpoint?: ResolveEndpointSeam;
  openDb?: () => Database;
}

interface FakeLoopStatus {
  running: boolean;
  tickIntervalMs: number;
  lastTickAt: string | null;
  nextTickAt: string | null;
  inflight: boolean;
  recent: unknown[];
}

interface FakeScheduleRow {
  id: string;
  node: string;
  rel: string;
  mode: string;
  intervalSeconds: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastError: string | null;
}

interface FakeScheduleCaller {
  benchScheduleList: () => Promise<FakeScheduleRow[]>;
  benchScheduleAdd: (input: unknown) => Promise<FakeScheduleRow[]>;
  benchScheduleRemove: (input: unknown) => Promise<FakeScheduleRow[]>;
  benchScheduleToggle: (input: unknown) => Promise<FakeScheduleRow[]>;
  benchSchedulerStatus: () => Promise<FakeLoopStatus>;
  benchSchedulerStart: (input?: unknown) => Promise<FakeLoopStatus>;
  benchSchedulerStop: () => Promise<FakeLoopStatus>;
  benchSchedulerKick: () => Promise<FakeLoopStatus>;
}

function setSeams(seams: {
  caller?: FakeScheduleCaller;
  perfSuite?: PerfSuiteSeamBag;
  waitForShutdown?: () => Promise<NodeJS.Signals>;
  sleep?: (ms: number) => Promise<void>;
}): void {
  __setBenchScheduleTestSeams(seams as Parameters<typeof __setBenchScheduleTestSeams>[0]);
}

interface RunCall {
  db: Database;
  opts: unknown;
}

function fakeRunPerfSuite(onRun?: (db: Database, opts: unknown) => void | Promise<void>): {
  runPerfSuite: RunPerfSuiteSeam;
  calls: RunCall[];
} {
  const calls: RunCall[] = [];
  const runPerfSuite: RunPerfSuiteSeam = async (db, opts) => {
    calls.push({ db, opts });
    await onRun?.(db, opts);
    return [];
  };
  return { runPerfSuite, calls };
}

function fakeEndpoint(
  baseUrl: string,
  servedId = "org/repo/m.gguf",
): {
  resolveEndpoint: ResolveEndpointSeam;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = ((input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/v1/models")) {
      return Promise.resolve(Response.json({ object: "list", data: [{ id: servedId }] }));
    }
    return Promise.reject(new Error(`unexpected engine request: ${url}`));
  }) as typeof fetch;
  const resolveEndpoint: ResolveEndpointSeam = (node) => {
    calls.push(node);
    return { baseUrl, fetchImpl };
  };
  return { resolveEndpoint, calls };
}

function fakeScheduleCaller(rows: FakeScheduleRow[]): {
  caller: FakeScheduleCaller;
  calls: { list: number };
} {
  const calls = { list: 0 };
  const status: FakeLoopStatus = {
    running: false,
    tickIntervalMs: 60_000,
    lastTickAt: null,
    nextTickAt: null,
    inflight: false,
    recent: [],
  };
  const caller: FakeScheduleCaller = {
    benchScheduleList: () => {
      calls.list += 1;
      return Promise.resolve(rows);
    },
    benchScheduleAdd: () => Promise.resolve(rows),
    benchScheduleRemove: () => Promise.resolve([]),
    benchScheduleToggle: () => Promise.resolve(rows),
    benchSchedulerStatus: () => Promise.resolve(status),
    benchSchedulerStart: () => Promise.resolve(status),
    benchSchedulerStop: () => Promise.resolve(status),
    benchSchedulerKick: () => Promise.resolve(status),
  };
  return { caller, calls };
}

let tmp = "";
let schedulePath = "";
let configPath = "";
let previousSchedulesEnv: string | undefined;
let previousConfigEnv: string | undefined;
let previousDevStorageEnv: string | undefined;
const servers: { stop: () => void }[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-bench-suite-"));
  schedulePath = join(tmp, "schedules.yaml");
  configPath = join(tmp, "config");
  previousSchedulesEnv = process.env["LLAMACTL_BENCH_SCHEDULES"];
  previousConfigEnv = process.env["LLAMACTL_CONFIG"];
  previousDevStorageEnv = process.env["DEV_STORAGE"];
  process.env["LLAMACTL_BENCH_SCHEDULES"] = schedulePath;
  process.env["LLAMACTL_CONFIG"] = configPath;
  process.env["DEV_STORAGE"] = tmp;
  resetGlobals();
});

afterEach(() => {
  __resetBenchScheduleTestSeams();
  resetGlobals();
  restoreEnv("LLAMACTL_BENCH_SCHEDULES", previousSchedulesEnv);
  restoreEnv("LLAMACTL_CONFIG", previousConfigEnv);
  restoreEnv("DEV_STORAGE", previousDevStorageEnv);
  for (const server of servers.splice(0)) server.stop();
  rmSync(tmp, { recursive: true, force: true });
});

function restoreEnv(key: string, prior: string | undefined): void {
  if (prior === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = prior;
}

function writeStore(opts: { node?: string; suite?: string; slots?: number } = {}): void {
  const node = opts.node ?? "fake-node";
  const suite = opts.suite ?? "perf-quick";
  const slotsLine = opts.slots === undefined ? "" : `    slots: ${String(opts.slots)}\n`;
  writeFileSync(
    schedulePath,
    `schedules:
  - id: router-suite
    node: ${node}
    rel: org/repo/m.gguf
    mode: auto
    intervalSeconds: 86400
    enabled: true
    lastRunAt: "2000-01-01T00:00:00.000Z"
    lastError: null
    kind: suite
    suite: ${suite}
${slotsLine}`,
    "utf8",
  );
}

function writeConfig(port: number): void {
  writeFileSync(
    configPath,
    `apiVersion: llamactl/v1
kind: Config
currentContext: home
contexts:
  - {name: home, cluster: lab, user: op, defaultNode: http-node}
clusters:
  - name: lab
    nodes:
      - {name: http-node, endpoint: "http://127.0.0.1:${String(port)}"}
      - {name: inproc-node, endpoint: "inproc://local"}
users:
  - {name: op, token: suite-token}
`,
    "utf8",
  );
}

function storedLastError(id: string): string | null {
  const parsed = parseYaml(readFileSync(schedulePath, "utf8")) as unknown;
  const doc = isPlainRecord(parsed) ? parsed : {};
  const schedules: unknown = doc["schedules"];
  const rows = Array.isArray(schedules) ? (schedules as unknown[]) : [];
  const row = rows.find((s) => isPlainRecord(s) && s["id"] === id);
  if (!isPlainRecord(row)) return null;
  const err: unknown = row["lastError"];
  return typeof err === "string" ? err : null;
}

function storedRel(id: string): string | null {
  const parsed = parseYaml(readFileSync(schedulePath, "utf8")) as unknown;
  const doc = isPlainRecord(parsed) ? parsed : {};
  const schedules: unknown = doc["schedules"];
  const rows = Array.isArray(schedules) ? (schedules as unknown[]) : [];
  const row = rows.find((s) => isPlainRecord(s) && s["id"] === id);
  if (!isPlainRecord(row)) return null;
  const rel: unknown = row["rel"];
  return typeof rel === "string" ? rel : null;
}

function runOpts(call: RunCall | undefined): Record<string, unknown> {
  if (call === undefined) throw new Error("expected a recorded runPerfSuite call");
  if (!isPlainRecord(call.opts)) throw new Error("expected runPerfSuite opts to be a record");
  return call.opts;
}

describe("bench schedule suite dispatch (CLI-side runner)", () => {
  test("kick resolves the suite, endpoint and db, then runs runPerfSuite", async () => {
    writeStore();
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    const run = fakeRunPerfSuite();
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        resolveEndpoint: endpoint.resolveEndpoint,
        openDb: () => new Database(":memory:"),
      },
    });

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(0);
    expect(endpoint.calls).toEqual(["fake-node"]);
    expect(run.calls).toHaveLength(1);
    const opts = runOpts(run.calls[0]);
    expect(opts["model_name"]).toBe("org/repo/m.gguf");
    expect(opts["decodeTokens"]).toBe(16);
    expect(opts["concurrencyPromptWords"]).toBe(128);
    expect(typeof opts["run_id"]).toBe("string");
    expect((opts["run_id"] as string).startsWith("router-suite-")).toBe(true);
    const client = opts["client"];
    const clock = opts["clock"];
    const provenance = opts["provenance"];
    if (!isPlainRecord(client) || !isPlainRecord(clock) || !isPlainRecord(provenance)) {
      throw new Error("expected client, clock and provenance records on runPerfSuite opts");
    }
    expect(typeof client["streamChat"]).toBe("function");
    expect(typeof clock["now"]).toBe("function");
    expect(provenance["engine"]).toBe("llamacpp");
    expect(storedLastError("router-suite")).toBeNull();
  });

  test("kick passes gateway reader reasons naming the node for io, peak RSS and GTT", async () => {
    // Kills: createPerfBenchSuiteRunner dropping readerReasons, or
    //        injecting the CLI host's own readers for a remote engine.
    writeStore();
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    const run = fakeRunPerfSuite();
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        resolveEndpoint: endpoint.resolveEndpoint,
        openDb: () => new Database(":memory:"),
      },
    });

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const opts = runOpts(run.calls[0]);
    const readerReasons: unknown = opts["readerReasons"];
    expect(isPlainRecord(readerReasons)).toBe(true);
    if (!isPlainRecord(readerReasons)) {
      throw new Error("expected runPerfSuite opts.readerReasons to be a record");
    }
    for (const key of ["io", "peakRss", "gtt"] as const) {
      const reason: unknown = readerReasons[key];
      expect(typeof reason).toBe("string");
      const text = typeof reason === "string" ? reason : "";
      expect(text.trim()).not.toBe("");
      expect(text).toContain("node 'fake-node'");
      expect(text).toContain("org/repo/m.gguf");
      expect(text).toMatch(/agent gateway/i);
    }
    expect(opts["readers"]).toBeUndefined();
  });

  test("kick records provenance fields it cannot determine as unavailable with reasons, not guesses", async () => {
    writeStore();
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    const run = fakeRunPerfSuite();
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        resolveEndpoint: endpoint.resolveEndpoint,
        openDb: () => new Database(":memory:"),
      },
    });

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const provenance = runOpts(run.calls[0])["provenance"];
    if (!isPlainRecord(provenance)) throw new Error("expected a provenance record");
    const FIELDS = [
      "engine_version",
      "engine_commit",
      "binary_sha256",
      "gguf_sha256",
      "hf_revision",
      "quant",
      "ctx",
    ] as const;
    expect(provenance["quant"]).toBeNull();
    for (const field of FIELDS) {
      expect(provenance[field]).toBeNull();
    }
    const unavailable = provenance["unavailable"];
    if (!isPlainRecord(unavailable)) {
      throw new Error("expected provenance.unavailable to be a record");
    }
    for (const field of FIELDS) {
      const reason: unknown = unavailable[field];
      expect(typeof reason).toBe("string");
      expect(typeof reason === "string" ? reason.trim() : "").not.toBe("");
      // The reason names the schedule's model, not a literal placeholder.
      expect(reason).toContain("org/repo/m.gguf");
      expect(reason).not.toContain("<rel>");
    }
    expect(unavailable["binary_sha256"]).toMatch(/agent/i);
    expect(provenance["host"]).toBe(hostname());
  });

  test("run dispatches due suite schedules on timer ticks", async () => {
    writeStore();
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    const run = fakeRunPerfSuite();
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        resolveEndpoint: endpoint.resolveEndpoint,
        openDb: () => new Database(":memory:"),
      },
      sleep: () => Promise.resolve(),
      waitForShutdown: async () => {
        const deadline = Date.now() + 2_000;
        while (run.calls.length === 0 && Date.now() < deadline) {
          await Bun.sleep(5);
        }
        return "SIGTERM";
      },
    });

    const { result } = await captureProcessStreams(() =>
      runBenchSchedule(["run", "--interval=30"]),
    );

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(runOpts(run.calls[0])["decodeTokens"]).toBe(16);
    expect(storedLastError("router-suite")).toBeNull();
  });

  test("kick records an unknown-suite rejection in lastError", async () => {
    writeStore({ suite: "perf-bogus" });
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    const run = fakeRunPerfSuite();
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        resolveEndpoint: endpoint.resolveEndpoint,
        openDb: () => new Database(":memory:"),
      },
    });

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(1);
    expect(run.calls).toHaveLength(0);
    expect(endpoint.calls).toHaveLength(0);
    expect(storedLastError("router-suite")).toContain("unknown perf suite 'perf-bogus'");
  });

  test("kick refuses when the node is not serving the scheduled model", async () => {
    writeStore();
    const endpoint = fakeEndpoint("http://fake-engine.invalid", "other/model.gguf");
    const run = fakeRunPerfSuite();
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        resolveEndpoint: endpoint.resolveEndpoint,
        openDb: () => new Database(":memory:"),
      },
    });

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(1);
    expect(run.calls).toHaveLength(0);
    expect(storedLastError("router-suite")).toContain("not serving 'org/repo/m.gguf'");
  });

  test("kick resolves the default endpoint over HTTP with the user bearer", async () => {
    const requests: {
      method: string;
      pathname: string;
      authorization: string | null;
      contentType: string | null;
    }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        requests.push({
          method: req.method,
          pathname: url.pathname,
          authorization: req.headers.get("authorization"),
          contentType: req.headers.get("content-type"),
        });
        if (req.method === "GET" && url.pathname === "/v1/models") {
          return Response.json({ object: "list", data: [{ id: "org/repo/m.gguf" }] });
        }
        if (req.method === "POST" && url.pathname === "/tokenize") {
          return Response.json({ tokens: [{ id: 1, piece: "x" }] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);
    const port = server.port;
    if (port === undefined) throw new Error("Bun.serve did not bind a TCP port");
    writeConfig(port);
    writeStore({ node: "http-node" });
    const run = fakeRunPerfSuite(async (_db, opts) => {
      const record = opts;
      if (!isPlainRecord(record)) throw new Error("expected runPerfSuite opts record");
      const client = record["client"];
      if (!isPlainRecord(client) || typeof client["tokenize"] !== "function") {
        throw new Error("expected a perf engine client with tokenize");
      }
      const tokenize = client["tokenize"] as (content: string) => Promise<unknown>;
      await tokenize.call(client, "x");
    });
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        openDb: () => new Database(":memory:"),
      },
    });

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(0);
    const modelsReq = requests.find((r) => r.method === "GET" && r.pathname === "/v1/models");
    const tokenizeReq = requests.find((r) => r.method === "POST" && r.pathname === "/tokenize");
    expect(modelsReq?.authorization).toBe("Bearer suite-token");
    expect(tokenizeReq?.authorization).toBe("Bearer suite-token");
    expect(tokenizeReq?.contentType).toBe("application/json");
  });

  test("kick refuses in-process nodes for suite schedules", async () => {
    writeConfig(9);
    writeStore({ node: "inproc-node" });
    const run = fakeRunPerfSuite();
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        openDb: () => new Database(":memory:"),
      },
    });

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(1);
    expect(run.calls).toHaveLength(0);
    expect(storedLastError("router-suite")).toContain("is in-process");
  });

  test("kick defaults the perf store to DEV_STORAGE/eval/perf.sqlite", async () => {
    writeStore();
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    let dbSelectOk = false;
    const run = fakeRunPerfSuite((db) => {
      dbSelectOk = Boolean(db.query("select 1 as x").get());
    });
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        resolveEndpoint: endpoint.resolveEndpoint,
      },
    });

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(0);
    expect(dbSelectOk).toBe(true);
    expect(existsSync(join(tmp, "eval", "perf.sqlite"))).toBe(true);
  });

  test("guard: the caller seam still serves list without perf-suite wiring", async () => {
    const row: FakeScheduleRow = {
      id: "router-suite",
      node: "fake-node",
      rel: "org/repo/m.gguf",
      mode: "auto",
      intervalSeconds: 86_400,
      enabled: true,
      lastRunAt: null,
      lastError: null,
    };
    const { caller, calls } = fakeScheduleCaller([row]);
    setSeams({ caller });

    const { result, stdout } = await captureProcessStreams(() => runBenchSchedule(["list"]));

    expect(result).toBe(0);
    expect(calls.list).toBe(1);
    expect(stdout).toContain("router-suite");
  });
});

describe("#521 scheduled suite engine", () => {
  function writeEngineStore(engine: string | undefined): void {
    const engineLine = engine === undefined ? "" : `    engine: ${engine}\n`;
    writeFileSync(
      schedulePath,
      `schedules:
  - id: router-suite
    node: fake-node
    rel: org/repo/m.gguf
    mode: auto
    intervalSeconds: 86400
    enabled: true
    lastRunAt: "2000-01-01T00:00:00.000Z"
    lastError: null
    kind: suite
    suite: perf-quick
${engineLine}`,
      "utf8",
    );
  }

  function perfSeams(run: ReturnType<typeof fakeRunPerfSuite>): void {
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        resolveEndpoint: endpoint.resolveEndpoint,
        openDb: () => new Database(":memory:"),
      },
    });
  }

  test("kick forwards the schedule engine into provenance.engine", async () => {
    // Kills: the hard-coded engine: "llamacpp" in createPerfBenchSuiteRunner.
    writeEngineStore("kapitsa");
    const run = fakeRunPerfSuite();
    perfSeams(run);

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const provenance = runOpts(run.calls[0])["provenance"];
    if (!isPlainRecord(provenance)) throw new Error("expected a provenance record");
    expect(provenance["engine"]).toBe("kapitsa");
    expect(storedLastError("router-suite")).toBeNull();
  });

  test("a legacy suite schedule without engine still records llamacpp", async () => {
    // Back-compat pin: absent engine means llamacpp, the pre-#521 default.
    writeStore();
    const run = fakeRunPerfSuite();
    perfSeams(run);

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const provenance = runOpts(run.calls[0])["provenance"];
    if (!isPlainRecord(provenance)) throw new Error("expected a provenance record");
    expect(provenance["engine"]).toBe("llamacpp");
  });

  test("the runner rejects an engine outside EVAL_ENGINES before any endpoint work", async () => {
    // Kills: casting req.engine to EvalEngine without validating it.
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    const run = fakeRunPerfSuite();
    const runner = createPerfBenchSuiteRunner({
      runPerfSuite: run.runPerfSuite,
      resolveEndpoint: endpoint.resolveEndpoint,
      openDb: () => new Database(":memory:"),
    });
    const req = {
      scheduleId: "x",
      suite: "perf-quick",
      node: "n",
      rel: "org/repo/m.gguf",
      engine: "vllm",
    } as Parameters<ReturnType<typeof createPerfBenchSuiteRunner>>[0];

    let message = "";
    try {
      await runner(req);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("unknown engine 'vllm' for schedule 'x'");
    expect(endpoint.calls).toEqual([]);
    expect(run.calls).toEqual([]);
  });
});

describe("#521 scheduled suite slots", () => {
  test("kick passes a slotsReason naming the schedule rel, node, agent gateway and /props", async () => {
    // Kills: createPerfBenchSuiteRunner dropping slotsReason, or a
    //        literal '<rel>' placeholder reaching the metric reason.
    writeStore();
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    const run = fakeRunPerfSuite();
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        resolveEndpoint: endpoint.resolveEndpoint,
        openDb: () => new Database(":memory:"),
      },
    });

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const reason: unknown = runOpts(run.calls[0])["slotsReason"];
    expect(typeof reason).toBe("string");
    if (typeof reason !== "string") throw new Error("expected slotsReason to be a string");
    expect(reason).toContain("org/repo/m.gguf");
    expect(reason).toContain("node 'fake-node'");
    expect(reason).toContain("agent gateway");
    expect(reason).toContain("/props");
    expect(reason).not.toContain("<rel>");
  });

  test("guard: the scheduled path never sets slots without declared slots", async () => {
    writeStore();
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    const run = fakeRunPerfSuite();
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        resolveEndpoint: endpoint.resolveEndpoint,
        openDb: () => new Database(":memory:"),
      },
    });

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(runOpts(run.calls[0])["slots"]).toBeUndefined();
  });
});

describe("#521 scheduled suite load reason", () => {
  test("kick passes a loadReason naming the rel, node and agent gateway (kills: createPerfBenchSuiteRunner dropping loadReason, or a literal '<rel>' placeholder)", async () => {
    writeStore();
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    const run = fakeRunPerfSuite();
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        resolveEndpoint: endpoint.resolveEndpoint,
        openDb: () => new Database(":memory:"),
      },
    });

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const reason: unknown = runOpts(run.calls[0])["loadReason"];
    expect(typeof reason).toBe("string");
    if (typeof reason !== "string") throw new Error("expected loadReason to be a string");
    expect(reason).toContain("org/repo/m.gguf");
    expect(reason).toContain("node 'fake-node'");
    expect(reason).toContain("agent gateway");
    expect(reason).not.toContain("<rel>");
  });

  test("guard: the scheduled path never sets load hooks", async () => {
    writeStore();
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    const run = fakeRunPerfSuite();
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        resolveEndpoint: endpoint.resolveEndpoint,
        openDb: () => new Database(":memory:"),
      },
    });

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(runOpts(run.calls[0])["load"]).toBeUndefined();
  });
});

describe("#521 scheduled suite prefill reason", () => {
  test("kick passes a prefillReason naming the rel, node, agent gateway and /tokenize", async () => {
    // Kills: createPerfBenchSuiteRunner dropping prefillReason, passing a
    //        literal placeholder, or changing the text.
    writeStore();
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    const run = fakeRunPerfSuite();
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        resolveEndpoint: endpoint.resolveEndpoint,
        openDb: () => new Database(":memory:"),
      },
    });

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const reason: unknown = runOpts(run.calls[0])["prefillReason"];
    expect(reason).toBe(
      "prefill for org/repo/m.gguf on node 'fake-node' is not measured; scheduled suites reach the engine through the agent gateway, which forwards only /v1/* and not the engine's /tokenize",
    );
    expect(typeof reason).toBe("string");
    if (typeof reason !== "string") throw new Error("expected prefillReason to be a string");
    expect(reason).not.toContain("<rel>");
  });
});

describe("#521 scheduled suite declared slots", () => {
  test("kick passes the declared slots to runPerfSuite without a slotsReason", async () => {
    // Kills: createPerfBenchSuiteRunner ignoring req.slots, or still sending
    //        the gateway reason when slots is known.
    writeStore({ slots: 4 });
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    const run = fakeRunPerfSuite();
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        resolveEndpoint: endpoint.resolveEndpoint,
        openDb: () => new Database(":memory:"),
      },
    });

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const opts = runOpts(run.calls[0]);
    expect(opts["slots"]).toBe(4);
    expect(opts["slotsReason"]).toBeUndefined();
  });

  test("the runner rejects invalid slots before any endpoint work", async () => {
    // Kills: passing req.slots through unvalidated.
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    const run = fakeRunPerfSuite();
    const runner = createPerfBenchSuiteRunner({
      runPerfSuite: run.runPerfSuite,
      resolveEndpoint: endpoint.resolveEndpoint,
      openDb: () => new Database(":memory:"),
    });
    const req = {
      scheduleId: "x",
      suite: "perf-quick",
      node: "n",
      rel: "org/repo/m.gguf",
      slots: 0,
    } as Parameters<ReturnType<typeof createPerfBenchSuiteRunner>>[0];

    let message = "";
    try {
      await runner(req);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("invalid slots 0 for schedule 'x'");
    expect(endpoint.calls).toEqual([]);
    expect(run.calls).toEqual([]);
  });
});

describe("#521 scheduled suite declared provenance", () => {
  function writeDeclaredStore(declared: { quant?: string; ctx?: number } = {}): void {
    const quantLine = declared.quant === undefined ? "" : `    quant: ${declared.quant}\n`;
    const ctxLine = declared.ctx === undefined ? "" : `    ctx: ${String(declared.ctx)}\n`;
    writeFileSync(
      schedulePath,
      `schedules:
  - id: router-suite
    node: fake-node
    rel: org/repo/m.gguf
    mode: auto
    intervalSeconds: 86400
    enabled: true
    lastRunAt: "2000-01-01T00:00:00.000Z"
    lastError: null
    kind: suite
    suite: perf-quick
${quantLine}${ctxLine}`,
      "utf8",
    );
  }

  function provenanceSeams(run: ReturnType<typeof fakeRunPerfSuite>): {
    endpoint: ReturnType<typeof fakeEndpoint>;
  } {
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        resolveEndpoint: endpoint.resolveEndpoint,
        openDb: () => new Database(":memory:"),
      },
    });
    return { endpoint };
  }

  test("kick records declared quant and ctx in provenance and passes ctx to the suite", async () => {
    // Kills: the hard-coded `quant: null` / `ctx: null` provenance inputs,
    //        and ctx not reaching runPerfSuite opts.
    writeDeclaredStore({ quant: "Q4_K_M", ctx: 32768 });
    const run = fakeRunPerfSuite();
    provenanceSeams(run);

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const opts = runOpts(run.calls[0]);
    const provenance = opts["provenance"];
    if (!isPlainRecord(provenance)) throw new Error("expected a provenance record");
    expect(provenance["quant"]).toBe("Q4_K_M");
    expect(provenance["ctx"]).toBe(32768);
    const unavailable = provenance["unavailable"];
    if (!isPlainRecord(unavailable)) {
      throw new Error("expected provenance.unavailable to be a record");
    }
    expect("quant" in unavailable).toBe(false);
    expect("ctx" in unavailable).toBe(false);
    for (const field of ["binary_sha256", "gguf_sha256"] as const) {
      const reason: unknown = unavailable[field];
      expect(typeof reason).toBe("string");
      expect(reason).toContain("org/repo/m.gguf");
      expect(reason).toContain("agent gateway");
    }
    expect(opts["ctx"]).toBe(32768);
  });

  test("a declared ctx still passes the prefillReason", async () => {
    // Kills: gating prefillReason on ctx being undeclared.
    writeDeclaredStore({ quant: "Q4_K_M", ctx: 32768 });
    const run = fakeRunPerfSuite();
    provenanceSeams(run);

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const opts = runOpts(run.calls[0]);
    expect(opts["ctx"]).toBe(32768);
    const reason: unknown = opts["prefillReason"];
    expect(typeof reason).toBe("string");
    if (typeof reason !== "string") throw new Error("expected prefillReason to be a string");
    expect(reason).toContain("/tokenize");
  });

  test("the runner rejects a non-positive ctx before any endpoint work", async () => {
    // Kills: the runner passing an unvalidated ctx into provenance/opts.
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    const run = fakeRunPerfSuite();
    const runner = createPerfBenchSuiteRunner({
      runPerfSuite: run.runPerfSuite,
      resolveEndpoint: endpoint.resolveEndpoint,
      openDb: () => new Database(":memory:"),
    });
    const req = {
      scheduleId: "x",
      suite: "perf-quick",
      node: "n",
      rel: "org/repo/m.gguf",
      ctx: 0,
    } as Parameters<ReturnType<typeof createPerfBenchSuiteRunner>>[0];

    let message = "";
    try {
      await runner(req);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("invalid ctx 0 for schedule 'x' (expected a positive integer)");
    expect(endpoint.calls).toEqual([]);
    expect(run.calls).toEqual([]);
  });

  test("the runner rejects a blank quant before any endpoint work", async () => {
    // Kills: the runner passing an unvalidated quant into provenance.
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    const run = fakeRunPerfSuite();
    const runner = createPerfBenchSuiteRunner({
      runPerfSuite: run.runPerfSuite,
      resolveEndpoint: endpoint.resolveEndpoint,
      openDb: () => new Database(":memory:"),
    });
    const req = {
      scheduleId: "x",
      suite: "perf-quick",
      node: "n",
      rel: "org/repo/m.gguf",
      quant: "  ",
    } as Parameters<ReturnType<typeof createPerfBenchSuiteRunner>>[0];

    let message = "";
    try {
      await runner(req);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain(
      "invalid quant '  ' for schedule 'x' (expected a non-blank quant label)",
    );
    expect(endpoint.calls).toEqual([]);
    expect(run.calls).toEqual([]);
  });

  test("guard: undeclared quant/ctx keep the gateway reasons and send no ctx opt", async () => {
    writeStore();
    const run = fakeRunPerfSuite();
    provenanceSeams(run);

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const opts = runOpts(run.calls[0]);
    expect("ctx" in opts).toBe(false);
    const provenance = opts["provenance"];
    if (!isPlainRecord(provenance)) throw new Error("expected a provenance record");
    const unavailable = provenance["unavailable"];
    if (!isPlainRecord(unavailable)) {
      throw new Error("expected provenance.unavailable to be a record");
    }
    expect(unavailable["quant"]).toBe(
      "scheduled suites reach org/repo/m.gguf through the agent gateway; the quant label is not known",
    );
    expect(unavailable["ctx"]).toBe(
      "scheduled suites reach org/repo/m.gguf through the agent gateway; the context size is not known",
    );
  });
});

describe("#521 scheduled suite launch flags", () => {
  test("kick records launch flags null with the agent-gateway reason naming the rel", async () => {
    // Kills: the runner's hard-coded `flags: []`.
    writeStore();
    const endpoint = fakeEndpoint("http://fake-engine.invalid");
    const run = fakeRunPerfSuite();
    setSeams({
      perfSuite: {
        runPerfSuite: run.runPerfSuite,
        resolveEndpoint: endpoint.resolveEndpoint,
        openDb: () => new Database(":memory:"),
      },
    });

    const { result } = await captureProcessStreams(() => runBenchSchedule(["kick"]));

    expect(result).toBe(0);
    expect(run.calls).toHaveLength(1);
    const rel = storedRel("router-suite");
    if (rel === null) throw new Error("expected the schedule fixture to store a rel");
    const provenance = runOpts(run.calls[0])["provenance"];
    if (!isPlainRecord(provenance)) throw new Error("expected a provenance record");
    expect(provenance["flags"]).toBeNull();
    const unavailable = provenance["unavailable"];
    if (!isPlainRecord(unavailable)) {
      throw new Error("expected provenance.unavailable to be a record");
    }
    expect(unavailable["flags"]).toBe(
      `scheduled suites reach ${rel} through the agent gateway; the engine launch flags are not known`,
    );
  });
});
