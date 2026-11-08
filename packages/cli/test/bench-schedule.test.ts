import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import * as benchCmd from "../src/commands/bench.js";
import { EMPTY_GLOBALS, getGlobals, resetGlobals, setGlobals } from "../src/dispatcher.js";
import { existsSync, readFileSync } from "../src/safe-fs.js";
import {
  captureProcessStreams,
  CLI_ENTRY,
  isPlainRecord,
  makeTempRuntime,
  parseJsonArray,
  parseJsonRecord,
  requireArrayField,
  requireRecord,
  requireRecordField,
  runCli,
} from "./helpers.js";

/**
 * RED pins for #410 (P7-A precondition b): `llamactl bench schedule`
 * moves the bench scheduler's CRUD + foreground loop off Electron onto
 * the CLI. The tRPC procedures already live in @llamactl/remote; these
 * tests pin the CLI surface — argv parsing, the YAML store round-trip,
 * refusal messages, `run`'s shutdown behavior, and the
 * `__setBenchScheduleTestSeams` / `__resetBenchScheduleTestSeams`
 * hooks the implementation must expose for deterministic tests.
 */

interface ScheduleShape {
  id: string;
  node: string;
  rel: string;
  mode: string;
  intervalSeconds: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  kind?: "preset" | "suite";
  suite?: string;
}

interface RecentEntry {
  ts: string;
  id: string;
  rel: string;
  node: string;
  ok: boolean;
  message?: string;
}

interface LoopStatusShape {
  running: boolean;
  tickIntervalMs: number;
  lastTickAt: string | null;
  nextTickAt: string | null;
  inflight: boolean;
  recent: RecentEntry[];
}

/**
 * The eight router procedures the schedule CLI drives, in the
 * `router.createCaller({})` shape — each property is a plain async
 * function, not a `.query`/`.mutate` leaf.
 */
interface BenchScheduleCaller {
  benchScheduleList: () => Promise<ScheduleShape[]>;
  benchScheduleAdd: (input: {
    id: string;
    node: string;
    rel: string;
    mode?: string;
    intervalSeconds: number;
    kind?: "preset" | "suite";
    suite?: string;
  }) => Promise<ScheduleShape[]>;
  benchScheduleRemove: (input: { id: string }) => Promise<ScheduleShape[]>;
  benchScheduleToggle: (input: { id: string; enabled: boolean }) => Promise<ScheduleShape[]>;
  benchSchedulerStatus: () => Promise<LoopStatusShape>;
  benchSchedulerStart: (input?: { tickIntervalSeconds?: number }) => Promise<LoopStatusShape>;
  benchSchedulerStop: () => Promise<LoopStatusShape>;
  benchSchedulerKick: () => Promise<LoopStatusShape>;
}

interface BenchScheduleSeams {
  caller: BenchScheduleCaller;
  waitForShutdown?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

function recentEntry(id: string, ok = true): RecentEntry {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    id,
    rel: `org/repo/${id}.gguf`,
    node: "gpu1",
    ok,
    ...(ok ? {} : { message: "boom" }),
  };
}

interface CallerCalls {
  list: number;
  add: unknown[];
  remove: unknown[];
  toggle: unknown[];
  status: number;
  start: unknown[];
  stop: number;
  kick: number;
}

function loopStatus(
  opts: {
    running?: boolean;
    inflight?: boolean;
    recent?: RecentEntry[];
    tickIntervalMs?: number;
  } = {},
): LoopStatusShape {
  return {
    running: opts.running ?? false,
    tickIntervalMs: opts.tickIntervalMs ?? 60_000,
    lastTickAt: null,
    nextTickAt: null,
    inflight: opts.inflight ?? false,
    recent: opts.recent ?? [],
  };
}

