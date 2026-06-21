import { configSchema, type NodeClient } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runServer } from "../src/commands/server.js";
import { __resetTestSeams, __setTestSeams, resetGlobals, setGlobals } from "../src/dispatcher.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

const origStderrWrite = process.stderr.write.bind(process.stderr);
const origStdoutWrite = process.stdout.write.bind(process.stdout);

let stderrChunks: string[] = [];
let stdoutChunks: string[] = [];
let tmpRuntimeDir = "";
let savedRuntime: string | undefined;

beforeEach(() => {
  stderrChunks = [];
  stdoutChunks = [];
  tmpRuntimeDir = mkdtempSync(join(tmpdir(), "llamactl-server-test-"));
  savedRuntime = process.env.LOCAL_AI_RUNTIME_DIR;
  process.env.LOCAL_AI_RUNTIME_DIR = tmpRuntimeDir;
  __setTestSeams({ config: configSchema.freshConfig() });
  process.stderr.write = (chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
    if (typeof chunk === "string") stderrChunks.push(chunk);
    return true;
  };
  process.stdout.write = (chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
    if (typeof chunk === "string") stdoutChunks.push(chunk);
    return true;
  };
});

afterEach(() => {
  process.stderr.write = origStderrWrite;
  process.stdout.write = origStdoutWrite;
  __resetTestSeams();
  resetGlobals();
  rmSync(tmpRuntimeDir, { recursive: true, force: true });
  if (savedRuntime === undefined) delete process.env.LOCAL_AI_RUNTIME_DIR;
  else process.env.LOCAL_AI_RUNTIME_DIR = savedRuntime;
});

describe("server stop: positional arg rejection", () => {
  test("bare positional exits 1 with unexpected-argument error", async () => {
    const code = await runServer(["stop", "old-name"]);
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("Unexpected argument 'old-name'");
  });

  test("does not reach workload resolution when positional is given", async () => {
    const code = await runServer(["stop", "wrong-name"]);
    expect(code).toBe(1);
    const stderr = stderrChunks.join("");
    expect(stderr).toContain("Unexpected argument 'wrong-name'");
    expect(stderr).not.toContain("server stop:");
  });

  test("--name flag passes the parser and reaches workload resolution", async () => {
    await runServer(["stop", "--name", "my-workload"]);
    expect(stderrChunks.join("")).not.toContain("Unexpected argument");
  });
});

describe("server status: positional arg rejection", () => {
  test("bare positional exits 1 with unexpected-argument error", async () => {
    const code = await runServer(["status", "some-workload"]);
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("Unexpected argument 'some-workload'");
  });
});

describe("server logs: positional arg rejection", () => {
  test("bare positional exits 1 with unexpected-argument error", async () => {
    const code = await runServer(["logs", "some-workload"]);
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("Unexpected argument 'some-workload'");
  });
});

describe("server logs: remote subscription exit codes", () => {
  type LogHandlers = {
    onData: (e: unknown) => void;
    onError: (e: unknown) => void;
    onComplete: () => void;
  };

  function makeRemoteSeams(subscribeBehavior: (handlers: LogHandlers) => void): void {
    const cfg = configSchema.freshConfig();
    cfg.clusters[0]!.nodes.push({ name: "gpu1", endpoint: "https://gpu1.lan:7843" });
    const mockClient = {
      serverLogs: {
        subscribe: (_input: unknown, handlers: LogHandlers) => {
          // Defer so the Promise constructor finishes and all locals (cleanup,
          // abort) are initialized before any handler fires — mirrors real async
          // tRPC subscriptions.
          queueMicrotask(() => {
            subscribeBehavior(handlers);
          });
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          return { unsubscribe: (): void => {} };
        },
      },
    } as unknown as NodeClient;
    __setTestSeams({ config: cfg, nodeClient: mockClient });
    setGlobals({ nodeName: "gpu1", contextName: null, configPath: null });
  }

  test("exits 1 when remote serverLogs subscription fails", async () => {
    makeRemoteSeams((h) => {
      h.onError(new Error("connection refused"));
    });
    const code = await runServer(["logs", "--name", "foo"]);
    expect(code).toBe(1);
    const stderr = stderrChunks.join("");
    expect(stderr).toContain("server logs:");
    expect(stderr).toContain("connection refused");
  });

  test("exits 0 on clean subscription completion", async () => {
    makeRemoteSeams((h) => {
      h.onComplete();
    });
    const code = await runServer(["logs", "--name", "foo"]);
    expect(code).toBe(0);
  });
});
