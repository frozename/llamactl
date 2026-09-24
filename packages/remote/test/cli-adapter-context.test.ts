import type { CliBinding } from "@llamactl/core/config/schema";
import type {
  AiProvider,
  OpenAICompatUsageObservation,
  UnifiedAiRequest,
  UnifiedStreamEvent,
} from "@nova/contracts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCliSubprocessProvider,
  defaultBunSpawn,
  defaultBunSpawnStream,
  type SpawnFn,
  type SpawnResult,
} from "../src/cli/adapter.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "../src/safe-fs.js";

/**
 * ProviderExecutionContext coverage for the CLI subprocess adapter,
 * driven against REAL fake executables (`/bin/sh -c …`) through the
 * production `Bun.spawn` path — no spawn or fetch mocks.
 *
 *   - a caller abort kills the spawned child and rejects with the
 *     caller's reason (AbortError)
 *   - a context deadline ahead of the binding timeout rejects
 *     TimeoutError and kills the child
 *   - already-cancelled inputs (pre-aborted signal, past deadline)
 *     reject before spawn — no child, no journal
 *   - the binding timeout alone still surfaces the legacy 'timeout'
 *   - the default spawners kill a child handed a pre-aborted signal
 *   - usage is reported once through onUsageObservation as
 *     'estimated' and never lands on the response
 */

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
  // `exec` keeps the same pid for `sleep`, so the pidfile tracks the
  // real spawned child end-to-end.
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

function fakeSpawn(result: Partial<SpawnResult> & { stdout?: string }): SpawnFn {
  return () =>
    Promise.resolve({
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
      aborted: result.aborted ?? false,
    });
}

let tmp = "";
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-cli-ctx-"));
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
    journalWrite: async (e) => {
      await Promise.resolve();
      entries.push(e);
    },
  });
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
    // The kill reached the real subprocess — its pid is gone.
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
    const provider = sleepyProvider(pidFile, entries);
    let thrown: unknown;
    try {
      await provider.createResponse(minimalReq, { signal: AbortSignal.abort() });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).name).toBe("AbortError");
    expect(existsSync(pidFile)).toBe(false);
    expect(entries).toHaveLength(0);
  });

  test("past deadline rejects TimeoutError without spawning or journalling", async () => {
    const pidFile = join(tmp, "pid-pastdeadline");
    const entries: unknown[] = [];
    const provider = sleepyProvider(pidFile, entries);
    let thrown: unknown;
    try {
      await provider.createResponse(minimalReq, { deadline: Date.now() - 1 });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).name).toBe("TimeoutError");
    expect(existsSync(pidFile)).toBe(false);
    expect(entries).toHaveLength(0);
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

describe("default spawners — pre-aborted signals", () => {
  test("defaultBunSpawn kills the child immediately when the signal is already aborted", async () => {
    const pidFile = join(tmp, "pid-spawner");
    const res = await defaultBunSpawn(["/bin/sh", "-c", sleepyScript(pidFile)], {
      env: process.env,
      signal: AbortSignal.abort(),
      promptOnStdin: false,
      prompt: "",
    });
    // The pre-aborted signal fired onAbort before the child could run.
    expect(res.aborted).toBe(true);
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      await waitFor(() => !pidAlive(pid));
    }
  });

  test("defaultBunSpawnStream kills the child immediately when the signal is already aborted", async () => {
    const pidFile = join(tmp, "pid-stream-spawner");
    const res = await defaultBunSpawnStream(["/bin/sh", "-c", sleepyScript(pidFile)], {
      env: process.env,
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
  // `trap '' TERM` installs SIG_IGN, which survives `exec` — the sleep
  // process shrugs off the abort's SIGTERM and only SIGKILL ends it.
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
      spawn: (argv, o) => defaultBunSpawn(argv, { ...o, killGraceMs: GRACE_MS }),
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
      spawnStream: (argv, o) => defaultBunSpawnStream(argv, { ...o, killGraceMs: GRACE_MS }),
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

describe("createResponse — usage observation", () => {
  test("fires onUsageObservation exactly once with source 'estimated'; response has no usage", async () => {
    const seen: OpenAICompatUsageObservation[] = [];
    const provider = createCliSubprocessProvider({
      agentName: "mac-mini",
      binding: makeBinding(),
      spawn: fakeSpawn({ stdout: "hello world" }),
      journalWrite: () => Promise.resolve(),
      onUsageObservation: (s: OpenAICompatUsageObservation) => {
        seen.push(s);
      },
    });
    const res = await provider.createResponse(minimalReq, {
      requestId: "req-1",
      attemptId: "att-1",
    });
    expect(res.usage).toBeUndefined();
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.provider).toBe("mac-mini.fake-cli");
    expect(s.model).toBe("fake-model");
    expect(s.kind).toBe("chat");
    expect(s.observation.source).toBe("estimated");
    expect(s.observation.input_tokens).toBeGreaterThan(0);
    expect(s.observation.output_tokens).toBeGreaterThan(0);
    expect(s.observation.total_tokens).toBe(
      (s.observation.input_tokens ?? 0) + (s.observation.output_tokens ?? 0),
    );
    expect(s.request_id).toBe("req-1");
    expect(s.attempt_id).toBe("att-1");
    expect(typeof s.latency_ms).toBe("number");
  });

  test("a throwing observation callback does not break the response", async () => {
    const provider = createCliSubprocessProvider({
      agentName: "mac-mini",
      binding: makeBinding(),
      spawn: fakeSpawn({ stdout: "fine" }),
      journalWrite: () => Promise.resolve(),
      onUsageObservation: () => {
        throw new Error("sink exploded");
      },
    });
    const res = await provider.createResponse(minimalReq);
    expect(res.choices[0]!.message.content).toBe("fine");
    expect(res.usage).toBeUndefined();
  });

  test("no observation fires on failure paths", async () => {
    const seen: OpenAICompatUsageObservation[] = [];
    const provider = createCliSubprocessProvider({
      agentName: "mac-mini",
      binding: makeBinding(),
      spawn: fakeSpawn({ stdout: "", stderr: "boom", exitCode: 2 }),
      journalWrite: () => Promise.resolve(),
      onUsageObservation: (s: OpenAICompatUsageObservation) => {
        seen.push(s);
      },
    });
    try {
      await provider.createResponse(minimalReq);
    } catch {
      /* expected */
    }
    expect(seen).toHaveLength(0);
  });
});

describe("streamResponse — real subprocess", () => {
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
    // The child traps SIGTERM: on the 80ms binding abort it emits one
    // final line and lingers ~300ms inside the trap before exiting 0.
    // The drain sees that post-abort line while the child still runs
    // and cuts before EOF — the clean exit that follows must NOT
    // upgrade the run to done: truncation is a terminal error event
    // plus an ok:false / error_code 'truncated' journal entry.
    // killGraceMs is stretched so the SIGKILL escalation can't land
    // inside the trap's linger and flip the exit code.
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
      spawnStream: (argv, o) => defaultBunSpawnStream(argv, { ...o, killGraceMs: 5_000 }),
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
    // The child writes 300 lines (~3KB — far under the pipe buffer)
    // and exits in a few ms. The paced consumer stretches the drain to
    // ~600ms so the 80ms binding timer fires mid-drain while the child
    // is already reaped: buffered output must complete to EOF and the
    // run still earns done 'upstream' + journal ok:true.
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
