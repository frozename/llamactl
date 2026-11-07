import { configSchema, type NodeClient } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runKeepAlive } from "../src/commands/keepAlive.js";
import { __resetTestSeams, __setTestSeams, resetGlobals, setGlobals } from "../src/dispatcher.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { captureProcessStreams, parseJsonRecord } from "./helpers.js";

const USAGE = `Usage: llamactl keep-alive <subcommand>

Subcommands:
  start <target> [--json]
      Launch a detached supervisor that keeps llama-server running,
      restarting it with exponential backoff (up to
      LLAMA_CPP_KEEP_ALIVE_MAX_BACKOFF seconds) when /health drops.
      Health is polled every LLAMA_CPP_KEEP_ALIVE_INTERVAL seconds
      (default 5).

  stop [--name <workload>] [--grace=<s>] [--json]
      If the supervisor PID verifies, write its stop file, wait up to
      <grace> seconds (default 10), SIGTERM it only if a final check
      still verifies it, and run the llama-server stop as a safety net;
      that result is not reported. If its PID cannot be verified at the
      first check or at the re-check right after the grace period,
      nothing is signalled, stop does not remove its tracking files, and
      --json reports stopped: false. If only the final check fails, the
      supervisor is not signalled, but the safety net still runs, both
      files are removed, and --json reports stopped: true.

  status [--json]
      Report whether the supervisor is running and print its last
      state snapshot (target / model / state / restarts / backoff).

  worker <target> [--interval=<s>] [--max-backoff=<s>]
      Internal entry point run by \`start\` inside a detached bun
      subprocess. Invoking this directly blocks until the stop file
      is written or the process is terminated.
`;

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_LOGS",
  "LLAMACTL_CONFIG",
] as const;

let tmpDir = "";
let runtimeDir = "";
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  tmpDir = mkdtempSync(join(tmpdir(), "llamactl-keepalive-cli-"));
  runtimeDir = join(tmpDir, "runtime");
  process.env["DEV_STORAGE"] = join(tmpDir, "dev-storage");
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  process.env["LLAMA_CPP_LOGS"] = join(tmpDir, "logs");
  process.env["LLAMACTL_CONFIG"] = join(tmpDir, "config", "llamactl.yaml");
  mkdirSync(runtimeDir, { recursive: true });
  __setTestSeams({ config: configSchema.freshConfig() });
  resetGlobals();
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
  rmSync(tmpDir, { recursive: true, force: true });
});

interface RecordedCall {
  proc: "keepAliveStart" | "keepAliveStop" | "keepAliveStatus";
  input: unknown;
}

function setupRemoteSeam(impl: {
  start?: (input: { target: string }) => Promise<unknown>;
  stop?: (input: { workload: string; graceSeconds: number }) => Promise<unknown>;
  status?: () => Promise<unknown>;
}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const cfg = configSchema.freshConfig();
  cfg.clusters[0]!.nodes.push({ name: "gpu1", endpoint: "https://gpu1.lan:7843" });
  const client = {
    keepAliveStart: {
      mutate: async (input: { target: string }): Promise<unknown> => {
        calls.push({ proc: "keepAliveStart", input });
        if (impl.start === undefined) return { ok: true, pid: 1 };
        return await impl.start(input);
      },
    },
    keepAliveStop: {
      mutate: async (input: { workload: string; graceSeconds: number }): Promise<unknown> => {
        calls.push({ proc: "keepAliveStop", input });
        if (impl.stop === undefined) return { stopped: true, pid: null, killed: false };
        return await impl.stop(input);
      },
    },
    keepAliveStatus: {
      query: async (...args: unknown[]): Promise<unknown> => {
        calls.push({ proc: "keepAliveStatus", input: args });
        if (impl.status === undefined) {
          return { running: false, pid: null, verdict: null, state: null };
        }
        return await impl.status();
      },
    },
  } as unknown as NodeClient;
  __setTestSeams({ config: cfg, nodeClient: client });
  setGlobals({ nodeName: "gpu1", contextName: null, configPath: null });
  return calls;
}

describe("keep-alive dispatch", () => {
  test("no subcommand prints USAGE to stdout and exits 1", async () => {
    const { result: code, stdout, stderr } = await captureProcessStreams(() => runKeepAlive([]));
    expect(code).toBe(1);
    expect(stdout).toBe(USAGE);
    expect(stderr).toBe("");
  });

  test("help, -h and --help print USAGE to stdout and exit 0", async () => {
    for (const args of [["help"], ["-h"], ["--help"]]) {
      const {
        result: code,
        stdout,
        stderr,
      } = await captureProcessStreams(() => runKeepAlive(args));
      expect(code).toBe(0);
      expect(stdout).toBe(USAGE);
      expect(stderr).toBe("");
    }
  });

  test("unknown subcommand writes the error and USAGE to stderr and exits 1", async () => {
    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["bogus"]));
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(`Unknown keep-alive subcommand: bogus\n\n${USAGE}`);
  });
});

