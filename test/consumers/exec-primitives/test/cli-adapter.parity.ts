import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCliSubprocessProvider,
  type SpawnFn,
  type SpawnStreamFn,
} from "../../../../packages/remote/src/index.ts";
import { librarySpawn, librarySpawnStream } from "../src/library-spawn.ts";

type CliProviderOptions = Parameters<typeof createCliSubprocessProvider>[0];
type CliBinding = CliProviderOptions["binding"];
type AiProvider = ReturnType<typeof createCliSubprocessProvider>;
type UnifiedAiRequest = Parameters<AiProvider["createResponse"]>[0];
type ProviderExecutionContext = NonNullable<Parameters<AiProvider["createResponse"]>[1]>;
type StreamReturn = ReturnType<NonNullable<AiProvider["streamResponse"]>>;
type UnifiedStreamEvent = StreamReturn extends AsyncIterable<infer T> ? T : never;

function makeBinding(overrides: Partial<CliBinding> = {}): CliBinding {
  return {
    name: "fake-cli",
    preset: "custom",
    command: "/bin/sh",
    args: [],
    format: "text",
    timeoutMs: 5_000,
    advertisedModels: [],
    capabilities: ["reasoning"],
    ...overrides,
  };
}

function sleepyScript(pidFile: string): string {
  return `echo $$ > ${pidFile}; exec sleep 30`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor: condition not met");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let tmp = "";
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-parity-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const minimalReq: UnifiedAiRequest = {
  model: "fake-model",
  messages: [{ role: "user", content: "hi" }],
};

function sleepyProvider(
  pidFile: string,
  entries: unknown[],
  overrides: Partial<CliBinding> = {},
): AiProvider {
  return createCliSubprocessProvider({
    agentName: "mac-mini",
    binding: makeBinding({
      args: ["-c", sleepyScript(pidFile)],
      timeoutMs: 60_000,
      ...overrides,
    }),
    spawn: librarySpawn,
    spawnStream: librarySpawnStream,
    journalWrite: async (e) => {
      await Promise.resolve();
      entries.push(e);
    },
  });
}

function streamBinding(script: string, timeoutMs = 60_000): CliBinding {
  return {
    name: "claude-pro",
    preset: "claude",
    command: "/bin/sh",
    args: ["-c", script],
    format: "text",
    timeoutMs,
    advertisedModels: [],
    capabilities: ["reasoning"],
  };
}

function streamProvider(script: string, entries: unknown[], timeoutMs = 60_000): AiProvider {
  return createCliSubprocessProvider({
    agentName: "mac-mini",
    binding: streamBinding(script, timeoutMs),
    spawn: librarySpawn,
    spawnStream: librarySpawnStream,
    journalWrite: async (e) => {
      await Promise.resolve();
      entries.push(e);
    },
  });
}

async function collect(iter: AsyncIterable<UnifiedStreamEvent>): Promise<UnifiedStreamEvent[]> {
  const events: UnifiedStreamEvent[] = [];
  for await (const e of iter) events.push(e);
  return events;
}

function normalizeEntry(entry: unknown): Record<string, unknown> {
  const { ts: _ts, latency_ms: _latency_ms, ...rest } = entry as Record<string, unknown>;
  return rest;
}

describe("createResponse — ProviderExecutionContext", () => {
  test("caller abort kills the real child and rejects AbortError", async () => {
    const pidFile = join(tmp, "pid-abort");
    const entries: unknown[] = [];
    const provider = sleepyProvider(pidFile, entries);
    const caller = new AbortController();
    const pending = provider.createResponse(minimalReq, { signal: caller.signal });
    await waitFor(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pidAlive(pid)).toBe(true);

    caller.abort();
    let thrown: unknown;
    try {
      await pending;
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).name).toBe("AbortError");
    await waitFor(() => !pidAlive(pid));
    expect(entries).toHaveLength(1);
    expect((entries[0] as Record<string, unknown>)["error_code"]).toBe("aborted");
    expect((entries[0] as Record<string, unknown>)["ok"]).toBe(false);
  });

  test("context deadline ahead of binding timeout rejects TimeoutError and kills the child", async () => {
    const pidFile = join(tmp, "pid-deadline");
    const entries: unknown[] = [];
    const provider = sleepyProvider(pidFile, entries);
    const pending = provider.createResponse(minimalReq, { deadline: Date.now() + 150 });
    await waitFor(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8").trim());

    let thrown: unknown;
    try {
      await pending;
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).name).toBe("TimeoutError");
    await waitFor(() => !pidAlive(pid));
    expect(entries).toHaveLength(1);
    expect((entries[0] as Record<string, unknown>)["error_code"]).toBe("deadline");
  });

  test("already-aborted signal rejects AbortError without spawning or journalling", async () => {
    const pidFile = join(tmp, "pid-preaborted");
    const entries: unknown[] = [];
    let spawnCalls = 0;
    const countingSpawn: SpawnFn = async (argv, opts) => {
      spawnCalls++;
      return librarySpawn(argv, opts);
    };
    const provider = createCliSubprocessProvider({
      agentName: "mac-mini",
      binding: makeBinding({ args: ["-c", sleepyScript(pidFile)], timeoutMs: 60_000 }),
      spawn: countingSpawn,
      spawnStream: librarySpawnStream,
      journalWrite: async (e) => {
        await Promise.resolve();
        entries.push(e);
      },
    });
    let thrown: unknown;
    try {
      await provider.createResponse(minimalReq, { signal: AbortSignal.abort() });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).name).toBe("AbortError");
    expect(existsSync(pidFile)).toBe(false);
    expect(entries).toHaveLength(0);
    expect(spawnCalls).toBe(0);
  });

  test("past deadline rejects TimeoutError without spawning or journalling", async () => {
    const pidFile = join(tmp, "pid-pastdeadline");
    const entries: unknown[] = [];
    let spawnCalls = 0;
    const countingSpawn: SpawnFn = async (argv, opts) => {
      spawnCalls++;
      return librarySpawn(argv, opts);
    };
    const provider = createCliSubprocessProvider({
      agentName: "mac-mini",
      binding: makeBinding({ args: ["-c", sleepyScript(pidFile)], timeoutMs: 60_000 }),
      spawn: countingSpawn,
      spawnStream: librarySpawnStream,
      journalWrite: async (e) => {
        await Promise.resolve();
        entries.push(e);
      },
    });
    let thrown: unknown;
    try {
      await provider.createResponse(minimalReq, { deadline: Date.now() - 1 });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).name).toBe("TimeoutError");
    expect(existsSync(pidFile)).toBe(false);
    expect(entries).toHaveLength(0);
    expect(spawnCalls).toBe(0);
  });

  test("binding timeout without a context still rejects code 'timeout' and kills the child", async () => {
    const pidFile = join(tmp, "pid-binding");
    const entries: unknown[] = [];
    const provider = sleepyProvider(pidFile, entries, { timeoutMs: 150 });
    const pending = provider.createResponse(minimalReq);
    await waitFor(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8").trim());

    let thrown: unknown;
    try {
      await pending;
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error & { code?: string }).code).toBe("timeout");
    await waitFor(() => !pidAlive(pid));
    expect(entries).toHaveLength(1);
    expect((entries[0] as Record<string, unknown>)["error_code"]).toBe("timeout");
  });
});

