/**
 * #520 — RED tests for local `llamactl keep-alive stop` dispatch. At the
 * pinned base the CLI short-circuits local dispatch to core stopKeepAlive,
 * bypassing the in-process keepAliveStop procedure and its session/lease
 * fence; it also forwards an unbounded --grace to remote nodes. Hermetic:
 * temp runtime dirs, stale pid records whose owner has exited, and fake or
 * in-process node clients only.
 */
import { createResidencyLeases, setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import {
  createSessionRefcounts,
  type SessionRefcounts,
  setSessionRefcountRegistry,
} from "@llamactl/core/residency/sessions";
import { type Config, configSchema, type NodeClient } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runKeepAlive } from "../src/commands/keepAlive.js";
import { __resetTestSeams, __setTestSeams, resetGlobals, setGlobals } from "../src/dispatcher.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { captureProcessStreams, parseJsonRecord, requireRecordField } from "./helpers.js";

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_LOGS",
  "LLAMACTL_CONFIG",
  "LLAMACTL_WORKLOADS_DIR",
] as const;

let tmpDir = "";
let runtimeDir = "";
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  tmpDir = mkdtempSync(join(tmpdir(), "llamactl-keepalive-stop-local-fence-"));
  runtimeDir = join(tmpDir, "runtime");
  process.env["DEV_STORAGE"] = join(tmpDir, "dev-storage");
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  process.env["LLAMA_CPP_LOGS"] = join(tmpDir, "logs");
  process.env["LLAMACTL_CONFIG"] = join(tmpDir, "config", "llamactl.yaml");
  process.env["LLAMACTL_WORKLOADS_DIR"] = join(tmpDir, "workloads");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(join(tmpDir, "workloads"), { recursive: true });
  __setTestSeams({ config: configSchema.freshConfig() });
  resetGlobals();
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const val = savedEnv[key];
    if (val === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = val;
    }
  }
  __resetTestSeams();
  resetGlobals();
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

type StopInput = { workload: string; graceSeconds: number };
type StopImpl = (input: StopInput) => Promise<unknown>;

function keepAlivePidFile(): string {
  return join(runtimeDir, "llama-keep-alive.pid");
}

// The recorded pid belongs to a child that already exited: core stopKeepAlive
// reads the record as dead/reused and unlinks it, so a surviving file proves
// the core stop never ran.
function writeStaleRecord(): void {
  const dead = Bun.spawnSync(["true"]);
  writeFileSync(keepAlivePidFile(), `${String(dead.pid)}\n`);
}

function installRecordingNodeClient(cfg: Config, impl?: StopImpl): StopInput[] {
  const calls: StopInput[] = [];
  const client = {
    keepAliveStop: {
      mutate: async (input: StopInput): Promise<unknown> => {
        calls.push({ ...input });
        if (impl === undefined) return { stopped: true, pid: null, killed: false };
        return await impl(input);
      },
    },
  } as unknown as NodeClient;
  __setTestSeams({ config: cfg, nodeClient: client });
  return calls;
}

function setupLocalSeam(impl?: StopImpl): StopInput[] {
  return installRecordingNodeClient(configSchema.freshConfig(), impl);
}

function setupRemoteSeam(impl?: StopImpl): StopInput[] {
  const cfg = configSchema.freshConfig();
  cfg.clusters[0]!.nodes.push({ name: "gpu1", endpoint: "https://gpu1.lan:7843" });
  const calls = installRecordingNodeClient(cfg, impl);
  setGlobals({ nodeName: "gpu1", contextName: null, configPath: null });
  return calls;
}

function bindIdleSession(sessions: SessionRefcounts): void {
  const acquired = sessions.acquire("s1", "w1");
  if (!acquired.ok) {
    throw new Error("expected session acquire to succeed");
  }
  sessions.release("s1", acquired.generation);
}

function installActiveSession(): SessionRefcounts {
  setResidencyLeaseRegistry(createResidencyLeases());
  const sessions = createSessionRefcounts({ idleTimeoutMs: 60_000 });
  setSessionRefcountRegistry(sessions);
  bindIdleSession(sessions);
  writeStaleRecord();
  return sessions;
}

