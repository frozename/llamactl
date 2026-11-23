// #806 phase 2 item B: `llamactl server start --restart` must reach the
// serverStart subscription as `restart: true`, a default invocation must omit
// the key entirely, and an adopted engine must render `(adopted)` in human
// output while --json preserves the flag on the result payload.

import { configSchema, type NodeClient } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runServer } from "../src/commands/server.js";
import { __resetTestSeams, __setTestSeams, resetGlobals, setGlobals } from "../src/dispatcher.js";
import { mkdirSync, mkdtempSync, rmSync } from "../src/safe-fs.js";
import { captureProcessStreams } from "./helpers.js";

const ENV_KEYS = [
  "LLAMACTL_WORKLOADS_DIR",
  "LLAMACTL_CONFIG",
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_MODELS",
  "LLAMA_CPP_BIN",
] as const;

type SubscribeHandlers = {
  onData: (e: unknown) => void;
  onError: (e: unknown) => void;
  onComplete: () => void;
  onStarted?: () => void;
};

// A NodeClient stub whose only live procedure is serverStart.subscribe: it
// records the input, then emits the canned done result on a microtask (the
// subscribeRemote promise must finish wiring handlers first). The Proxy cast
// mirrors proxyFromCaller in remote's node-client.
function startClient(inputs: unknown[], result: Record<string, unknown>): NodeClient {
  return new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (prop !== "serverStart") return undefined;
        return {
          subscribe: (input: unknown, handlers: SubscribeHandlers): { unsubscribe: () => void } => {
            inputs.push(input);
            queueMicrotask(() => {
              handlers.onData({ type: "done", result });
              handlers.onComplete();
            });
            return {
              unsubscribe(): void {
                return;
              },
            };
          },
        };
      },
    },
  ) as NodeClient;
}

const START_RESULT = {
  ok: true,
  pid: 4242,
  endpoint: "http://127.0.0.1:18080",
  advertisedEndpoint: "http://127.0.0.1:18080",
  tunedProfile: null,
  retried: false,
};

const ADOPTED_RESULT = { ...START_RESULT, adopted: true };

let tmp = "";
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-server-start-"));
  for (const dir of ["workloads", "models", "runtime", "bin", "dev"]) {
    mkdirSync(join(tmp, dir), { recursive: true });
  }
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: join(tmp, "workloads"),
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
    DEV_STORAGE: join(tmp, "dev"),
    LOCAL_AI_RUNTIME_DIR: join(tmp, "runtime"),
    LLAMA_CPP_MODELS: join(tmp, "models"),
    LLAMA_CPP_BIN: join(tmp, "bin"),
  });
});

afterEach(() => {
  __resetTestSeams();
  resetGlobals();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

function setup(inputs: unknown[], result: Record<string, unknown>): void {
  const cfg = configSchema.freshConfig();
  cfg.clusters[0]!.nodes.push({ name: "gpu1", endpoint: "https://gpu1.lan:7843" });
  __setTestSeams({ config: cfg, nodeClient: startClient(inputs, result) });
  setGlobals({ nodeName: "gpu1", contextName: null, configPath: null });
}

describe("llamactl server start --restart (#806 phase 2)", () => {
  test("--restart reaches serverStart as restart:true", async () => {
    const inputs: unknown[] = [];
    setup(inputs, START_RESULT);
    const { result: code } = await captureProcessStreams(() =>
      runServer(["start", "--name", "wl", "--restart", "Demo/demo.gguf"]),
    );
    expect(code).toBe(0);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual({
      workload: "wl",
      target: "Demo/demo.gguf",
      restart: true,
    });
  });

  test("a default start omits the restart key entirely", async () => {
    const inputs: unknown[] = [];
    setup(inputs, START_RESULT);
    const { result: code } = await captureProcessStreams(() =>
      runServer(["start", "--name", "wl", "Demo/demo.gguf"]),
    );
    expect(code).toBe(0);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual({ workload: "wl", target: "Demo/demo.gguf" });
  });

  test("an adopted start renders (adopted); a fresh launch does not", async () => {
    const adoptedInputs: unknown[] = [];
    setup(adoptedInputs, ADOPTED_RESULT);
    const adopted = await captureProcessStreams(() =>
      runServer(["start", "--name", "wl", "Demo/demo.gguf"]),
    );
    expect(adopted.result).toBe(0);
    expect(adopted.stdout).toContain("(adopted)");
    expect(adopted.stdout).toContain("pid=4242");

    const freshInputs: unknown[] = [];
    setup(freshInputs, START_RESULT);
    const fresh = await captureProcessStreams(() =>
      runServer(["start", "--name", "wl", "Demo/demo.gguf"]),
    );
    expect(fresh.result).toBe(0);
    expect(fresh.stdout).not.toContain("(adopted)");
    expect(fresh.stdout).toContain("pid=4242");
  });

  test("--json preserves adopted:true on the result payload", async () => {
    const inputs: unknown[] = [];
    setup(inputs, ADOPTED_RESULT);
    const { result: code, stdout } = await captureProcessStreams(() =>
      runServer(["start", "--name", "wl", "--json", "Demo/demo.gguf"]),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed["adopted"]).toBe(true);
    expect(parsed["pid"]).toBe(4242);
  });
});
