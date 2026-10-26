import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getEventListeners } from "node:events";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";

import { machineLabel } from "../src/bench/mode.js";
import { benchProfileFile } from "../src/bench/store.js";
import { resolveBuildId } from "../src/build.js";
import { ctxForModel } from "../src/ctx.js";
import { resolveEnv } from "../src/env.js";
import { processCommand } from "../src/pidIdentity.js";
import { mkdirSync, writeFileSync } from "../src/safe-fs.js";
import {
  readServerPid,
  readServerState,
  type ServerEvent,
  type ServerState,
  serverStatus,
  startServer,
  type StartServerResult,
  stopServer,
} from "../src/server.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

// The mmproj safe-flag retry in startServer stops the first llama-server and
// launches a second one. These tests drive the real startServer with real
// child processes (a /bin/sh fake binary that execs /bin/sleep) and answer
// every /health probe from a globalThis.fetch spy, so no port is ever bound.
// Every start names the alias target "current" (LOCAL_AI_SOURCE_MODEL is the
// test rel), so the resolved rel differs from opts.target.
// The identity seam returns the exact argv startServer launched for a pid, so
// stopServer's real binary-path + model expectation decides each stop. T7 (i)-(iv)
// and T12 onwards use a fake binary built on bash's `exec -a`, so the real `ps`
// command line shows the launched binary and args; T7, T12, T13, T15, T16, T18,
// T19 and T20 pass no identity seam, as production does. T7 (v) keeps the /bin/sh
// fake, whose real command line (/bin/sleep 30) does not match, so its retry stop
// refuses on its own. T15 also passes no endpoint or binary option, so the launch
// resolves them from the env defaults. T12a also restores both spies and runs
// fully in the production shape: real fetch against the unbound test port (a
// refused connection reads as not ready) and real signals.
// In every other test one process.kill spy sees every signal startServer sends.
// A call aimed at a pid <= 0 is recorded and never forwarded (kill(0) would signal
// this runner's own process group), and every spied test asserts there was none.
// Every seam-free test whose retry stops the argv fake (T7 (i)-(iv), T12a, T12b, T15,
// T18, T19, T21) waits in each launch's first waiting event until ps shows the exec'd
// command line, and asserts the retry stop was not refused before counting launches (#291).

const KEY = { name: "mmproj-retry-wl" };
// T20's second workload, started concurrently with KEY on its own port.
const KEY_B = { name: "mmproj-retry-wl-b" };
const REL = "probe/model.gguf";
const HOST = "127.0.0.1";
const PORT = 41_877;
const PORT_B = 41_878;
const ENDPOINT = `http://${HOST}:${String(PORT)}`;
// BASE server.ts safeRetryArgs(): the mmproj retry relaunches the first launch's
// argv with exactly these flags appended. launchBackground's injected defaults
// (--alias, --host, --port, -ngl) match none of them, so the prefix is identical.
const SAFE_RETRY_FLAGS = [
  "--flash-attn",
  "off",
  "--no-cache-prompt",
  "--parallel",
  "1",
  "--no-cont-batching",
  "--no-mmproj-offload",
  "--no-warmup",
].join(" ");
const ABORTED = "Start aborted by caller";
const EXITED = "llama-server exited before becoming ready";
const TIMED_OUT = "readiness check timed out after 1s";
// What BASE's start reports when something already answers on the test port:
// the pre-launch port-conflict check, and the readiness poll's foreign-listener hint.
const PORT_BOUND = `port ${HOST}:${String(PORT)} is already bound`;
const FOREIGN_LISTENER = "another process is likely bound to this port";
// What the first pid "is" once the identity seam stops vouching for it.
const FOREIGN_COMMAND = "/bin/sleep 30";
const TEST_TIMEOUT_MS = 20_000;
// What a refused retry stop reports (server.ts retryWithMmprojSafeFlags).
const REFUSED_RETRY = "refusing mmproj retry";
// #291: bound on waiting for the argv fake to reach `exec -a`, and T21's pre-exec sleep:
// past the first poll's 1 s, with ~3 s left inside the bound for a loaded machine.
const ARGV_EXEC_DEADLINE_MS = 5000;
const SLOW_EXEC_SECONDS = 2;

interface SentSignal {
  pid: number;
  signal: string | number;
}

/**
 * How the process.kill spy treats a call aimed at a pid > 0:
 * - "forward": pass it to the real kill (the default).
 * - "afterRetry": once the retry launched, record every non-zero signal and
 *   never forward one to the first pid, which is stopped by then and whose
 *   number could be recycled; with `simulateRecycled`, kill(firstPid, 0) also
 *   answers alive, as it would once another process holds that pid.
 * - "afterStop": as "afterRetry", but the first pid also counts as stopped
 *   once its PID file is gone after it launched (the R3 path never relaunches).
 * - "record": record every non-zero signal and forward every call to the real kill.
 * - "swallow": record every non-zero signal and forward none; probes still
 *   reach the real kill unless `simulateRecycled`, which answers them alive.
 */
type KillMode = "afterRetry" | "afterStop" | "forward" | "record" | "swallow";

interface KillSpy {
  mode: KillMode;
  simulateRecycled: boolean;
  /** Non-zero signals recorded under "afterRetry", "afterStop", "record" and "swallow". */
  sent: SentSignal[];
  /** Every call aimed at a pid <= 0, any signal, in any mode; none is forwarded. */
  nonPositive: SentSignal[];
  /** While abortCapturing runs controller.abort(): every non-zero signal, in any mode. */
  duringAbort: SentSignal[] | null;
}

// Captured before any spy is installed, so liveness checks and cleanup never
// go through a test's process.kill spy.
const realKill = process.kill.bind(process);