describe("keep-alive stop local session fence (#520)", () => {
  test("L1: local dispatch goes through the node client", async () => {
    // Kills: the local core short-circuit — at base the seam is bypassed and
    // calls stays empty even though the printed result looks successful.
    const calls = setupLocalSeam();

    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["stop", "--name", "w1", "--grace=3"]));

    expect(calls).toStrictEqual([{ workload: "w1", graceSeconds: 3 }]);
    expect(code).toBe(0);
    expect(stdout).toBe("stopped pid=none\n");
    expect(stderr).toBe("");
  });

  test("L2: a local idle-bound session refuses the stop as SessionsActive", async () => {
    // Kills: bypassing the in-process procedure's fence, and any fence that
    // releases the session instead of refusing the stop.
    const sessions = installActiveSession();

    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["stop", "--name", "w1"]));

    expect(code).toBe(1);
    expect(stderr).toBe(
      "keep-alive stop: node local refused to stop w1 (SessionsActive: s1); nothing was stopped\n",
    );
    expect(stdout).toBe("");
    expect(existsSync(keepAlivePidFile())).toBe(true);
    expect(sessions.activeSessions("w1")).toEqual(["s1"]);
  });

  test("L3: a throwing local session registry refuses as SessionsUnknown", async () => {
    // Kills: a fail-open registry-error path — at base core stopKeepAlive
    // runs without consulting the registry at all.
    const sessions = installActiveSession();
    sessions.checkUnload = (): never => {
      throw new Error("boom");
    };

    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["stop", "--name", "w1"]));

    expect(code).toBe(1);
    expect(stderr).toBe(
      "keep-alive stop: node local refused to stop w1 (SessionsUnknown); nothing was stopped\n",
    );
    expect(stdout).toBe("");
    expect(existsSync(keepAlivePidFile())).toBe(true);
  });

  test("L4: local --json prints the refusal payload and exits 1", async () => {
    // Kills: a local dispatch path that reports the raw unfenced stop payload
    // as success under --json.
    installActiveSession();

    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["stop", "--name", "w1", "--json"]));

    expect(code).toBe(1);
    const parsed = parseJsonRecord(stdout);
    expect(parsed["stopped"]).toBe(false);
    expect(requireRecordField(parsed, "refused")).toStrictEqual({
      reason: "SessionsActive",
      active: ["s1"],
    });
    expect(stderr).toBe("");
  });

  test("L5: a local node-client failure uses the local failure wording", async () => {
    // Kills: keeping the remote-only error wording for the in-process local
    // client — and the base path that never consults the client at all.
    setupLocalSeam(() => Promise.reject(new Error("boom")));

    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["stop", "--name", "w1"]));

    expect(code).toBe(1);
    expect(stderr).toBe("keep-alive stop: call to 'local' failed: boom\n");
    expect(stdout).toBe("");
  });

  test("L6: local --grace above the procedure cap is refused before dispatch", async () => {
    // Kills: validating only inside the router or not at all — the client
    // must not be called, and the stale record must not be reaped.
    const calls = setupLocalSeam();
    writeStaleRecord();

    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["stop", "--name", "w1", "--grace=61"]));

    expect(code).toBe(1);
    expect(stderr).toBe("keep-alive stop: --grace must be between 1 and 60\n");
    expect(stdout).toBe("");
    expect(calls).toStrictEqual([]);
    expect(existsSync(keepAlivePidFile())).toBe(true);
  });

  test("L7: remote --grace above the procedure cap is refused before dispatch", async () => {
    // Kills: forwarding an out-of-range value to the agent — at base the fake
    // records graceSeconds 120 and the command exits 0.
    const calls = setupRemoteSeam();

    const { result: code, stderr } = await captureProcessStreams(() =>
      runKeepAlive(["stop", "--name", "w1", "--grace=120"]),
    );

    expect(code).toBe(1);
    expect(stderr).toBe("keep-alive stop: --grace must be between 1 and 60\n");
    expect(calls).toStrictEqual([]);
  });

  test("G1: an unfenced local stop still reaps a stale record", async () => {
    // GUARD — passes at base and post-fix: with no registries installed, the
    // observable unfenced stop result stays byte-identical.
    writeStaleRecord();

    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["stop", "--name", "w1"]));

    expect(code).toBe(0);
    expect(stdout).toBe("stopped pid=none\n");
    expect(stderr).toBe("");
    expect(existsSync(keepAlivePidFile())).toBe(false);
  });

  test("G2: remote grace values at or below the cap keep existing parsing", async () => {
    // GUARD — passes at base and post-fix: 60 is valid, while 0 and non-numeric
    // input retain the existing default of 10.
    const calls = setupRemoteSeam();

    for (const graceArg of ["--grace=60", "--grace=0", "--grace=abc"]) {
      const { result: code } = await captureProcessStreams(() =>
        runKeepAlive(["stop", "--name", "w1", graceArg]),
      );
      expect(code).toBe(0);
    }

    expect(calls).toStrictEqual([
      { workload: "w1", graceSeconds: 60 },
      { workload: "w1", graceSeconds: 10 },
      { workload: "w1", graceSeconds: 10 },
    ]);
  });
});