describe("keep-alive flag refusals", () => {
  test("unknown --bogus flag exits 1 with zero node calls", async () => {
    const calls = setupRemoteSeam({});
    for (const sub of ["start", "status", "stop", "worker"]) {
      const {
        result: code,
        stdout,
        stderr,
      } = await captureProcessStreams(() => runKeepAlive([sub, "--bogus"]));
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toBe("Unknown flag: --bogus\n");
    }
    expect(calls).toStrictEqual([]);
  });

  test("start --help and worker --help print USAGE and exit 0", async () => {
    const calls = setupRemoteSeam({});
    for (const sub of ["start", "worker"]) {
      const {
        result: code,
        stdout,
        stderr,
      } = await captureProcessStreams(() => runKeepAlive([sub, "--help"]));
      expect(code).toBe(0);
      expect(stdout).toBe(USAGE);
      expect(stderr).toBe("");
    }
    expect(calls).toStrictEqual([]);
  });

  test("stop --name without a value exits 1", async () => {
    const calls = setupRemoteSeam({});
    for (const flag of ["--name", "--name="]) {
      const {
        result: code,
        stdout,
        stderr,
      } = await captureProcessStreams(() => runKeepAlive(["stop", flag]));
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toBe("keep-alive stop: --name requires a value\n");
    }
    expect(calls).toStrictEqual([]);
  });
});

describe("keep-alive start (remote)", () => {
  test("start qwen records target qwen and prints the pid line", async () => {
    const calls = setupRemoteSeam({ start: () => Promise.resolve({ ok: true, pid: 123 }) });
    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["start", "qwen"]));
    expect(code).toBe(0);
    expect(stdout).toBe("keep-alive started pid=123 target=qwen (remote)\n");
    expect(stderr).toBe("");
    expect(calls).toStrictEqual([{ proc: "keepAliveStart", input: { target: "qwen" } }]);
  });

  test("start with no positional sends target current", async () => {
    const calls = setupRemoteSeam({ start: () => Promise.resolve({ ok: true, pid: 7 }) });
    const { result: code, stdout } = await captureProcessStreams(() => runKeepAlive(["start"]));
    expect(code).toBe(0);
    expect(stdout).toBe("keep-alive started pid=7 target=current (remote)\n");
    expect(calls).toStrictEqual([{ proc: "keepAliveStart", input: { target: "current" } }]);
  });

  test("start ok:false with an error prints the error and exits 1", async () => {
    setupRemoteSeam({ start: () => Promise.resolve({ ok: false, error: "no model" }) });
    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["start", "qwen"]));
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("no model\n");
  });

  test("start ok:false without an error prints the fallback and exits 1", async () => {
    setupRemoteSeam({ start: () => Promise.resolve({ ok: false }) });
    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["start", "qwen"]));
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("keep-alive failed to start\n");
  });

  test("start --json prints the result payload and exits 1 when ok:false", async () => {
    setupRemoteSeam({ start: () => Promise.resolve({ ok: false }) });
    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["start", "qwen", "--json"]));
    expect(code).toBe(1);
    expect(stdout).toBe('{\n  "ok": false\n}\n');
    expect(stderr).toBe("");
  });

  test("start mutate rejection prints the remote failure and exits 1", async () => {
    setupRemoteSeam({ start: () => Promise.reject(new Error("boom")) });
    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["start", "qwen"]));
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("keep-alive start: remote call to 'gpu1' failed: boom\n");
  });
});