const isAlive = (pid: number): boolean => {
  try {
    realKill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Blocking sleep for a wait that must finish inside a synchronous onEvent callback. */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Poll until the pid is gone; Bun reaps exited children on the event loop. */
const waitForExit = async (pid: number, timeoutMs = 3000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
  return true;
};

const withoutStartedAt = (state: ServerState | null): Omit<ServerState, "startedAt"> | null => {
  if (state === null) return null;
  const { startedAt: _startedAt, ...rest } = state;
  return rest;
};

describe("startServer mmproj safe-flag retry bookkeeping", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let resolved: ResolvedEnv;
  let originalEnv: NodeJS.ProcessEnv;
  let binary: string;
  let modelPath: string;
  let slotDir: string;
  let extraArgs: string[];
  let launches: { pid: number; argv: string }[];
  let healthy: boolean;
  let kills: KillSpy;
  let commandHook: ((pid: number, argv: string | null) => string | null) | null;
  let spies: { mockRestore: () => void }[];
  /** #291: per launched pid, how many ps reads waitForArgvExec needed before `exec -a` showed. */
  let execPolls: Map<number, number>;

  const identity = {
    processCommand: (pid: number): string | null => {
      const argv = launches.find((launch) => launch.pid === pid)?.argv ?? null;
      return commandHook === null ? argv : commandHook(pid, argv);
    },
  };

  // Every fetch in startServer, stopServer and serverStatus lands here: a
  // rejection reads as a refused connection (not ready, port free), and a
  // test flips `healthy` when /health should answer 200.
  const fakeHealth = (): Promise<Response> =>
    healthy
      ? Promise.resolve(new Response("ok", { status: 200 }))
      : Promise.reject(new TypeError("connection refused (fetch spy)"));

  /** The first pid is stopped once the retry launched or, under "afterStop", once its PID file is gone. */
  const firstStopped = (): boolean =>
    launches.length >= 2 ||
    (kills.mode === "afterStop" && launches.length === 1 && readServerPid(KEY, resolved) === null);

  const recordsSignals = (): boolean =>
    kills.mode === "swallow" ||
    kills.mode === "record" ||
    (kills.mode !== "forward" && firstStopped());

  /** Whether the spy answers a call itself instead of forwarding it to the real kill. */
  const answersItself = (pid: number, nonZero: boolean): boolean => {
    if (kills.mode === "swallow") return nonZero || kills.simulateRecycled;
    if (kills.mode === "forward" || kills.mode === "record" || !firstStopped()) return false;
    return pid === launches[0]?.pid && (nonZero || kills.simulateRecycled);
  };

  const fakeKill = (pid: number, signal?: string | number): true => {
    const sent = { pid, signal: signal ?? "SIGTERM" };
    if (pid <= 0) {
      kills.nonPositive.push(sent);
      return true;
    }
    const nonZero = signal !== 0;
    if (nonZero) {
      kills.duringAbort?.push(sent);
      if (recordsSignals()) kills.sent.push(sent);
    }
    return answersItself(pid, nonZero) ? true : realKill(pid, signal);
  };

  /** controller.abort() runs the abort listeners synchronously; return what they signalled. */
  const abortCapturing = (controller: AbortController): SentSignal[] => {
    const captured: SentSignal[] = [];
    kills.duringAbort = captured;
    try {
      controller.abort();
    } finally {
      kills.duringAbort = null;
    }
    return captured;
  };

  /** Wrap a test's onEvent so every launch (its pid and exact argv) is recorded first. */
  const recordingLaunches =
    (onEvent: (e: ServerEvent) => void) =>
    (e: ServerEvent): void => {
      if (e.type === "launch") {
        launches.push({ pid: e.pid, argv: [e.command, ...e.args].join(" ") });
      }
      onEvent(e);
    };

  /**
   * Start the alias target "current" (resolved to REL) with the test binary and endpoint.
   * With `withIdentity` false the identity seam is omitted, as in production (T7, T12, T13, T16, T18).
   */
  const start = (
    onEvent: (e: ServerEvent) => void,
    signal?: AbortSignal,
    skipTuned = true,
    withIdentity = true,
  ): Promise<StartServerResult> =>
    startServer({
      key: KEY,
      target: "current",
      resolved,
      binary,
      endpoint: { host: HOST, port: PORT },
      extraArgs,
      timeoutSeconds: 1,
      skipTuned,
      ...(withIdentity ? { identity } : {}),
      ...(signal === undefined ? {} : { signal }),
      onEvent: recordingLaunches(onEvent),
    });

  const expectedState = (pid: number): Omit<ServerState, "startedAt"> => ({
    rel: REL,
    extraArgs,
    slotSavePath: slotDir,
    host: HOST,
    port: String(PORT),
    binary,
    pid,
    tunedProfile: null,
  });

  const failedResult = (retried: boolean, error: string): StartServerResult => ({
    ok: false,
    pid: null,
    endpoint: ENDPOINT,
    advertisedEndpoint: ENDPOINT,
    tunedProfile: null,
    retried,
    error,
  });

  const abortedResult = (retried: boolean): StartServerResult => failedResult(retried, ABORTED);

  /** A bench-profiles row that gives the first launch the tuned profile "throughput". */
  const writeThroughputProfile = (): void => {
    const row = [
      machineLabel(resolved),
      REL,
      "vision",
      ctxForModel(REL, resolved),
      resolveBuildId(resolved),
      "throughput",
      "1",
      "1",
      "2026-01-01T00:00:00.000Z",
    ];
    mkdirSync(temp.runtimeDir, { recursive: true });
    writeFileSync(benchProfileFile(resolved), `${row.join("\t")}\n`);
  };

  /**
   * The fake binary of T7 (i)-(iv) and T12 onwards, written to `path`. Without the identity seam
   * stopServer reads the real `ps` command line, and `exec -a` makes it show this
   * script's path and the launch args (then /bin/sleep's own "30"), as a real
   * llama-server's does. Its default basename is not llama-server, so a missing
   * sidecar makes a stop refuse; T15 names it llama-server under LLAMA_CPP_BIN.
   * `preExecSleepSeconds` > 0 makes bash sleep that long before `exec -a` (T21).
   */
  const useArgvFakeBinary = (
    path = join(temp.devStorage, "argv-fake-llama-server"),
    preExecSleepSeconds = 0,
  ): void => {
    binary = path;
    const preExec = preExecSleepSeconds > 0 ? `sleep ${String(preExecSleepSeconds)}\n` : "";
    writeFileSync(binary, `#!/bin/bash\n${preExec}exec -a "$0 $*" /bin/sleep 30\n`, {
      mode: 0o755,
    });
  };

  /**
   * #291: until bash reaches `exec -a`, `ps -o command=` shows `/bin/bash <script> ...`, which a
   * seam-free stop reads as an unverifiable identity and refuses. Block, bounded, until the pid's
   * real command line starts with the fake's path. Returns how many ps reads that took.
   */
  const waitForArgvExec = (pid: number): number => {
    const deadline = Date.now() + ARGV_EXEC_DEADLINE_MS;
    let polls = 0;
    let command: string | null = null;
    while (Date.now() <= deadline) {
      polls += 1;
      command = processCommand(pid);
      if (command !== null && (command === binary || command.startsWith(`${binary} `))) {
        return polls;
      }
      sleepSync(25);
    }
    throw new Error(
      `argv fake pid ${String(pid)} did not reach exec -a within ${String(ARGV_EXEC_DEADLINE_MS)} ms; ps -o command= shows: ${command ?? "<no output>"}`,
    );
  };

  /** Wrap a seam-free test's onEvent: each launch's first `waiting` event waits for `exec -a` first. */
  const waitingForArgvExec =
    (onEvent: (e: ServerEvent) => void) =>
    (e: ServerEvent): void => {
      const pid = launches[launches.length - 1]?.pid;
      if (e.type === "waiting" && pid !== undefined && !execPolls.has(pid)) {
        execPolls.set(pid, waitForArgvExec(pid));
      }
      onEvent(e);
    };

  /** #291: a refused retry stop fails here, naming the first pid's real command line, before any launch count. */
  const expectRetryStopNotRefused = (error: string | undefined): void => {
    const message = error ?? "";
    const firstPid = launches[0]?.pid ?? 0;
    const detail = message.includes(REFUSED_RETRY)
      ? ` | first pid ${String(firstPid)} ps -o command=: ${processCommand(firstPid) ?? "<no output: ps failed or pid gone>"}`
      : "";
    expect(`${message}${detail}`).not.toContain(REFUSED_RETRY);
  };

  /** Restore the fetch and process.kill spies; a second call (afterEach after T12a) is a no-op. */
  const restoreSpies = (): void => {
    for (const spy of spies) spy.mockRestore();
    spies = [];
  };

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    process.env = {
      ...envForTemp(temp),
      LLAMA_CPP_HOST: "localhost",
      LLAMA_CPP_PORT: "1",
      LOCAL_AI_SOURCE_MODEL: REL,
    };
    resolved = resolveEnv();
    mkdirSync(join(temp.modelsDir, "probe"), { recursive: true });
    modelPath = join(temp.modelsDir, REL);
    writeFileSync(modelPath, "");
    binary = join(temp.devStorage, "fake-llama-server");
    writeFileSync(binary, "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 });
    slotDir = join(temp.runtimeDir, "kvstore", "slots", KEY.name);
    extraArgs = ["--mmproj", modelPath, "--slot-save-path", "auto"];
    launches = [];
    healthy = false;
    kills = {
      mode: "forward",
      simulateRecycled: false,
      sent: [],
      nonPositive: [],
      duringAbort: null,
    };
    commandHook = null;
    execPolls = new Map();
    spies = [
      spyOn(globalThis, "fetch").mockImplementation(fakeHealth as unknown as typeof fetch),
      spyOn(process, "kill").mockImplementation(fakeKill),
    ];
  });

  afterEach(() => {
    restoreSpies();
    for (const { pid } of launches) {
      // pid 0 would address our own process group.
      if (pid <= 0 || !isAlive(pid)) continue;
      try {
        realKill(-pid, "SIGKILL");
      } catch {
        // The detached group may already be gone.
      }
      try {
        realKill(pid, "SIGKILL");
      } catch {
        // The child may already be gone.
      }
    }
    process.env = originalEnv;
    temp.cleanup();
  });

  test(
    "T1 retry ready: the sidecar is rewritten for the retry pid and stopServer stops it",
    async () => {
      const firstStates: (ServerState | null)[] = [];
      const res = await start((e) => {
        if (e.type === "waiting" && launches.length === 1 && firstStates.length === 0) {
          firstStates.push(readServerState(KEY, resolved));
        }
        if (e.type === "launch" && launches.length === 2) healthy = true;
      });
      healthy = false;
      expect(launches).toHaveLength(2);
      const firstPid = launches[0]!.pid;
      const retryPid = launches[1]!.pid;
      expect(res.ok).toBe(true);
      expect(res.retried).toBe(true);
      expect(res.pid).toBe(retryPid);
      // R5: the retry relaunches the first launch's exact argv with the safe-retry flags appended.
      expect(launches[1]!.argv).toBe(`${launches[0]!.argv} ${SAFE_RETRY_FLAGS}`);
      const firstState = firstStates[0] ?? null;
      expect(withoutStartedAt(firstState)).toEqual(expectedState(firstPid));
      expect(readServerPid(KEY, resolved)).toBe(retryPid);
      const state = readServerState(KEY, resolved);
      expect(withoutStartedAt(state)).toEqual(expectedState(retryPid));
      expect(Date.parse(state!.startedAt)).toBeGreaterThan(Date.parse(firstState!.startedAt));

      const status = await serverStatus(KEY, resolved);
      expect(status.state).toBe("up");
      expect(status.pid).toBe(retryPid);
      expect(status.endpoint).toBe(ENDPOINT);
      expect(status.rel).toBe(REL);
      expect(status.binary).toBe(binary);
      expect(status.extraArgs).toEqual(extraArgs);

      const stop = await stopServer({ key: KEY, resolved, identity, graceSeconds: 1 });
      expect(stop).toEqual({ stopped: true, pid: retryPid, killed: false });
      expect(await waitForExit(retryPid)).toBe(true);
      expect(readServerPid(KEY, resolved)).toBeNull();
      expect(readServerState(KEY, resolved)).toBeNull();
      expect(kills.nonPositive).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T2 abort during the retry poll: SIGTERM goes to the retry pid, never the first pid",
    async () => {
      const controller = new AbortController();
      kills.mode = "afterRetry";
      kills.simulateRecycled = true;
      const sentDuringAbort: SentSignal[] = [];
      let scheduled = false;
      const res = await start((e) => {
        if (e.type === "waiting" && launches.length === 2 && !scheduled) {
          scheduled = true;
          // Lands in the retry poll's 1 s sleep; abort() runs its listeners synchronously.
          setTimeout(() => {
            sentDuringAbort.push(...abortCapturing(controller));
            // Every later identity check reads "unknown": an aborted branch that
            // delegated to stopServer would keep both tracking files.
            commandHook = (): string => FOREIGN_COMMAND;
          }, 10);
        }
      }, controller.signal);
      expect(launches).toHaveLength(2);
      const firstPid = launches[0]!.pid;
      const retryPid = launches[1]!.pid;
      expect(res).toEqual(abortedResult(true));
      expect(kills.sent.filter((s) => s.pid === firstPid)).toEqual([]);
      const sigtermTargets = kills.sent.filter((s) => s.signal === "SIGTERM").map((s) => s.pid);
      expect([...new Set(sigtermTargets)]).toEqual([retryPid]);
      // The abort handler itself signals the retry pid, not only the aborted-outcome cleanup.
      expect(sentDuringAbort).toEqual([{ pid: retryPid, signal: "SIGTERM" }]);
      expect(await waitForExit(retryPid)).toBe(true);
      expect(readServerPid(KEY, resolved)).toBeNull();
      expect(readServerState(KEY, resolved)).toBeNull();
      expect(kills.nonPositive).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T3 retry timeout: the timeout event, the result and the tracking pair carry the retry pid",
    async () => {
      const timeoutPids: number[] = [];
      const duringRetryPoll: {
        pid: number | null;
        state: Omit<ServerState, "startedAt"> | null;
      }[] = [];
      const res = await start((e) => {
        if (e.type === "timeout") timeoutPids.push(e.pid);
        if (e.type === "waiting" && launches.length === 2 && duringRetryPoll.length === 0) {
          duringRetryPoll.push({
            pid: readServerPid(KEY, resolved),
            state: withoutStartedAt(readServerState(KEY, resolved)),
          });
        }
      });
      expect(launches).toHaveLength(2);
      const firstPid = launches[0]!.pid;
      const retryPid = launches[1]!.pid;
      expect(res.ok).toBe(false);
      expect(res.retried).toBe(true);
      expect(res.error).toContain(TIMED_OUT);
      expect(timeoutPids).toEqual([retryPid]);
      expect(res.pid).toBe(retryPid);
      expect(readServerPid(KEY, resolved)).toBe(retryPid);
      expect(withoutStartedAt(readServerState(KEY, resolved))).toEqual(expectedState(retryPid));
      // The pair is written with the retry launch, not only when the retry resolves.
      expect(duringRetryPoll).toEqual([{ pid: retryPid, state: expectedState(retryPid) }]);
      expect(isAlive(retryPid)).toBe(true);
      expect(isAlive(firstPid)).toBe(false);
      expect(kills.nonPositive).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T4 abort during the first poll: both tracking files are removed",
    async () => {
      const controller = new AbortController();
      writeThroughputProfile();
      const sentDuringAbort: SentSignal[] = [];
      let scheduled = false;
      const res = await start(
        (e) => {
          if (e.type === "waiting" && !scheduled) {
            scheduled = true;
            setTimeout(() => {
              sentDuringAbort.push(...abortCapturing(controller));
              // Every later identity check reads "unknown": an aborted branch that
              // delegated to stopServer would keep both tracking files.
              commandHook = (): string => FOREIGN_COMMAND;
            }, 10);
          }
        },
        controller.signal,
        false,
      );
      expect(launches).toHaveLength(1);
      // The first-poll aborted result keeps the first launch's tuned profile.
      expect(res).toEqual({ ...abortedResult(false), tunedProfile: "throughput" });
      // R2a: the handler itself SIGTERMs the first pid during abort().
      expect(sentDuringAbort).toEqual([{ pid: launches[0]!.pid, signal: "SIGTERM" }]);
      expect(await waitForExit(launches[0]!.pid)).toBe(true);
      expect(readServerPid(KEY, resolved)).toBeNull();
      expect(readServerState(KEY, resolved)).toBeNull();
      expect(kills.nonPositive).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T5 abort before relaunch: an abort raised at the retry launches no second process",
    async () => {
      const controller = new AbortController();
      kills.mode = "afterStop";
      kills.simulateRecycled = true;
      writeThroughputProfile();
      const res = await start(
        (e) => {
          if (e.type === "retry") controller.abort();
        },
        controller.signal,
        false,
      );
      expect(launches).toHaveLength(1);
      // The aborted result keeps the first launch's tuned profile.
      expect(res).toEqual({ ...abortedResult(true), tunedProfile: "throughput" });
      // R3: once the retry's stop removed the PID file, nothing signals the first pid.
      expect(kills.sent).toEqual([]);
      expect(await waitForExit(launches[0]!.pid)).toBe(true);
      expect(readServerPid(KEY, resolved)).toBeNull();
      expect(readServerState(KEY, resolved)).toBeNull();
      expect(kills.nonPositive).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T6 abort at the retry launch: only the retry pid is signalled, it stops and both files go",
    async () => {
      const controller = new AbortController();
      kills.mode = "afterRetry";
      kills.simulateRecycled = true;
      const res = await start((e) => {
        if (e.type === "launch" && launches.length === 2) controller.abort();
      }, controller.signal);
      expect(launches).toHaveLength(2);
      const firstPid = launches[0]!.pid;
      const retryPid = launches[1]!.pid;
      expect(res).toEqual(abortedResult(true));
      expect(kills.sent.filter((s) => s.pid === firstPid)).toEqual([]);
      const sigtermTargets = kills.sent.filter((s) => s.signal === "SIGTERM").map((s) => s.pid);
      expect([...new Set(sigtermTargets)]).toEqual([retryPid]);
      expect(await waitForExit(retryPid)).toBe(true);
      expect(readServerPid(KEY, resolved)).toBeNull();
      expect(readServerState(KEY, resolved)).toBeNull();
      expect(kills.nonPositive).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  // Every non-aborted return that still tracks a process. After each, a later
  // abort must signal nothing and leave the tracking files as they were. Every
  // case runs seam-free (no identity option), as production does.
  const returnCases: {
    id: string;
    title: string;
    /** Whether the launch args carry --mmproj, so an unready first attempt retries. */
    mmproj: boolean;
    /** The launch (1 = first, 2 = retry) whose /health answers 200; null for none. */
    healthyAt: 1 | 2 | null;
    /**
     * Keep the /bin/sh fake: its real command line (/bin/sleep 30) does not match the
     * sidecar's binary path, so the retry's stop refuses. Every other case uses the
     * `exec -a` fake, whose real command line matches.
     */
    refuseRetryStop: boolean;
    launches: number;
    ok: boolean;
    retried: boolean;
    /** Substring of the result error; null for a success. */
    error: string | null;
    /** Index into the launches of the pid the PID file records at return. */
    tracked: 0 | 1;
  }[] = [
    {
      id: "(i)",
      title: "first-attempt ready",
      mmproj: true,
      healthyAt: 1,
      refuseRetryStop: false,
      launches: 1,
      ok: true,
      retried: false,
      error: null,
      tracked: 0,
    },
    {
      id: "(ii)",
      title: "first-attempt timeout without mmproj args",
      mmproj: false,
      healthyAt: null,
      refuseRetryStop: false,
      launches: 1,
      ok: false,
      retried: false,
      error: TIMED_OUT,
      tracked: 0,
    },
    {
      id: "(iii)",
      title: "retry ready",
      mmproj: true,
      healthyAt: 2,
      refuseRetryStop: false,
      launches: 2,
      ok: true,
      retried: true,
      error: null,
      tracked: 1,
    },
    {
      id: "(iv)",
      title: "retry timeout",
      mmproj: true,
      healthyAt: null,
      refuseRetryStop: false,
      launches: 2,
      ok: false,
      retried: true,
      error: TIMED_OUT,
      tracked: 1,
    },
    {
      id: "(v)",
      title: "retry refused",
      mmproj: true,
      healthyAt: null,
      refuseRetryStop: true,
      launches: 1,
      ok: false,
      retried: true,
      error: "refusing mmproj retry",
      tracked: 0,
    },
  ];

  for (const c of returnCases) {
    test(
      `T7 ${c.id} no listener after return: a later abort signals nothing after ${c.title}`,
      async () => {
        if (!c.refuseRetryStop) useArgvFakeBinary();
        if (!c.mmproj) extraArgs = ["--slot-save-path", "auto"];
        const controller = new AbortController();
        const timeoutPids: number[] = [];
        const onEvent = (e: ServerEvent): void => {
          if (e.type === "timeout") timeoutPids.push(e.pid);
          if (e.type === "launch" && launches.length === c.healthyAt) healthy = true;
        };
        const res = await start(
          c.refuseRetryStop ? onEvent : waitingForArgvExec(onEvent),
          controller.signal,
          true,
          false,
        );
        // R2e: every listener startServer added is removed, not just disarmed.
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        if (!c.refuseRetryStop) expectRetryStopNotRefused(res.error);
        expect(launches).toHaveLength(c.launches);
        expect(res.ok).toBe(c.ok);
        expect(res.retried).toBe(c.retried);
        if (c.error === null) expect(res.error).toBeUndefined();
        else expect(res.error).toContain(c.error);
        const trackedPid = launches[c.tracked]!.pid;
        expect(res.pid).toBe(c.refuseRetryStop ? null : trackedPid);
        expect(timeoutPids).toEqual(c.error === TIMED_OUT ? [trackedPid] : []);
        const pidAtReturn = readServerPid(KEY, resolved);
        const stateAtReturn = readServerState(KEY, resolved);
        expect(pidAtReturn).toBe(trackedPid);
        // A path that never relaunched still holds the first launch's pair; the
        // retry's pair is pinned by T1 and T3.
        if (c.launches === 1) {
          expect(withoutStartedAt(stateAtReturn)).toEqual(expectedState(trackedPid));
        }

        kills.mode = "swallow";
        controller.abort();
        await sleep(50);
        expect(kills.sent).toEqual([]);
        expect(isAlive(trackedPid)).toBe(true);
        expect(readServerPid(KEY, resolved)).toBe(pidAtReturn);
        expect(readServerState(KEY, resolved)).toEqual(stateAtReturn);
        expect(kills.nonPositive).toEqual([]);
        // afterEach restores the spies, then SIGKILLs the still-running server.
      },
      TEST_TIMEOUT_MS,
    );
  }

  test(
    "T8 retry exited: the result is unchanged and the tracking pair records the retry pid",
    async () => {
      const controller = new AbortController();
      const exitedEvents: ServerEvent[] = [];
      let killed = false;
      const res = await start((e) => {
        if (e.type === "exited") exitedEvents.push(e);
        if (e.type === "waiting" && launches.length === 2 && !killed) {
          killed = true;
          // The retry poll's next liveness check then finds the retry pid gone.
          realKill(launches[1]!.pid, "SIGKILL");
        }
      }, controller.signal);
      // R2e: every listener startServer added is removed, not just disarmed.
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(launches).toHaveLength(2);
      const retryPid = launches[1]!.pid;
      expect(res).toEqual(failedResult(true, EXITED));
      expect(exitedEvents).toEqual([{ type: "exited", code: null }]);
      expect(readServerPid(KEY, resolved)).toBe(retryPid);
      const stateAtReturn = readServerState(KEY, resolved);
      expect(withoutStartedAt(stateAtReturn)).toEqual(expectedState(retryPid));

      kills.mode = "swallow";
      // The retry pid is gone: a leftover listener would only signal it if its number were recycled.
      kills.simulateRecycled = true;
      controller.abort();
      await sleep(50);
      expect(kills.sent).toEqual([]);
      expect(readServerPid(KEY, resolved)).toBe(retryPid);
      expect(readServerState(KEY, resolved)).toEqual(stateAtReturn);
      expect(kills.nonPositive).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T9 abort during the retry's stopServer: the abort signals nothing and nothing relaunches",
    async () => {
      const controller = new AbortController();
      kills.mode = "afterStop";
      kills.simulateRecycled = true;
      const abortDispatches: SentSignal[][] = [];
      const res = await start((e) => {
        if (e.type !== "retry") return;
        // The first identity lookup after the retry event is the retry's
        // stopServer verifying the first pid, before it signals anything.
        commandHook = (_pid, argv): string | null => {
          commandHook = null;
          abortDispatches.push(abortCapturing(controller));
          return argv;
        };
      }, controller.signal);
      // Disarmed before the stop: the abort handler itself signals nothing.
      expect(abortDispatches).toEqual([[]]);
      expect(launches).toHaveLength(1);
      expect(res).toEqual(abortedResult(true));
      expect(kills.sent).toEqual([]);
      // The retry's stopServer still stopped the first pid it had verified.
      expect(await waitForExit(launches[0]!.pid)).toBe(true);
      expect(readServerPid(KEY, resolved)).toBeNull();
      expect(readServerState(KEY, resolved)).toBeNull();
      expect(kills.nonPositive).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T10 abort during a refused retry stop: the refused result stands and nothing is signalled",
    async () => {
      const controller = new AbortController();
      const abortDispatches: SentSignal[][] = [];
      const res = await start((e) => {
        if (e.type !== "retry") return;
        commandHook = (pid, argv): string | null => {
          if (pid !== launches[0]?.pid) return argv;
          if (abortDispatches.length === 0) {
            abortDispatches.push(abortCapturing(controller));
            // From here on record every signal instead of forwarding it.
            kills.mode = "swallow";
          }
          return FOREIGN_COMMAND;
        };
      }, controller.signal);
      expect(abortDispatches).toEqual([[]]);
      expect(launches).toHaveLength(1);
      const firstPid = launches[0]!.pid;
      expect(res.ok).toBe(false);
      expect(res.retried).toBe(true);
      expect(res.pid).toBeNull();
      expect(res.error).toContain("refusing mmproj retry");
      // The refused branch signals nothing, even though the start was aborted.
      expect(kills.sent).toEqual([]);
      expect(isAlive(firstPid)).toBe(true);
      expect(readServerPid(KEY, resolved)).toBe(firstPid);
      expect(withoutStartedAt(readServerState(KEY, resolved))).toEqual(expectedState(firstPid));
      expect(kills.nonPositive).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T11 tuned profile: the retry's sidecar and result keep the first launch's tuned profile",
    async () => {
      writeThroughputProfile();
      const res = await start(() => undefined, undefined, false);
      expect(launches).toHaveLength(2);
      expect(res.tunedProfile).toBe("throughput");
      expect(readServerPid(KEY, resolved)).toBe(launches[1]!.pid);
      expect(readServerState(KEY, resolved)?.tunedProfile).toBe("throughput");
      expect(kills.nonPositive).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T12a seam-free retry timeout: the retry pid's pair matches its real command line and stopServer stops it",
    async () => {
      // Production shape: no identity seam and no spies. Real fetch finds the
      // test port unbound (refused = not ready), and every signal is real.
      restoreSpies();
      useArgvFakeBinary();
      const timeoutPids: number[] = [];
      const duringRetryPoll: {
        pid: number | null;
        state: Omit<ServerState, "startedAt"> | null;
      }[] = [];
      const res = await start(
        waitingForArgvExec((e) => {
          if (e.type === "timeout") timeoutPids.push(e.pid);
          if (e.type === "waiting" && launches.length === 2 && duringRetryPoll.length === 0) {
            duringRetryPoll.push({
              pid: readServerPid(KEY, resolved),
              state: withoutStartedAt(readServerState(KEY, resolved)),
            });
          }
        }),
        undefined,
        true,
        false,
      );
      // Premise: nothing on the host answers on the test port (real fetch). A
      // listener there makes the start fail before launching, and this says so.
      expect(res.error ?? "").not.toContain(PORT_BOUND);
      expect(res.error ?? "").not.toContain(FOREIGN_LISTENER);
      expectRetryStopNotRefused(res.error);
      expect(launches).toHaveLength(2);
      const firstPid = launches[0]!.pid;
      const retryPid = launches[1]!.pid;
      expect(res.ok).toBe(false);
      expect(res.retried).toBe(true);
      expect(res.error).toContain(TIMED_OUT);
      // The retry's real stop verified and stopped the first pid.
      expect(isAlive(firstPid)).toBe(false);
      // The pair is written with the retry launch, not only when the retry resolves.
      expect(duringRetryPoll).toEqual([{ pid: retryPid, state: expectedState(retryPid) }]);
      expect(readServerPid(KEY, resolved)).toBe(retryPid);
      expect(withoutStartedAt(readServerState(KEY, resolved))).toEqual(expectedState(retryPid));
      expect(timeoutPids).toEqual([retryPid]);
      expect(res.pid).toBe(retryPid);

      // No identity seam: the sidecar's binary path and model must match the real ps command line.
      const stop = await stopServer({ key: KEY, resolved, graceSeconds: 1 });
      expect(stop).toEqual({ stopped: true, pid: retryPid, killed: false });
      expect(await waitForExit(retryPid)).toBe(true);
      expect(readServerPid(KEY, resolved)).toBeNull();
      expect(readServerState(KEY, resolved)).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T12b seam-free abort during the retry poll: SIGTERM goes to the retry pid, never the first pid",
    async () => {
      useArgvFakeBinary();
      const controller = new AbortController();
      kills.mode = "afterRetry";
      kills.simulateRecycled = true;
      const sentDuringAbort: SentSignal[] = [];
      let scheduled = false;
      const res = await start(
        waitingForArgvExec((e) => {
          if (e.type === "waiting" && launches.length === 2 && !scheduled) {
            scheduled = true;
            // Lands in the retry poll's 1 s sleep; abort() runs its listeners synchronously.
            setTimeout(() => {
              sentDuringAbort.push(...abortCapturing(controller));
            }, 10);
          }
        }),
        controller.signal,
        true,
        false,
      );
      expectRetryStopNotRefused(res.error);
      expect(launches).toHaveLength(2);
      const firstPid = launches[0]!.pid;
      const retryPid = launches[1]!.pid;
      expect(res).toEqual(abortedResult(true));
      expect(kills.sent.filter((s) => s.pid === firstPid)).toEqual([]);
      const sigtermTargets = kills.sent.filter((s) => s.signal === "SIGTERM").map((s) => s.pid);
      expect([...new Set(sigtermTargets)]).toEqual([retryPid]);
      expect(sentDuringAbort).toEqual([{ pid: retryPid, signal: "SIGTERM" }]);
      expect(await waitForExit(retryPid)).toBe(true);
      expect(readServerPid(KEY, resolved)).toBeNull();
      expect(readServerState(KEY, resolved)).toBeNull();
      expect(kills.nonPositive).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T13 abort raised in the retry event after the first launch exited: the dead first pid is never signalled",
    async () => {
      useArgvFakeBinary();
      const controller = new AbortController();
      const firstAliveAtRetry: boolean[] = [];
      const abortDispatches: SentSignal[][] = [];
      let killedFirst = false;
      const res = await start(
        (e) => {
          if (e.type === "waiting" && launches.length === 1 && !killedFirst) {
            killedFirst = true;
            // The first poll's liveness check then finds the first pid gone ("exited").
            realKill(launches[0]!.pid, "SIGKILL");
          }
          if (e.type !== "retry") return;
          firstAliveAtRetry.push(isAlive(launches[0]!.pid));
          // Another process now holds the dead first pid's number: a handler still
          // armed here would see it alive and SIGTERM it.
          kills.mode = "swallow";
          kills.simulateRecycled = true;
          abortDispatches.push(abortCapturing(controller));
          // The retry's stopServer then sees the real dead pid and clears the record.
          kills.mode = "forward";
          kills.simulateRecycled = false;
        },
        controller.signal,
        true,
        false,
      );
      // Premise: the first launch died (and was reaped) before the retry event.
      expect(firstAliveAtRetry).toEqual([false]);
      // R2b: the handler is disarmed before the retry event, so abort() signals nothing.
      expect(abortDispatches).toEqual([[]]);
      // R3: the abort seen once the stop cleared the dead record prevents the relaunch.
      expect(launches).toHaveLength(1);
      expect(res).toEqual(abortedResult(true));
      expect(readServerPid(KEY, resolved)).toBeNull();
      expect(readServerState(KEY, resolved)).toBeNull();
      expect(kills.nonPositive).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T14 abort during the retry poll after the retry pid died: nothing is signalled and both files go",
    async () => {
      useArgvFakeBinary();
      const controller = new AbortController();
      writeThroughputProfile();
      const retryAliveAtAbort: boolean[] = [];
      const abortDispatches: SentSignal[][] = [];
      let scheduled = false;
      const res = await start(
        (e) => {
          if (e.type === "waiting" && launches.length === 2 && !scheduled) {
            scheduled = true;
            const retryPid = launches[1]!.pid;
            // Both land in the retry poll's 1 s sleep: the retry pid dies, then the caller aborts.
            setTimeout(() => {
              realKill(retryPid, "SIGKILL");
            }, 10);
            setTimeout(() => {
              retryAliveAtAbort.push(isAlive(retryPid));
              abortDispatches.push(abortCapturing(controller));
            }, 300);
          }
        },
        controller.signal,
        false,
      );
      expect(launches).toHaveLength(2);
      // Premise: the retry pid was dead (and reaped) when abort() ran.
      expect(retryAliveAtAbort).toEqual([false]);
      expect(res).toEqual({ ...abortedResult(true), tunedProfile: "throughput" });
      // The retry pid is dead and nothing else is targeted: abort() signals nothing.
      expect(abortDispatches).toEqual([[]]);
      // R1b: the aborted branch removes both files whether or not the pid is alive.
      expect(readServerPid(KEY, resolved)).toBeNull();
      expect(readServerState(KEY, resolved)).toBeNull();
      expect(kills.nonPositive).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T15 default-resolved seam-free retry: the retry's pair records the env-default binary, host and port",
    async () => {
      // No identity, endpoint or binary option: the launch takes its binary from
      // LLAMA_CPP_BIN and its host and port from the env defaults.
      const binDir = join(temp.devStorage, "bin");
      mkdirSync(binDir, { recursive: true });
      useArgvFakeBinary(join(binDir, "llama-server"));
      process.env = {
        ...process.env,
        LLAMA_CPP_HOST: "127.0.0.1",
        LLAMA_CPP_PORT: String(PORT),
        LLAMA_CPP_BIN: binDir,
      };
      resolved = resolveEnv();
      const expected = (pid: number): Omit<ServerState, "startedAt"> => ({
        ...expectedState(pid),
        binary: join(binDir, "llama-server"),
        host: "127.0.0.1",
        port: String(PORT),
      });
      const timeoutPids: number[] = [];
      const firstStates: (ServerState | null)[] = [];
      const duringRetryPoll: {
        pid: number | null;
        state: Omit<ServerState, "startedAt"> | null;
        startedAt: string | null;
      }[] = [];
      const res = await startServer({
        key: KEY,
        target: "current",
        resolved,
        extraArgs,
        timeoutSeconds: 1,
        skipTuned: true,
        onEvent: recordingLaunches(
          waitingForArgvExec((e) => {
            if (e.type === "timeout") timeoutPids.push(e.pid);
            if (e.type !== "waiting") return;
            if (launches.length === 1 && firstStates.length === 0) {
              firstStates.push(readServerState(KEY, resolved));
            }
            if (launches.length === 2 && duringRetryPoll.length === 0) {
              const state = readServerState(KEY, resolved);
              duringRetryPoll.push({
                pid: readServerPid(KEY, resolved),
                state: withoutStartedAt(state),
                startedAt: state?.startedAt ?? null,
              });
            }
          }),
        ),
      });
      expectRetryStopNotRefused(res.error);
      expect(launches).toHaveLength(2);
      const firstPid = launches[0]!.pid;
      const retryPid = launches[1]!.pid;
      expect(res.ok).toBe(false);
      expect(res.retried).toBe(true);
      expect(res.error).toContain(TIMED_OUT);
      // The first launch recorded the resolved values; the retry's real stop stopped it.
      const firstState = firstStates[0] ?? null;
      expect(withoutStartedAt(firstState)).toEqual(expected(firstPid));
      expect(isAlive(firstPid)).toBe(false);
      // The retry's pair is on disk during its poll and records the same resolved values.
      const atRetryPoll = duringRetryPoll.map(({ pid, state }) => ({ pid, state }));
      expect(atRetryPoll).toEqual([{ pid: retryPid, state: expected(retryPid) }]);
      const retryStartedAt = duringRetryPoll[0]!.startedAt!;
      expect(Date.parse(retryStartedAt)).toBeGreaterThan(Date.parse(firstState!.startedAt));
      expect(readServerPid(KEY, resolved)).toBe(retryPid);
      expect(withoutStartedAt(readServerState(KEY, resolved))).toEqual(expected(retryPid));
      expect(timeoutPids).toEqual([retryPid]);
      expect(res.pid).toBe(retryPid);

      // No identity seam: the recorded binary path and model must match the real ps command line.
      const stop = await stopServer({ key: KEY, resolved, graceSeconds: 1 });
      expect(stop).toEqual({ stopped: true, pid: retryPid, killed: false });
      expect(await waitForExit(retryPid)).toBe(true);
      expect(readServerPid(KEY, resolved)).toBeNull();
      expect(readServerState(KEY, resolved)).toBeNull();
      expect(kills.nonPositive).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T16 seam-free abort during the first poll: the handler SIGTERMs the first pid and both files go",
    async () => {
      useArgvFakeBinary();
      const controller = new AbortController();
      const sentDuringAbort: SentSignal[] = [];
      let scheduled = false;
      const res = await start(
        (e) => {
          if (e.type === "waiting" && !scheduled) {
            scheduled = true;
            // Lands in the first poll's 1 s sleep; abort() runs its listeners synchronously.
            setTimeout(() => {
              sentDuringAbort.push(...abortCapturing(controller));
            }, 10);
          }
        },
        controller.signal,
        true,
        false,
      );
      expect(launches).toHaveLength(1);
      const firstPid = launches[0]!.pid;
      expect(res).toEqual(abortedResult(false));
      // R2a: the handler itself SIGTERMs the first pid during abort().
      expect(sentDuringAbort).toEqual([{ pid: firstPid, signal: "SIGTERM" }]);
      expect(await waitForExit(firstPid)).toBe(true);
      // R1b without the seam: the first-poll aborted branch removes both files.
      expect(readServerPid(KEY, resolved)).toBeNull();
      expect(readServerState(KEY, resolved)).toBeNull();
      expect(kills.nonPositive).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T17 abort during the first poll after the first pid died: both files go",
    async () => {
      useArgvFakeBinary();
      const controller = new AbortController();
      const aliveAtAbort: boolean[] = [];
      let scheduled = false;
      const res = await start((e) => {
        if (e.type === "waiting" && launches.length === 1 && !scheduled) {
          scheduled = true;
          const firstPid = launches[0]!.pid;
          // Both land in the first poll's 1 s sleep: the first pid dies, then the caller aborts.
          setTimeout(() => {
            realKill(firstPid, "SIGKILL");
          }, 10);
          setTimeout(() => {
            aliveAtAbort.push(isAlive(firstPid));
            controller.abort();
          }, 300);
        }
      }, controller.signal);
      expect(launches).toHaveLength(1);
      // Premise: the first pid was dead (and reaped) when abort() ran.
      expect(aliveAtAbort).toEqual([false]);
      expect(res).toEqual(abortedResult(false));
      // R1b: the first-poll aborted branch removes both files whether or not the pid is alive.
      expect(readServerPid(KEY, resolved)).toBeNull();
      expect(readServerState(KEY, resolved)).toBeNull();
      expect(kills.nonPositive).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T18 seam-free retry ready with a tuned profile: the result keeps it and no listener is left",
    async () => {
      useArgvFakeBinary();
      const controller = new AbortController();
      writeThroughputProfile();
      const res = await start(
        waitingForArgvExec((e) => {
          if (e.type === "launch" && launches.length === 2) healthy = true;
        }),
        controller.signal,
        false,
        false,
      );
      // R2e on the retry-ready return, which resolves from inside the retry.
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expectRetryStopNotRefused(res.error);
      expect(launches).toHaveLength(2);
      const retryPid = launches[1]!.pid;
      expect(res.ok).toBe(true);
      expect(res.retried).toBe(true);
      expect(res.pid).toBe(retryPid);
      // R5: the retry relaunches the first launch's exact argv with the safe-retry flags appended.
      expect(launches[1]!.argv).toBe(`${launches[0]!.argv} ${SAFE_RETRY_FLAGS}`);
      expect(res.tunedProfile).toBe("throughput");
      expect(readServerPid(KEY, resolved)).toBe(retryPid);
      expect(withoutStartedAt(readServerState(KEY, resolved))).toEqual({
        ...expectedState(retryPid),
        tunedProfile: "throughput",
      });

      kills.mode = "swallow";
      // A leftover listener would see the retry pid alive and SIGTERM it.
      kills.simulateRecycled = true;
      controller.abort();
      await sleep(50);
      expect(kills.sent).toEqual([]);
      expect(isAlive(retryPid)).toBe(true);
      expect(kills.nonPositive).toEqual([]);
      // afterEach restores the spies, then SIGKILLs the still-running server.
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T19 seam-free retry with allowExternalBind: the retry relaunches with the safe flags and does not throw",
    async () => {
      useArgvFakeBinary();
      // The workload binds externally; the endpoint, and so every /health probe, stays on the test host.
      extraArgs = [...extraArgs, "--host", "0.0.0.0"];
      const settled = await startServer({
        key: KEY,
        target: "current",
        resolved,
        binary,
        endpoint: { host: HOST, port: PORT },
        extraArgs,
        allowExternalBind: true,
        timeoutSeconds: 1,
        skipTuned: true,
        onEvent: recordingLaunches(waitingForArgvExec(() => undefined)),
      }).then(
        (res) => ({ res, error: null }),
        (error: unknown) => ({ res: null, error: String(error) }),
      );
      // R5: the retry launch keeps allowExternalBind, so its host-bind check does not throw.
      expect(settled.error).toBeNull();
      expectRetryStopNotRefused(settled.res?.error);
      expect(launches).toHaveLength(2);
      const firstPid = launches[0]!.pid;
      const retryPid = launches[1]!.pid;
      const res = settled.res!;
      expect(res.retried).toBe(true);
      // R5: the first launch's exact argv (with --host 0.0.0.0) and the safe-retry flags appended.
      expect(launches[1]!.argv).toBe(`${launches[0]!.argv} ${SAFE_RETRY_FLAGS}`);
      // The retry's real stop verified and stopped the first pid.
      expect(isAlive(firstPid)).toBe(false);
      expect(res.ok).toBe(false);
      expect(res.error).toContain(TIMED_OUT);
      expect(readServerPid(KEY, resolved)).toBe(retryPid);
      expect(withoutStartedAt(readServerState(KEY, resolved))).toEqual(expectedState(retryPid));
      expect(res.pid).toBe(retryPid);
      expect(kills.nonPositive).toEqual([]);
      // afterEach restores the spies, then SIGKILLs the still-running server.
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T20 concurrent seam-free starts: aborting one start never signals the other start's pid",
    async () => {
      useArgvFakeBinary();
      // Real signals, each recorded: a target shared across starts would SIGTERM B's pid.
      kills.mode = "record";
      // B has no mmproj args, so its first-attempt timeout leaves it running and tracked.
      const extraArgsB = ["--slot-save-path", "auto"];
      const controllerA = new AbortController();
      const controllerB = new AbortController();
      const pids = { a: 0, b: 0 };
      const startsB: Promise<StartServerResult>[] = [];
      const sentDuringAbort: SentSignal[] = [];
      let abortScheduled = false;
      const startB = (): Promise<StartServerResult> =>
        startServer({
          key: KEY_B,
          target: "current",
          resolved,
          binary,
          endpoint: { host: HOST, port: PORT_B },
          extraArgs: extraArgsB,
          timeoutSeconds: 1,
          skipTuned: true,
          signal: controllerB.signal,
          onEvent: recordingLaunches((e) => {
            if (e.type === "launch") pids.b = e.pid;
            if (e.type === "waiting" && !abortScheduled) {
              abortScheduled = true;
              // Lands in A's first-poll 1 s sleep while B is polling too.
              setTimeout(() => {
                sentDuringAbort.push(...abortCapturing(controllerA));
              }, 50);
            }
          }),
        });
      const resA = await start(
        (e) => {
          if (e.type === "launch") pids.a = e.pid;
          // Once A is polling, start B.
          if (e.type === "waiting" && startsB.length === 0) startsB.push(startB());
        },
        controllerA.signal,
        true,
        false,
      );
      expect(startsB).toHaveLength(1);
      const resB = await startsB[0]!;
      expect(launches).toHaveLength(2);
      expect(resA).toEqual(abortedResult(false));
      // R2f: A's abort reaches only A's pid; no non-zero signal ever targets B's pid.
      expect(kills.sent.filter((s) => s.pid === pids.b)).toEqual([]);
      expect(sentDuringAbort).toEqual([{ pid: pids.a, signal: "SIGTERM" }]);
      expect(await waitForExit(pids.a)).toBe(true);
      expect(getEventListeners(controllerB.signal, "abort")).toHaveLength(0);
      expect(resB.ok).toBe(false);
      expect(resB.retried).toBe(false);
      expect(resB.error).toContain(TIMED_OUT);
      expect(resB.pid).toBe(pids.b);
      expect(isAlive(pids.b)).toBe(true);
      expect(readServerPid(KEY_B, resolved)).toBe(pids.b);
      expect(withoutStartedAt(readServerState(KEY_B, resolved))).toEqual({
        ...expectedState(pids.b),
        extraArgs: extraArgsB,
        slotSavePath: join(temp.runtimeDir, "kvstore", "slots", KEY_B.name),
        port: String(PORT_B),
      });
      expect(kills.nonPositive).toEqual([]);

      // Clean B up: a seam-free stop matches its real command line.
      const stop = await stopServer({ key: KEY_B, resolved, graceSeconds: 1 });
      expect(stop).toEqual({ stopped: true, pid: pids.b, killed: false });
      expect(await waitForExit(pids.b)).toBe(true);
      expect(readServerPid(KEY_B, resolved)).toBeNull();
      expect(readServerState(KEY_B, resolved)).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "T21 slow-exec seam-free retry: the first waiting event waits for exec -a, so the retry's real stop stops the first pid",
    async () => {
      // #291: bash sleeps SLOW_EXEC_SECONDS before `exec -a`, past the first poll's 1 s.
      // Without the wait in the first `waiting` event, the retry's real ps read still sees
      // /bin/bash and the stop refuses with REFUSED_RETRY after one launch.
      useArgvFakeBinary(undefined, SLOW_EXEC_SECONDS);
      const timeoutPids: number[] = [];
      const res = await start(
        waitingForArgvExec((e) => {
          if (e.type === "timeout") timeoutPids.push(e.pid);
        }),
        undefined,
        true,
        false,
      );
      expectRetryStopNotRefused(res.error);
      expect(launches).toHaveLength(2);
      const firstPid = launches[0]!.pid;
      const retryPid = launches[1]!.pid;
      // Premise: each launch's first ps read still showed the pre-exec bash command line.
      expect(execPolls.get(firstPid)).toBeGreaterThan(1);
      expect(execPolls.get(retryPid)).toBeGreaterThan(1);
      expect(res.ok).toBe(false);
      expect(res.retried).toBe(true);
      expect(res.error).toContain(TIMED_OUT);
      // The retry's real stop verified and stopped the first pid.
      expect(isAlive(firstPid)).toBe(false);
      expect(timeoutPids).toEqual([retryPid]);
      expect(res.pid).toBe(retryPid);

      // No identity seam: the retry pid also waited for exec -a, so its real stop matches.
      const stop = await stopServer({ key: KEY, resolved, graceSeconds: 1 });
      expect(stop).toEqual({ stopped: true, pid: retryPid, killed: false });
      expect(await waitForExit(retryPid)).toBe(true);
      expect(kills.nonPositive).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