describe("library spawners — pre-aborted signals", () => {
  test("library spawn kills the child immediately when the signal is already aborted", async () => {
    const pidFile = join(tmp, "pid-spawner");
    const res = await librarySpawn(["/bin/sh", "-c", sleepyScript(pidFile)], {
      env: process.env as NodeJS.ProcessEnv,
      signal: AbortSignal.abort(),
      promptOnStdin: false,
      prompt: "",
    });
    expect(res.aborted).toBe(true);
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      await waitFor(() => !pidAlive(pid));
    }
  });

  test("library spawnStream kills the child immediately when the signal is already aborted", async () => {
    const pidFile = join(tmp, "pid-stream-spawner");
    const res = await librarySpawnStream(["/bin/sh", "-c", sleepyScript(pidFile)], {
      env: process.env as NodeJS.ProcessEnv,
      signal: AbortSignal.abort(),
      promptOnStdin: false,
      prompt: "",
    });
    const exited = await Promise.race([
      res.exitedPromise,
      new Promise<null>((r) => {
        setTimeout(() => {
          r(null);
        }, 5_000);
      }),
    ]);
    expect(exited).not.toBeNull();
    expect(exited!.aborted).toBe(true);
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      await waitFor(() => !pidAlive(pid));
    }
  });
});

describe("SIGKILL escalation — a child that ignores SIGTERM still dies", () => {
  const GRACE_MS = 40;
  function trapScript(pidFile: string): string {
    return `trap '' TERM; echo $$ > ${pidFile}; exec sleep 30`;
  }

  test("createResponse: SIGKILL lands within grace; the promise settles", async () => {
    const pidFile = join(tmp, "pid-sigkill-nonstream");
    const entries: unknown[] = [];
    const provider = createCliSubprocessProvider({
      agentName: "mac-mini",
      binding: makeBinding({ args: ["-c", trapScript(pidFile)], timeoutMs: 60_000 }),
      spawn: (argv, o) => librarySpawn(argv, { ...o, killGraceMs: GRACE_MS }),
      journalWrite: async (e) => {
        await Promise.resolve();
        entries.push(e);
      },
    });
    const caller = new AbortController();
    const pending = provider.createResponse(minimalReq, { signal: caller.signal });
    await waitFor(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pidAlive(pid)).toBe(true);

    caller.abort();
    const outcome = await Promise.race([
      pending.then(
        () => "resolved",
        (e: unknown) => `rejected:${(e as Error).name}`,
      ),
      new Promise<string>((r) => {
        setTimeout(() => {
          r("hung");
        }, 8_000);
      }),
    ]);
    expect(outcome).toBe("rejected:AbortError");
    await waitFor(() => !pidAlive(pid));
    expect(entries).toHaveLength(1);
    expect((entries[0] as Record<string, unknown>)["error_code"]).toBe("aborted");
  });

  test("streamResponse: SIGKILL lands within grace; the stream settles", async () => {
    const pidFile = join(tmp, "pid-sigkill-stream");
    const entries: unknown[] = [];
    const provider = createCliSubprocessProvider({
      agentName: "mac-mini",
      binding: {
        name: "claude-pro",
        preset: "claude",
        command: "/bin/sh",
        args: ["-c", trapScript(pidFile)],
        format: "text",
        timeoutMs: 60_000,
        advertisedModels: [],
        capabilities: ["reasoning"],
      },
      spawnStream: (argv, o) => librarySpawnStream(argv, { ...o, killGraceMs: GRACE_MS }),
      journalWrite: async (e) => {
        await Promise.resolve();
        entries.push(e);
      },
    });
    const caller = new AbortController();
    const events: UnifiedStreamEvent[] = [];
    let thrown: unknown;
    const consume = (async (): Promise<void> => {
      try {
        for await (const e of provider.streamResponse!(minimalReq, caller.signal)) events.push(e);
      } catch (err) {
        thrown = err;
      }
    })();
    await waitFor(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8").trim());

    caller.abort();
    await Promise.race([
      consume,
      new Promise((_r, rej) => {
        setTimeout(() => {
          rej(new Error("stream hung — SIGKILL never landed"));
        }, 8_000);
      }),
    ]);
    expect((thrown as Error).name).toBe("AbortError");
    await waitFor(() => !pidAlive(pid));
    expect((entries[0] as Record<string, unknown>)["error_code"]).toBe("aborted");
  });
});

describe("streamResponse — real subprocess", () => {
  test("clean exit yields chunks then done completion 'upstream'", async () => {
    const entries: unknown[] = [];
    const provider = streamProvider(`printf 'one\\ntwo\\n'`, entries);
    const events = await collect(provider.streamResponse!(minimalReq));
    const chunks = events.filter((e) => e.type === "chunk");
    const done = events.filter((e) => e.type === "done");
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(done).toHaveLength(1);
    const lastDone = events.find(
      (e): e is Extract<UnifiedStreamEvent, { type: "done" }> => e.type === "done",
    );
    expect(lastDone?.completion).toBe("upstream");
    expect((entries[0] as Record<string, unknown>)["ok"]).toBe(true);
  });

  test("non-zero exit yields one error event and NO done", async () => {
    const entries: unknown[] = [];
    const provider = streamProvider(`echo partial; exit 3`, entries);
    const events = await collect(provider.streamResponse!(minimalReq));
    const errors = events.filter(
      (e): e is Extract<UnifiedStreamEvent, { type: "error" }> => e.type === "error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error.code).toBe("non-zero-exit");
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect((entries[0] as Record<string, unknown>)["error_code"]).toBe("non-zero-exit");
  });

  test("binding timeout yields one 'timeout' error and NO done; the child is killed", async () => {
    const pidFile = join(tmp, "pid-stream-timeout");
    const entries: unknown[] = [];
    const provider = streamProvider(sleepyScript(pidFile), entries, 150);
    const collectP = collect(provider.streamResponse!(minimalReq));
    await waitFor(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    const events = await collectP;
    const errors = events.filter(
      (e): e is Extract<UnifiedStreamEvent, { type: "error" }> => e.type === "error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error.code).toBe("timeout");
    expect(events.some((e) => e.type === "done")).toBe(false);
    await waitFor(() => !pidAlive(pid));
    expect((entries[0] as Record<string, unknown>)["error_code"]).toBe("timeout");
  });

  test("caller abort mid-stream throws AbortError after the child is reaped + journalled", async () => {
    const pidFile = join(tmp, "pid-stream-abort");
    const entries: unknown[] = [];
    const provider = streamProvider(`echo first; echo $$ > ${pidFile}; exec sleep 30`, entries);
    const caller = new AbortController();
    const events: UnifiedStreamEvent[] = [];
    let thrown: unknown;
    const consume = (async (): Promise<void> => {
      try {
        for await (const e of provider.streamResponse!(minimalReq, caller.signal)) {
          events.push(e);
        }
      } catch (err) {
        thrown = err;
      }
    })();
    await waitFor(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    caller.abort();
    await consume;
    expect((thrown as Error).name).toBe("AbortError");
    expect(events.some((e) => e.type === "done")).toBe(false);
    await waitFor(() => !pidAlive(pid));
    expect((entries[0] as Record<string, unknown>)["error_code"]).toBe("aborted");
  });

  test("a binding-timer abort mid-run then a trapped clean exit reports 'truncated', NO done", async () => {
    const pidFile = join(tmp, "pid-stream-truncated");
    const entries: unknown[] = [];
    const script = [
      `trap 'kill $! 2>/dev/null; echo trapped-line; sleep 0.3; exit 0' TERM`,
      `echo $$ > ${pidFile}`,
      `i=0; while [ $i -lt 200 ]; do echo "line-$i"; i=$((i+1)); done`,
      `sleep 30 & wait`,
    ].join("; ");
    const provider = createCliSubprocessProvider({
      agentName: "mac-mini",
      binding: streamBinding(script, 80),
      spawnStream: (argv, o) => librarySpawnStream(argv, { ...o, killGraceMs: 5_000 }),
      journalWrite: async (e) => {
        await Promise.resolve();
        entries.push(e);
      },
    });
    const events = await collect(provider.streamResponse!(minimalReq));
    const chunks = events.filter(
      (e): e is Extract<UnifiedStreamEvent, { type: "chunk" }> => e.type === "chunk",
    );
    const errors = events.filter(
      (e): e is Extract<UnifiedStreamEvent, { type: "error" }> => e.type === "error",
    );
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.length).toBeLessThanOrEqual(200);
    expect(
      chunks.some((c) => (c.chunk.choices[0]!.delta.content ?? "").includes("trapped-line")),
    ).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error.code).toBe("truncated");
    expect(errors[0]!.error.retryable).toBe(false);
    expect(events.some((e) => e.type === "done")).toBe(false);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await waitFor(() => !pidAlive(pid));
    expect(entries).toHaveLength(1);
    const e = entries[0] as Record<string, unknown>;
    expect(e["ok"]).toBe(false);
    expect(e["error_code"]).toBe("truncated");
    expect(e["exit_code"]).toBe(0);
  });

  test("a binding-timer abort after the child exits does not cut the stdout drain", async () => {
    const entries: unknown[] = [];
    const provider = streamProvider(
      `i=0; while [ $i -lt 300 ]; do echo "line-$i"; i=$((i+1)); done`,
      entries,
      80,
    );
    const events: UnifiedStreamEvent[] = [];
    for await (const e of provider.streamResponse!(minimalReq)) {
      events.push(e);
      await new Promise((r) => setTimeout(r, 2));
    }
    const chunks = events.filter((e) => e.type === "chunk");
    const done = events.filter(
      (e): e is Extract<UnifiedStreamEvent, { type: "done" }> => e.type === "done",
    );
    expect(chunks).toHaveLength(300);
    expect(done).toHaveLength(1);
    expect(done[0]!.completion).toBe("upstream");
    const e = entries[0] as Record<string, unknown>;
    expect(e["ok"]).toBe(true);
    expect(e["error_code"]).toBeUndefined();
  });
});

describe("differential — default vs library spawner", () => {
  test("text stdout and journal match", async () => {
    const entries: unknown[] = [];
    const libEntries: unknown[] = [];
    const opts: CliProviderOptions = {
      agentName: "mac-mini",
      binding: makeBinding({ args: ["-c", "printf hello"] }),
      journalWrite: async (e) => {
        entries.push(e);
      },
    };
    const defProvider = createCliSubprocessProvider(opts);
    const libProvider = createCliSubprocessProvider({
      ...opts,
      spawn: librarySpawn,
      spawnStream: librarySpawnStream,
      journalWrite: async (e) => {
        libEntries.push(e);
      },
    });
    const defRes = await defProvider.createResponse(minimalReq);
    const libRes = await libProvider.createResponse(minimalReq);
    expect(defRes.choices[0]!.message.content).toBe("hello");
    expect(libRes.choices[0]!.message.content).toBe("hello");
    expect(normalizeEntry(entries[0])).toEqual(normalizeEntry(libEntries[0]));
  });

  test("prompt on stdin reaches the child identically", async () => {
    const entries: unknown[] = [];
    const libEntries: unknown[] = [];
    const opts: CliProviderOptions = {
      agentName: "mac-mini",
      binding: makeBinding({ preset: "custom", args: ["-c", "cat"] }),
      journalWrite: async (e) => {
        entries.push(e);
      },
    };
    const defProvider = createCliSubprocessProvider(opts);
    const libProvider = createCliSubprocessProvider({
      ...opts,
      spawn: librarySpawn,
      spawnStream: librarySpawnStream,
      journalWrite: async (e) => {
        libEntries.push(e);
      },
    });
    const req: UnifiedAiRequest = {
      model: "fake-model",
      messages: [{ role: "user", content: "exec-primitives-parity-stdin" }],
    };
    const defRes = await defProvider.createResponse(req);
    const libRes = await libProvider.createResponse(req);
    expect(defRes.choices[0]!.message.content).toContain("exec-primitives-parity-stdin");
    expect(libRes.choices[0]!.message.content).toContain("exec-primitives-parity-stdin");
    expect(normalizeEntry(entries[0])).toEqual(normalizeEntry(libEntries[0]));
  });

  test("non-zero exit with stderr: same typed error and exit_code", async () => {
    const entries: unknown[] = [];
    const libEntries: unknown[] = [];
    const opts: CliProviderOptions = {
      agentName: "mac-mini",
      binding: makeBinding({ args: ["-c", "echo boom >&2; exit 3"] }),
      journalWrite: async (e) => {
        entries.push(e);
      },
    };
    const defProvider = createCliSubprocessProvider(opts);
    const libProvider = createCliSubprocessProvider({
      ...opts,
      spawn: librarySpawn,
      spawnStream: librarySpawnStream,
      journalWrite: async (e) => {
        libEntries.push(e);
      },
    });
    let defErr: unknown;
    let libErr: unknown;
    try {
      await defProvider.createResponse(minimalReq);
    } catch (e) {
      defErr = e;
    }
    try {
      await libProvider.createResponse(minimalReq);
    } catch (e) {
      libErr = e;
    }
    expect((defErr as Error & { code?: string }).code).toBe("non-zero-exit");
    expect((libErr as Error & { code?: string }).code).toBe("non-zero-exit");
    expect((entries[0] as Record<string, unknown>)["exit_code"]).toBe(3);
    expect((libEntries[0] as Record<string, unknown>)["exit_code"]).toBe(3);
    expect(normalizeEntry(entries[0])).toEqual(normalizeEntry(libEntries[0]));
  });

  test("missing binary: same spawn-failed error and no exit_code", async () => {
    const entries: unknown[] = [];
    const libEntries: unknown[] = [];
    const opts: CliProviderOptions = {
      agentName: "mac-mini",
      binding: makeBinding({ command: "/nonexistent/exec-primitives-missing-binary", args: [] }),
      journalWrite: async (e) => {
        entries.push(e);
      },
    };
    const defProvider = createCliSubprocessProvider(opts);
    const libProvider = createCliSubprocessProvider({
      ...opts,
      spawn: librarySpawn,
      spawnStream: librarySpawnStream,
      journalWrite: async (e) => {
        libEntries.push(e);
      },
    });
    let defErr: unknown;
    let libErr: unknown;
    try {
      await defProvider.createResponse(minimalReq);
    } catch (e) {
      defErr = e;
    }
    try {
      await libProvider.createResponse(minimalReq);
    } catch (e) {
      libErr = e;
    }
    expect((defErr as Error & { code?: string }).code).toBe("spawn-failed");
    expect((libErr as Error & { code?: string }).code).toBe("spawn-failed");
    expect((entries[0] as Record<string, unknown>)["exit_code"]).toBeUndefined();
    expect((libEntries[0] as Record<string, unknown>)["exit_code"]).toBeUndefined();
    expect(normalizeEntry(entries[0])).toEqual(normalizeEntry(libEntries[0]));
  });

  test("caller abort of a SIGTERM-trapping child: same AbortError and signal exit_code", async () => {
    const defEntries: unknown[] = [];
    const libEntries: unknown[] = [];
    const script = (pidFile: string): string => `trap '' TERM; echo $$ > ${pidFile}; exec sleep 30`;
    const defPidFile = join(tmp, "pid-def-abort-trap");
    const libPidFile = join(tmp, "pid-lib-abort-trap");
    const baseOpts = (pidFile: string): CliProviderOptions => ({
      agentName: "mac-mini",
      binding: makeBinding({ args: ["-c", script(pidFile)], timeoutMs: 60_000 }),
      journalWrite: async () => {},
    });
    const defProvider = createCliSubprocessProvider({
      ...baseOpts(defPidFile),
      journalWrite: async (e) => {
        defEntries.push(e);
      },
    });
    const libProvider = createCliSubprocessProvider({
      ...baseOpts(libPidFile),
      spawn: librarySpawn,
      spawnStream: librarySpawnStream,
      journalWrite: async (e) => {
        libEntries.push(e);
      },
    });
    async function runArm(
      provider: AiProvider,
      pidFile: string,
    ): Promise<{ err: unknown; pid: number }> {
      const caller = new AbortController();
      const pending = provider.createResponse(minimalReq, { signal: caller.signal });
      await waitFor(() => existsSync(pidFile));
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      caller.abort();
      let err: unknown;
      try {
        await pending;
      } catch (e) {
        err = e;
      }
      await waitFor(() => !pidAlive(pid));
      return { err, pid };
    }
    const defResult = await runArm(defProvider, defPidFile);
    const libResult = await runArm(libProvider, libPidFile);
    expect((defResult.err as Error).name).toBe("AbortError");
    expect((libResult.err as Error).name).toBe("AbortError");
    expect(normalizeEntry(defEntries[0])).toEqual(normalizeEntry(libEntries[0]));
  });

  test("explicit env reaches the child verbatim with no parent leak", async () => {
    const entries: unknown[] = [];
    const libEntries: unknown[] = [];
    process.env.EXEC_PRIMITIVES_PARITY_LEAK = "1";
    try {
      const opts: CliProviderOptions = {
        agentName: "mac-mini",
        binding: makeBinding({ args: ["-c", "env"] }),
        env: { PATH: "/usr/bin:/bin", MARK: "exec-primitives-parity" },
        journalWrite: async (e) => {
          entries.push(e);
        },
      };
      const defProvider = createCliSubprocessProvider(opts);
      const libProvider = createCliSubprocessProvider({
        ...opts,
        spawn: librarySpawn,
        spawnStream: librarySpawnStream,
        journalWrite: async (e) => {
          libEntries.push(e);
        },
      });
      const defRes = await defProvider.createResponse(minimalReq);
      const libRes = await libProvider.createResponse(minimalReq);
      expect(defRes.choices[0]!.message.content).toContain("MARK=exec-primitives-parity");
      expect(defRes.choices[0]!.message.content).not.toContain("EXEC_PRIMITIVES_PARITY_LEAK");
      expect(libRes.choices[0]!.message.content).toContain("MARK=exec-primitives-parity");
      expect(libRes.choices[0]!.message.content).not.toContain("EXEC_PRIMITIVES_PARITY_LEAK");
      expect(normalizeEntry(entries[0])).toEqual(normalizeEntry(libEntries[0]));
    } finally {
      delete process.env.EXEC_PRIMITIVES_PARITY_LEAK;
    }
  });

  test("child cwd matches the default spawner", async () => {
    const entries: unknown[] = [];
    const libEntries: unknown[] = [];
    const opts: CliProviderOptions = {
      agentName: "mac-mini",
      binding: makeBinding({ args: ["-c", "pwd"] }),
      journalWrite: async (e) => {
        entries.push(e);
      },
    };
    const defProvider = createCliSubprocessProvider(opts);
    const libProvider = createCliSubprocessProvider({
      ...opts,
      spawn: librarySpawn,
      spawnStream: librarySpawnStream,
      journalWrite: async (e) => {
        libEntries.push(e);
      },
    });
    const defRes = await defProvider.createResponse(minimalReq);
    const libRes = await libProvider.createResponse(minimalReq);
    expect(defRes.choices[0]!.message.content).toBe(libRes.choices[0]!.message.content);
    expect(normalizeEntry(entries[0])).toEqual(normalizeEntry(libEntries[0]));
  });

  test("stream clean exit yields identical chunks and journal", async () => {
    const entries: unknown[] = [];
    const libEntries: unknown[] = [];
    const opts: CliProviderOptions = {
      agentName: "mac-mini",
      binding: streamBinding(`printf 'one\\ntwo\\n'`),
      journalWrite: async (e) => {
        entries.push(e);
      },
    };
    const defProvider = createCliSubprocessProvider(opts);
    const libProvider = createCliSubprocessProvider({
      ...opts,
      spawn: librarySpawn,
      spawnStream: librarySpawnStream,
      journalWrite: async (e) => {
        libEntries.push(e);
      },
    });
    const defEvents = await collect(defProvider.streamResponse!(minimalReq));
    const libEvents = await collect(libProvider.streamResponse!(minimalReq));
    const defChunks = defEvents.filter(
      (e): e is Extract<UnifiedStreamEvent, { type: "chunk" }> => e.type === "chunk",
    );
    const libChunks = libEvents.filter(
      (e): e is Extract<UnifiedStreamEvent, { type: "chunk" }> => e.type === "chunk",
    );
    expect(defEvents.some((e) => e.type === "done")).toBe(true);
    expect(libEvents.some((e) => e.type === "done")).toBe(true);
    expect(libChunks.map((c) => c.chunk.choices[0]!.delta.content)).toEqual(
      defChunks.map((c) => c.chunk.choices[0]!.delta.content),
    );
    expect(libEvents.map((e) => e.type)).toEqual(defEvents.map((e) => e.type));
    expect(normalizeEntry(entries[0])).toEqual(normalizeEntry(libEntries[0]));
  });

  test("stream consumer break journals the same error_code", async () => {
    const entries: unknown[] = [];
    const libEntries: unknown[] = [];
    const opts: CliProviderOptions = {
      agentName: "mac-mini",
      binding: streamBinding(`echo first; exec sleep 30`),
      journalWrite: async (e) => {
        entries.push(e);
      },
    };
    const defProvider = createCliSubprocessProvider(opts);
    const libProvider = createCliSubprocessProvider({
      ...opts,
      spawn: librarySpawn,
      spawnStream: librarySpawnStream,
      journalWrite: async (e) => {
        libEntries.push(e);
      },
    });
    async function breakAfterFirst(provider: AiProvider): Promise<void> {
      for await (const _e of provider.streamResponse!(minimalReq)) {
        break;
      }
    }
    await breakAfterFirst(defProvider);
    await breakAfterFirst(libProvider);
    expect((entries[0] as Record<string, unknown>)["error_code"]).toBe("cancelled");
    expect((libEntries[0] as Record<string, unknown>)["error_code"]).toBe("cancelled");
    expect(normalizeEntry(entries[0])).toEqual(normalizeEntry(libEntries[0]));
  });
});