describe("keep-alive stop (remote)", () => {
  test("stop --name w1 --grace=3 sends workload and grace and prints the SIGTERM line", async () => {
    const calls = setupRemoteSeam({
      stop: () => Promise.resolve({ stopped: true, pid: 42, killed: true }),
    });
    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["stop", "--name", "w1", "--grace=3"]));
    expect(code).toBe(0);
    expect(stdout).toBe("stopped pid=42 (SIGTERM)\n");
    expect(stderr).toBe("");
    expect(calls).toStrictEqual([
      { proc: "keepAliveStop", input: { workload: "w1", graceSeconds: 3 } },
    ]);
  });

  test("stop --grace=0 and --grace=abc keep the default 10 second grace", async () => {
    const calls = setupRemoteSeam({});
    for (const graceArg of ["--grace=0", "--grace=abc"]) {
      const { result: code } = await captureProcessStreams(() =>
        runKeepAlive(["stop", "--name", "w1", graceArg]),
      );
      expect(code).toBe(0);
    }
    expect(calls).toStrictEqual([
      { proc: "keepAliveStop", input: { workload: "w1", graceSeconds: 10 } },
      { proc: "keepAliveStop", input: { workload: "w1", graceSeconds: 10 } },
    ]);
  });

  test("stop --name=w2 sends workload w2", async () => {
    const calls = setupRemoteSeam({});
    const { result: code } = await captureProcessStreams(() => runKeepAlive(["stop", "--name=w2"]));
    expect(code).toBe(0);
    expect(calls).toStrictEqual([
      { proc: "keepAliveStop", input: { workload: "w2", graceSeconds: 10 } },
    ]);
  });

  test("stop result with a null pid prints pid=none", async () => {
    setupRemoteSeam({
      stop: () => Promise.resolve({ stopped: true, pid: null, killed: false }),
    });
    const { result: code, stdout } = await captureProcessStreams(() =>
      runKeepAlive(["stop", "--name", "w1"]),
    );
    expect(code).toBe(0);
    expect(stdout).toBe("stopped pid=none\n");
  });

  test("stop mutate rejection prints the remote failure and exits 1", async () => {
    setupRemoteSeam({ stop: () => Promise.reject(new Error("boom")) });
    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["stop", "--name", "w1"]));
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("keep-alive stop: remote call to 'gpu1' failed: boom\n");
  });
});

describe("keep-alive status (remote)", () => {
  test("running status prints the human summary and exits 0", async () => {
    setupRemoteSeam({
      status: () =>
        Promise.resolve({
          running: true,
          pid: 77,
          verdict: "alive",
          state: { target: "current", state: "ready", restarts: 2 },
        }),
    });
    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["status"]));
    expect(code).toBe(0);
    expect(stdout).toBe(
      "keep-alive: running (pid=77)\n  target=current\n  state=ready\n  restarts=2\n",
    );
    expect(stderr).toBe("");
  });

  test("stopped status prints keep-alive: stopped and exits 1", async () => {
    setupRemoteSeam({
      status: () => Promise.resolve({ running: false, pid: null, verdict: null, state: null }),
    });
    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["status"]));
    expect(code).toBe(1);
    expect(stdout).toBe("keep-alive: stopped\n");
    expect(stderr).toBe("");
  });

  test("status --json echoes the result and exits 1 when not running", async () => {
    setupRemoteSeam({
      status: () => Promise.resolve({ running: false, pid: null, verdict: null, state: null }),
    });
    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["status", "--json"]));
    expect(code).toBe(1);
    expect(stdout).toBe(
      '{\n  "running": false,\n  "pid": null,\n  "verdict": null,\n  "state": null\n}\n',
    );
    expect(stderr).toBe("");
  });

  test("status query rejection prints the remote failure and exits 1", async () => {
    setupRemoteSeam({ status: () => Promise.reject(new Error("boom")) });
    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["status"]));
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("keep-alive status: remote call to 'gpu1' failed: boom\n");
  });
});

describe("keep-alive local", () => {
  test("status with an empty runtime dir prints stopped and exits 1", async () => {
    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["status"]));
    expect(code).toBe(1);
    expect(stdout).toBe("keep-alive: stopped\n");
    expect(stderr).toBe("");
  });

  test("status prints the state file fields and exits 1", async () => {
    writeFileSync(
      join(runtimeDir, "llama-keep-alive.state"),
      "target=current\nstate=ready\nrestarts=2\n",
    );
    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["status"]));
    expect(code).toBe(1);
    expect(stdout).toBe("keep-alive: stopped\n  target=current\n  state=ready\n  restarts=2\n");
    expect(stderr).toBe("");
  });

  test("stop without --name and no workloads exits 1", async () => {
    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["stop"]));
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("keep-alive stop: no live workloads; pass --name <workload>\n");
  });

  test("stop --name --json consumes the stop file and exits 0", async () => {
    const stopFile = join(runtimeDir, "llama-keep-alive.stop");
    writeFileSync(stopFile, "");
    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["stop", "--name", "w1", "--json"]));
    expect(code).toBe(0);
    expect(parseJsonRecord(stdout)).toStrictEqual({ stopped: true, pid: null, killed: false });
    expect(stderr).toBe("");
    expect(existsSync(stopFile)).toBe(false);
  });
});