function installFakeCaller(opts: {
  schedules?: ScheduleShape[];
  status?: () => LoopStatusShape;
  kickResult?: LoopStatusShape;
  kickRejects?: Error;
  startRejects?: Error;
  onKick?: () => void;
}): { caller: BenchScheduleCaller; calls: CallerCalls } {
  const calls: CallerCalls = {
    list: 0,
    add: [],
    remove: [],
    toggle: [],
    status: 0,
    start: [],
    stop: 0,
    kick: 0,
  };
  const statusFn = opts.status ?? ((): LoopStatusShape => loopStatus({}));
  const caller: BenchScheduleCaller = {
    benchScheduleList: () => {
      calls.list += 1;
      return Promise.resolve(opts.schedules ?? []);
    },
    benchScheduleAdd: (input) => {
      calls.add.push(input);
      return Promise.resolve(opts.schedules ?? []);
    },
    benchScheduleRemove: (input) => {
      calls.remove.push(input);
      return Promise.resolve([]);
    },
    benchScheduleToggle: (input) => {
      calls.toggle.push(input);
      return Promise.resolve(opts.schedules ?? []);
    },
    benchSchedulerStatus: () => {
      calls.status += 1;
      return Promise.resolve(statusFn());
    },
    benchSchedulerStart: (input) => {
      calls.start.push(input);
      if (opts.startRejects !== undefined) return Promise.reject(opts.startRejects);
      return Promise.resolve(
        loopStatus({
          running: true,
          tickIntervalMs: (input?.tickIntervalSeconds ?? 60) * 1000,
        }),
      );
    },
    benchSchedulerStop: () => {
      calls.stop += 1;
      return Promise.resolve(loopStatus());
    },
    benchSchedulerKick: () => {
      calls.kick += 1;
      if (opts.kickRejects !== undefined) return Promise.reject(opts.kickRejects);
      opts.onKick?.();
      return Promise.resolve(opts.kickResult ?? loopStatus());
    },
  };
  return { caller, calls };
}

function setBenchScheduleSeams(seams: BenchScheduleSeams): void {
  const fn: unknown = Reflect.get(benchCmd, "__setBenchScheduleTestSeams");
  expect(typeof fn).toBe("function");
  if (typeof fn !== "function") throw new Error("unreachable: seam setter missing");
  (fn as (seams: BenchScheduleSeams) => void)(seams);
}

function resetBenchScheduleSeams(): void {
  const fn: unknown = Reflect.get(benchCmd, "__resetBenchScheduleTestSeams");
  if (typeof fn === "function") (fn as () => void)();
}

