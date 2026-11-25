/**
 * #520 — RED tests for `llamactl keep-alive stop` stop-fence refusal
 * reporting. At the pinned base `runStop` prints `stopped pid=…` and exits 0
 * for every node result, so a fenced refusal
 * (`{ stopped: false, refused: { reason, active } }`) reads as a successful
 * stop. Post-fix `runStop` routes the result through
 * `keepAliveStopRefusalLine`: a refusal prints
 * `keep-alive stop: node <node> refused to stop <workload> (<reason>: <ids>);
 * nothing was stopped` on stderr (the `: <ids>` part dropped when the id list
 * is empty) and exits 1; `--json` still prints the result payload but also
 * exits 1. Hermetic: the remote seam fakes `keepAliveStop.mutate`, no node,
 * no processes, no sleeps. Every RED case fails BY ASSERTION at base — never
 * by import, type or exit code.
 */
import { configSchema, type NodeClient } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runKeepAlive } from "../src/commands/keepAlive.js";
import { __resetTestSeams, __setTestSeams, resetGlobals, setGlobals } from "../src/dispatcher.js";
import { mkdirSync, mkdtempSync, rmSync } from "../src/safe-fs.js";
import { captureProcessStreams, parseJsonRecord, requireRecordField } from "./helpers.js";

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_LOGS",
  "LLAMACTL_CONFIG",
] as const;

let tmpDir = "";
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  tmpDir = mkdtempSync(join(tmpdir(), "llamactl-keepalive-stop-refusal-"));
  const runtimeDir = join(tmpDir, "runtime");
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

describe("keep-alive stop fence refusal reporting (#520)", () => {
  test("R4: a SessionsActive refusal prints the refusal line and exits 1", async () => {
    // Kills: runStop ignoring `refused` — at base it prints
    // `stopped pid=none` and exits 0, reporting a fenced refusal as a
    // successful stop.
    setupRemoteSeam({
      stop: () =>
        Promise.resolve({
          stopped: false,
          pid: null,
          killed: false,
          refused: { reason: "SessionsActive", active: ["s1"] },
        }),
    });

    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["stop", "--name", "w1"]));

    expect(code).toBe(1);
    expect(stderr).toBe(
      "keep-alive stop: node gpu1 refused to stop w1 (SessionsActive: s1); nothing was stopped\n",
    );
    expect(stdout).toBe("");
  });

  test("R5: a SessionsUnknown refusal drops the empty id list", async () => {
    // Kills: always appending `: ` and the ids — an empty active list must
    // render `(SessionsUnknown)`, not `(SessionsUnknown: )`.
    setupRemoteSeam({
      stop: () =>
        Promise.resolve({
          stopped: false,
          pid: null,
          killed: false,
          refused: { reason: "SessionsUnknown", active: [] },
        }),
    });

    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["stop", "--name", "w1"]));

    expect(code).toBe(1);
    expect(stderr).toBe(
      "keep-alive stop: node gpu1 refused to stop w1 (SessionsUnknown); nothing was stopped\n",
    );
    expect(stdout).toBe("");
  });

  test("R6: --json prints the refusal payload and exits 1", async () => {
    // Kills: --json returning 0 on a refusal — the payload already carries
    // `refused`, so only the exit code pins the failure.
    setupRemoteSeam({
      stop: () =>
        Promise.resolve({
          stopped: false,
          pid: null,
          killed: false,
          refused: { reason: "LeasesActive", active: ["lease-1"] },
        }),
    });

    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["stop", "--name", "w1", "--json"]));

    expect(code).toBe(1);
    const parsed = parseJsonRecord(stdout);
    expect(parsed["stopped"]).toBe(false);
    expect(requireRecordField(parsed, "refused")).toMatchObject({
      reason: "LeasesActive",
      active: ["lease-1"],
    });
    expect(stderr).toBe("");
  });

  test("G3: an unrefused stop result prints the pid line and exits 0", async () => {
    // GUARD — passes at base and post-fix: pins that a plain stop result is
    // reported exactly as before.
    setupRemoteSeam({
      stop: () => Promise.resolve({ stopped: true, pid: null, killed: false }),
    });

    const {
      result: code,
      stdout,
      stderr,
    } = await captureProcessStreams(() => runKeepAlive(["stop", "--name", "w1"]));

    expect(code).toBe(0);
    expect(stdout).toBe("stopped pid=none\n");
    expect(stderr).toBe("");
  });
});