describe("llamactl bench schedule — subprocess", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let env: NodeJS.ProcessEnv;
  let schedulePath: string;

  beforeEach(() => {
    temp = makeTempRuntime();
    schedulePath = join(temp.devStorage, "bench-schedules.yaml");
    env = {
      ...temp.env,
      LLAMACTL_BENCH_SCHEDULES: schedulePath,
      LLAMACTL_CONFIG: join(temp.devStorage, "no-kubeconfig"),
    };
  });

  afterEach(() => {
    temp.cleanup();
    resetGlobals();
    resetBenchScheduleSeams();
  });

  function addOk(args: string[]): void {
    const r = runCli(["bench", "schedule", "add", ...args], env);
    expect(r.code).toBe(0);
  }

  function listJson(): unknown[] {
    const r = runCli(["bench", "schedule", "list", "--json"], env);
    expect(r.code).toBe(0);
    return parseJsonArray(r.stdout);
  }

  function scheduleById(rows: unknown[], id: string): Record<string, unknown> {
    const found = rows.filter(isPlainRecord).find((row) => row["id"] === id);
    expect(found).toBeDefined();
    return requireRecord(found);
  }

  test("bench schedule --help prints the schedule usage", () => {
    const r = runCli(["bench", "schedule", "--help"], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("llamactl bench schedule");
    for (const sub of ["list", "add", "rm", "toggle", "run", "kick", "status"]) {
      expect(r.stdout).toContain(sub);
    }
  });

  test("unknown bench schedule subcommand exits 1", () => {
    const r = runCli(["bench", "schedule", "frob"], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unknown bench schedule subcommand: frob");
  });

  test("bench --help mentions schedule", () => {
    const r = runCli(["bench", "--help"], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("schedule");
  });

  test("add + list --json round-trips a schedule", () => {
    const add = runCli(
      [
        "bench",
        "schedule",
        "add",
        "nightly",
        "--node",
        "local",
        "--rel",
        "org/repo/m.gguf",
        "--mode",
        "text",
        "--every",
        "1d",
      ],
      env,
    );
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("added nightly");

    const rows = listJson();
    expect(rows).toHaveLength(1);
    const s = scheduleById(rows, "nightly");
    expect(s["id"]).toBe("nightly");
    expect(s["node"]).toBe("local");
    expect(s["rel"]).toBe("org/repo/m.gguf");
    expect(s["mode"]).toBe("text");
    expect(s["intervalSeconds"]).toBe(86_400);
    expect(s["enabled"]).toBe(true);
    expect(s["lastRunAt"]).toBeNull();
    expect(s["lastError"]).toBeNull();
  });

  test("add with --kind suite + --suite creates a suite schedule", () => {
    const add = runCli(
      [
        "bench",
        "schedule",
        "add",
        "perf-suite",
        "--node",
        "local",
        "--rel",
        "org/repo/m.gguf",
        "--every",
        "1d",
        "--kind",
        "suite",
        "--suite",
        "my-perf-suite",
      ],
      env,
    );
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("added perf-suite");

    const rows = listJson();
    expect(rows).toHaveLength(1);
    const s = scheduleById(rows, "perf-suite");
    expect(s["kind"]).toBe("suite");
    expect(s["suite"]).toBe("my-perf-suite");
  });

  test("add with --kind preset rejects --suite", () => {
    const r = runCli(
      [
        "bench",
        "schedule",
        "add",
        "x",
        "--node",
        "local",
        "--rel",
        "r",
        "--every",
        "1d",
        "--kind",
        "preset",
        "--suite",
        "some-suite",
      ],
      env,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--suite is only valid");
    expect(listJson()).toEqual([]);
  });

  test("add with --kind suite but no --suite is refused", () => {
    const r = runCli(
      [
        "bench",
        "schedule",
        "add",
        "x",
        "--node",
        "local",
        "--rel",
        "r",
        "--every",
        "1d",
        "--kind",
        "suite",
      ],
      env,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--suite is required when kind is 'suite'");
    expect(listJson()).toEqual([]);
  });

  test("add writes the BenchScheduleList YAML store", () => {
    addOk(["nightly", "--node", "local", "--rel", "org/repo/m.gguf", "--every", "1d"]);
    expect(existsSync(schedulePath)).toBe(true);
    expect(readFileSync(schedulePath, "utf8")).toContain("BenchScheduleList");
  });

  test("toggle flips enabled off and on", () => {
    addOk(["nightly", "--node", "local", "--rel", "r", "--every", "1d"]);

    const off = runCli(["bench", "schedule", "toggle", "nightly", "off"], env);
    expect(off.code).toBe(0);
    expect(scheduleById(listJson(), "nightly")["enabled"]).toBe(false);

    const on = runCli(["bench", "schedule", "toggle", "nightly", "on"], env);
    expect(on.code).toBe(0);
    expect(scheduleById(listJson(), "nightly")["enabled"]).toBe(true);
  });

  test("rm removes the schedule", () => {
    addOk(["nightly", "--node", "local", "--rel", "r", "--every", "1d"]);
    const rm = runCli(["bench", "schedule", "rm", "nightly"], env);
    expect(rm.code).toBe(0);
    expect(listJson()).toEqual([]);
  });

  test("list on an empty store prints No bench schedules", () => {
    const r = runCli(["bench", "schedule", "list"], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No bench schedules");
  });

  test("list renders a text table", () => {
    addOk(["nightly", "--node", "local", "--rel", "r", "--every", "1d"]);
    const r = runCli(["bench", "schedule", "list"], env);
    expect(r.code).toBe(0);
    for (const needle of ["nightly", "local", "86400", "enabled"]) {
      expect(r.stdout).toContain(needle);
    }
  });

  test("add accepts --node in every flag position", () => {
    addOk(["a1", "--node=gpu1", "--rel", "r", "--every", "1h"]);
    const prefixed = runCli(
      ["--node", "gpu2", "bench", "schedule", "add", "a2", "--rel", "r", "--every", "1h"],
      env,
    );
    expect(prefixed.code).toBe(0);
    addOk(["a3", "-n", "gpu3", "--rel", "r", "--every", "1h"]);

    const rows = listJson();
    expect(scheduleById(rows, "a1")["node"]).toBe("gpu1");
    expect(scheduleById(rows, "a2")["node"]).toBe("gpu2");
    expect(scheduleById(rows, "a3")["node"]).toBe("gpu3");
  });

  test("add defaults mode to auto and parses durations", () => {
    addOk(["d1", "--node", "local", "--rel", "r", "--every", "3600"]);
    addOk(["d2", "--node", "local", "--rel", "r", "--every=90m"]);
    addOk(["d3", "--node", "local", "--rel", "r", "--every", "2h"]);

    const rows = listJson();
    const d1 = scheduleById(rows, "d1");
    expect(d1["mode"]).toBe("auto");
    expect(d1["intervalSeconds"]).toBe(3600);
    expect(scheduleById(rows, "d2")["intervalSeconds"]).toBe(5400);
    expect(scheduleById(rows, "d3")["intervalSeconds"]).toBe(7200);
  });

  test("add without an id is refused", () => {
    const r = runCli(
      ["bench", "schedule", "add", "--node", "local", "--rel", "r", "--every", "1d"],
      env,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("id is required");
    expect(listJson()).toEqual([]);
  });

  test("add without --node is refused", () => {
    const r = runCli(["bench", "schedule", "add", "x", "--rel", "r", "--every", "1d"], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--node is required");
    expect(listJson()).toEqual([]);
  });

  test("add without --rel is refused", () => {
    const r = runCli(["bench", "schedule", "add", "x", "--node", "local", "--every", "1d"], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--rel is required");
    expect(listJson()).toEqual([]);
  });

  test("add without --every is refused", () => {
    const r = runCli(["bench", "schedule", "add", "x", "--node", "local", "--rel", "r"], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--every is required");
    expect(listJson()).toEqual([]);
  });

  test("add with a bogus --mode is refused", () => {
    const r = runCli(
      [
        "bench",
        "schedule",
        "add",
        "x",
        "--node",
        "local",
        "--rel",
        "r",
        "--every",
        "1d",
        "--mode",
        "bogus",
      ],
      env,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--mode must be one of auto, text, vision");
    expect(listJson()).toEqual([]);
  });

  test("add with an unparseable --every is refused", () => {
    const r = runCli(
      ["bench", "schedule", "add", "x", "--node", "local", "--rel", "r", "--every", "abc"],
      env,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("invalid --every");
    expect(listJson()).toEqual([]);
  });

  test("add with --every below the 60s floor is refused", () => {
    const r = runCli(
      ["bench", "schedule", "add", "x", "--node", "local", "--rel", "r", "--every", "30"],
      env,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("60");
    expect(r.stderr).toContain("Too small");
    expect(r.stderr).not.toContain('"code"');
    expect(listJson()).toEqual([]);
  });

  test("run --help documents the one-bench stop bound", () => {
    const r = runCli(["bench", "schedule", "run", "--help"], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("STOP LATENCY");
    expect(r.stdout).toContain("15 minutes");
  });

  test("add with a duplicate id is refused", () => {
    addOk(["dup", "--node", "local", "--rel", "r", "--every", "1d"]);
    const r = runCli(
      ["bench", "schedule", "add", "dup", "--node", "local", "--rel", "r", "--every", "1d"],
      env,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already exists");
    expect(listJson()).toHaveLength(1);
  });

  test("rm and toggle on an unknown id are refused", () => {
    const rm = runCli(["bench", "schedule", "rm", "ghost"], env);
    expect(rm.code).toBe(1);
    expect(rm.stderr).toContain("no bench schedule with id 'ghost'");

    const tog = runCli(["bench", "schedule", "toggle", "ghost", "on"], env);
    expect(tog.code).toBe(1);
    expect(tog.stderr).toContain("no bench schedule with id 'ghost'");
    expect(listJson()).toEqual([]);
  });

  test("toggle validates the state before looking the id up", () => {
    const r = runCli(["bench", "schedule", "toggle", "nightly", "maybe"], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("toggle: state must be on|off");
    expect(listJson()).toEqual([]);
  });

  test("--node is refused for non-add schedule subcommands", () => {
    const list = runCli(["--node", "other", "bench", "schedule", "list"], env);
    expect(list.code).toBe(1);
    expect(list.stderr).toContain("--node is only accepted by `bench schedule add`");

    const status = runCli(["bench", "schedule", "status", "--node", "other"], env);
    expect(status.code).toBe(1);
    expect(status.stderr).toContain("--node is only accepted by `bench schedule add`");
  });

  test("--context is refused", () => {
    const r = runCli(
      [
        "--context",
        "foo",
        "bench",
        "schedule",
        "add",
        "x",
        "--node",
        "local",
        "--rel",
        "r",
        "--every",
        "1d",
      ],
      env,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--context is not supported");
    expect(listJson()).toEqual([]);
  });

  test("--cluster-config is refused", () => {
    const r = runCli(["--cluster-config", "/tmp/x", "bench", "schedule", "list"], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--cluster-config is not supported");
  });

  test("start and stop point the operator at run", () => {
    for (const sub of ["start", "stop"]) {
      const r = runCli(["bench", "schedule", sub], env);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("bench schedule run");
    }
  });

  test("run --interval is bounded to an integer between 30 and 3600", () => {
    for (const value of ["10", "4000"]) {
      const r = runCli(["bench", "schedule", "run", `--interval=${value}`], env);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--interval must be an integer between 30 and 3600");
    }
  });

  test("run rejects unknown flags", () => {
    const r = runCli(["bench", "schedule", "run", "--bogus"], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unknown flag: --bogus");
  });

  test("run stays in the foreground until SIGTERM, then stops cleanly", async () => {
    const proc = Bun.spawn(["bun", CLI_ENTRY, "bench", "schedule", "run", "--interval=30"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    let buf = "";
    // Widened so control-flow analysis can't narrow the flag to `false`;
    // the only reassignment happens inside the proc.exited callback.
    let exited = false as boolean;
    const exitedPromise = proc.exited.then((code) => {
      exited = true;
      return code;
    });
    const readStderr = (async (): Promise<void> => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      buf += decoder.decode();
    })();
    try {
      const deadline = Date.now() + 10_000;
      while (!buf.includes("bench-scheduler: running") && !exited && Date.now() < deadline) {
        await Bun.sleep(25);
      }
      expect(buf).toContain("bench-scheduler: running");
      proc.kill("SIGTERM");
      expect(await exitedPromise).toBe(0);
      await readStderr;
      expect(buf).toContain("bench-scheduler: stopped");
    } finally {
      if (!exited) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
      await readStderr;
    }
  }, 20_000);
});

describe("llamactl bench schedule — in-process seams", () => {
  afterEach(() => {
    resetGlobals();
    resetBenchScheduleSeams();
  });

  test("run --interval=120 starts, waits for shutdown, drains inflight, stops", async () => {
    const drain = [true, true, false];
    let drainIdx = 0;
    let shutdownResolved = false;
    const sleepCalls: number[] = [];
    let shutdownCalls = 0;
    let resolveShutdown!: (signal: string) => void;
    const shutdown = new Promise<string>((resolve) => {
      resolveShutdown = resolve;
    });
    const { caller, calls } = installFakeCaller({
      status: () => {
        if (!shutdownResolved) return loopStatus({});
        const inflight = drain[Math.min(drainIdx, drain.length - 1)] ?? false;
        drainIdx += 1;
        return loopStatus({ inflight });
      },
    });
    setBenchScheduleSeams({
      caller,
      waitForShutdown: () => {
        shutdownCalls += 1;
        return shutdown.then((signal) => {
          shutdownResolved = true;
          return signal;
        });
      },
      sleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
    });

    const pending = captureProcessStreams(() =>
      benchCmd.runBench(["schedule", "run", "--interval=120"]),
    );
    await Bun.sleep(10);
    expect(calls.start).toEqual([{ tickIntervalSeconds: 120 }]);
    expect(shutdownCalls).toBe(1);
    expect(calls.stop).toBe(0);

    resolveShutdown("SIGTERM");
    const { result, stderr } = await pending;
    expect(result).toBe(0);
    expect(calls.stop).toBe(1);
    expect(sleepCalls).toEqual([1000, 1000]);
    expect(stderr).toContain("bench-scheduler: running");
    expect(stderr).toContain("waiting for in-flight bench");
    expect(stderr).toContain("bench-scheduler: stopped");
    expect(calls.kick).toBe(0);
    expect(calls.add).toHaveLength(0);
  });

  test("run defaults --interval to 60 seconds", async () => {
    let resolveShutdown!: (signal: string) => void;
    const shutdown = new Promise<string>((resolve) => {
      resolveShutdown = resolve;
    });
    const { caller, calls } = installFakeCaller({});
    setBenchScheduleSeams({
      caller,
      waitForShutdown: () => shutdown,
      sleep: () => Promise.resolve(),
    });

    const pending = captureProcessStreams(() => benchCmd.runBench(["schedule", "run"]));
    await Bun.sleep(10);
    resolveShutdown("SIGTERM");
    const { result } = await pending;
    expect(result).toBe(0);
    expect(calls.start).toEqual([{ tickIntervalSeconds: 60 }]);
  });

  test("add takes the target node from the global --node", async () => {
    const { caller, calls } = installFakeCaller({});
    setBenchScheduleSeams({ caller });
    setGlobals({ ...getGlobals(), nodeName: "gpu1" });

    const { result } = await captureProcessStreams(() =>
      benchCmd.runBench(["schedule", "add", "nightly", "--rel", "r", "--every", "1d"]),
    );
    expect(result).toBe(0);
    expect(calls.add).toEqual([
      { id: "nightly", node: "gpu1", rel: "r", mode: "auto", intervalSeconds: 86_400 },
    ]);
  });

  test("global --node is refused outside add and --context is refused everywhere", async () => {
    const { caller, calls } = installFakeCaller({});
    setBenchScheduleSeams({ caller });

    setGlobals({ ...getGlobals(), nodeName: "gpu1" });
    const list = await captureProcessStreams(() => benchCmd.runBench(["schedule", "list"]));
    expect(list.result).toBe(1);
    expect(list.stderr).toContain("--node is only accepted by `bench schedule add`");
    expect(calls.list).toBe(0);

    setGlobals({ ...EMPTY_GLOBALS, contextName: "foo" });
    const add = await captureProcessStreams(() =>
      benchCmd.runBench(["schedule", "add", "nightly", "--rel", "r", "--every", "1d"]),
    );
    expect(add.result).toBe(1);
    expect(add.stderr).toContain("--context is not supported");
    expect(calls.add).toHaveLength(0);
  });

  test("status prints the schedules and the loop state", async () => {
    const schedules: ScheduleShape[] = [
      {
        id: "a",
        node: "gpu1",
        rel: "org/repo/a.gguf",
        mode: "auto",
        intervalSeconds: 3600,
        enabled: true,
        lastRunAt: null,
        lastError: "boom",
      },
      {
        id: "b",
        node: "gpu2",
        rel: "org/repo/b.gguf",
        mode: "text",
        intervalSeconds: 7200,
        enabled: false,
        lastRunAt: "2026-01-01T00:00:00.000Z",
        lastError: null,
      },
    ];
    const { caller } = installFakeCaller({
      schedules,
      status: () =>
        loopStatus({
          recent: [
            {
              ts: "2026-01-01T00:00:00.000Z",
              id: "a",
              rel: "org/repo/a.gguf",
              node: "gpu1",
              ok: false,
              message: "boom",
            },
          ],
        }),
    });
    setBenchScheduleSeams({ caller });

    const { result, stdout } = await captureProcessStreams(() =>
      benchCmd.runBench(["schedule", "status"]),
    );
    expect(result).toBe(0);
    for (const needle of [
      "a",
      "b",
      "enabled",
      "disabled",
      "boom",
      "loop: not running in this process",
    ]) {
      expect(stdout).toContain(needle);
    }
  });

  test("status --json emits schedules plus loop", async () => {
    const schedules: ScheduleShape[] = [
      {
        id: "a",
        node: "gpu1",
        rel: "org/repo/a.gguf",
        mode: "auto",
        intervalSeconds: 3600,
        enabled: true,
        lastRunAt: null,
        lastError: "boom",
      },
      {
        id: "b",
        node: "gpu2",
        rel: "org/repo/b.gguf",
        mode: "text",
        intervalSeconds: 7200,
        enabled: false,
        lastRunAt: "2026-01-01T00:00:00.000Z",
        lastError: null,
      },
    ];
    const { caller } = installFakeCaller({
      schedules,
      status: () => loopStatus({}),
    });
    setBenchScheduleSeams({ caller });

    const { result, stdout } = await captureProcessStreams(() =>
      benchCmd.runBench(["schedule", "status", "--json"]),
    );
    expect(result).toBe(0);
    const parsed = parseJsonRecord(stdout.trim());
    expect(requireArrayField(parsed, "schedules")).toHaveLength(2);
    const loop = requireRecordField(parsed, "loop");
    expect(loop["running"]).toBe(false);
  });

  test("kick exits 1 and prints the failure when a scheduled bench fails", async () => {
    let kicked = false;
    const before = loopStatus({ recent: [] });
    const after = loopStatus({
      recent: [
        {
          ts: "2026-01-01T00:00:00.000Z",
          id: "a",
          rel: "org/repo/a.gguf",
          node: "gpu1",
          ok: false,
          message: "boom",
        },
      ],
    });
    const { caller, calls } = installFakeCaller({
      status: () => (kicked ? after : before),
      kickResult: after,
      onKick: () => {
        kicked = true;
      },
    });
    setBenchScheduleSeams({ caller });

    const { result, stdout } = await captureProcessStreams(() =>
      benchCmd.runBench(["schedule", "kick"]),
    );
    expect(calls.kick).toBe(1);
    expect(result).toBe(1);
    expect(stdout).toContain("a");
    expect(stdout).toContain("boom");
  });

  test("kick exits 0 when every scheduled bench succeeds", async () => {
    let kicked = false;
    const before = loopStatus({ recent: [] });
    const after = loopStatus({
      recent: [
        {
          ts: "2026-01-01T00:00:00.000Z",
          id: "a",
          rel: "org/repo/a.gguf",
          node: "gpu1",
          ok: true,
        },
      ],
    });
    const { caller, calls } = installFakeCaller({
      status: () => (kicked ? after : before),
      kickResult: after,
      onKick: () => {
        kicked = true;
      },
    });
    setBenchScheduleSeams({ caller });

    const { result } = await captureProcessStreams(() => benchCmd.runBench(["schedule", "kick"]));
    expect(calls.kick).toBe(1);
    expect(result).toBe(0);
  });

  test("kick prints no schedules due when nothing new ran", async () => {
    const shared = loopStatus({
      recent: [
        {
          ts: "2025-12-31T00:00:00.000Z",
          id: "old",
          rel: "org/repo/old.gguf",
          node: "gpu1",
          ok: true,
        },
      ],
    });
    const { caller, calls } = installFakeCaller({
      status: () => shared,
      kickResult: shared,
    });
    setBenchScheduleSeams({ caller });

    const { result, stdout } = await captureProcessStreams(() =>
      benchCmd.runBench(["schedule", "kick"]),
    );
    expect(calls.kick).toBe(1);
    expect(result).toBe(0);
    expect(stdout).toContain("no schedules due");
  });

  test("kick prints only the entries appended to a non-empty recent buffer", async () => {
    let kicked = false;
    const before = loopStatus({ recent: [recentEntry("old-1"), recentEntry("old-2")] });
    const after = loopStatus({
      recent: [recentEntry("old-1"), recentEntry("old-2"), recentEntry("fresh-3")],
    });
    const { caller, calls } = installFakeCaller({
      status: () => (kicked ? after : before),
      kickResult: after,
      onKick: () => {
        kicked = true;
      },
    });
    setBenchScheduleSeams({ caller });

    const { result, stdout } = await captureProcessStreams(() =>
      benchCmd.runBench(["schedule", "kick"]),
    );
    expect(calls.kick).toBe(1);
    expect(result).toBe(0);
    expect(stdout).toContain("fresh-3");
    expect(stdout).not.toContain("old-1");
    expect(stdout).not.toContain("old-2");
  });

  test("kick prints only the new entry at the 200-entry recent cap", async () => {
    let kicked = false;
    const before = loopStatus({
      recent: Array.from({ length: 200 }, (_, i) => recentEntry(`old-${String(i)}`)),
    });
    const after = loopStatus({
      recent: [
        ...Array.from({ length: 199 }, (_, i) => recentEntry(`old-${String(i + 1)}`)),
        recentEntry("fresh-cap"),
      ],
    });
    const { caller, calls } = installFakeCaller({
      status: () => (kicked ? after : before),
      kickResult: after,
      onKick: () => {
        kicked = true;
      },
    });
    setBenchScheduleSeams({ caller });

    const { result, stdout } = await captureProcessStreams(() =>
      benchCmd.runBench(["schedule", "kick"]),
    );
    expect(calls.kick).toBe(1);
    expect(result).toBe(0);
    expect(stdout).toContain("fresh-cap");
    expect(stdout).not.toContain("old-");
  });

  test("kick surfaces the run-lock refusal from the caller and exits 1", async () => {
    const { caller, calls } = installFakeCaller({
      kickRejects: new Error(
        "a bench scheduler run already holds the run lock (pid 4242, " +
          "started 2026-01-01T00:00:00.000Z); stop it before kicking or starting another run",
      ),
    });
    setBenchScheduleSeams({ caller });

    const { result, stdout, stderr } = await captureProcessStreams(() =>
      benchCmd.runBench(["schedule", "kick"]),
    );
    expect(calls.kick).toBe(1);
    expect(result).toBe(1);
    expect(stderr).toContain("bench schedule kick:");
    expect(stderr).toContain("already holds the run lock (pid 4242");
    expect(stdout).toBe("");
    expect(calls.status).toBe(1);
  });

  test("run surfaces a run-lock refusal from start and exits 1", async () => {
    let shutdownCalls = 0;
    const { caller, calls } = installFakeCaller({
      startRejects: new Error(
        "a bench scheduler run already holds the run lock (pid 4242, " +
          "started 2026-01-01T00:00:00.000Z); stop it before kicking or starting another run",
      ),
    });
    setBenchScheduleSeams({
      caller,
      waitForShutdown: () => {
        shutdownCalls += 1;
        return new Promise<string>((_resolve) => {
          void _resolve;
        });
      },
      sleep: () => Promise.resolve(),
    });

    const { result, stderr } = await captureProcessStreams(() =>
      benchCmd.runBench(["schedule", "run", "--interval=30"]),
    );
    expect(calls.start).toEqual([{ tickIntervalSeconds: 30 }]);
    expect(shutdownCalls).toBe(0);
    expect(result).toBe(1);
    expect(stderr).toContain("bench schedule run:");
    expect(stderr).toContain("already holds the run lock (pid 4242");
  });
});
