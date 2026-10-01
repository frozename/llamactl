import { runProcess, superviseProcess } from "@novaproto/exec-primitives";
import { constants as osConstants } from "node:os";
import type { SpawnFn, SpawnStreamFn } from "../../../../packages/remote/src/index.ts";

export const CLI_KILL_GRACE_MS = 250;
export const WATCHDOG_BACKSTOP_MS = 120_000;

function toHostEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(env)) {
    if (typeof val === "string") out[key] = val;
  }
  return out;
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) return 128 + (osConstants.signals[signal] ?? 0);
  return -1;
}

function callerSignal(opts: { signal: AbortSignal }): AbortSignal {
  return opts.signal;
}

function cancelGraceMs(opts: { killGraceMs?: number }): number {
  return opts.killGraceMs ?? CLI_KILL_GRACE_MS;
}

export const librarySpawn: SpawnFn = async (argv, opts) => {
  const [command, ...args] = argv;
  const result = await runProcess({
    command,
    args,
    cwd: process.cwd(),
    env: toHostEnv(opts.env),
    signal: callerSignal(opts),
    cancelGraceMs: cancelGraceMs(opts),
    watchdogMs: WATCHDOG_BACKSTOP_MS,
    stdin: opts.promptOnStdin ? opts.prompt : "ignore",
  });
  if (result.exit.outcome === "spawn-error") {
    throw new Error(`spawn failed: ${result.stderr}`);
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: exitCodeOf(result.exit.code, result.exit.signal),
    aborted: result.exit.outcome === "cancelled",
  };
};

class LineQueue implements AsyncIterable<string> {
  readonly #decoder = new TextDecoder();
  readonly #lines: string[] = [];
  #buffer = "";
  #done = false;
  #waiter: (() => void) | undefined;

  push(chunk: Buffer): void {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    let nl = this.#buffer.indexOf("\n");
    while (nl >= 0) {
      this.#lines.push(this.#buffer.slice(0, nl));
      this.#buffer = this.#buffer.slice(nl + 1);
      nl = this.#buffer.indexOf("\n");
    }
    this.#wake();
  }

  finish(): void {
    this.#buffer += this.#decoder.decode();
    if (this.#buffer.length > 0) {
      this.#lines.push(this.#buffer);
      this.#buffer = "";
    }
    this.#done = true;
    this.#wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      const line = this.#lines.shift();
      if (line !== undefined) {
        yield line;
        continue;
      }
      if (this.#done) return;
      await new Promise<void>((resolve) => {
        this.#waiter = resolve;
      });
    }
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.();
  }
}

async function* takeLinesUntilExit(
  lines: AsyncIterable<string>,
  exited: Promise<unknown>,
): AsyncIterable<string> {
  let exitSettled = false;
  void exited.then(
    () => {
      exitSettled = true;
    },
    () => {
      exitSettled = true;
    },
  );
  for await (const line of lines) {
    if (exitSettled) return;
    yield line;
  }
}

export const librarySpawnStream: SpawnStreamFn = async (argv, opts) => {
  const [command, ...args] = argv;
  const stdoutQueue = new LineQueue();
  const stderrChunks: Buffer[] = [];
  const proc = superviseProcess({
    command,
    args,
    cwd: process.cwd(),
    env: toHostEnv(opts.env),
    signal: callerSignal(opts),
    cancelGraceMs: cancelGraceMs(opts),
    watchdogMs: WATCHDOG_BACKSTOP_MS,
    stdin: opts.promptOnStdin ? opts.prompt : "ignore",
    onStdoutChunk: (chunk) => {
      stdoutQueue.push(chunk);
    },
    onStderrChunk: (chunk) => {
      stderrChunks.push(chunk);
    },
  });
  await new Promise<void>((r) => setImmediate(() => r()));
  if (proc.spawnError) {
    throw proc.spawnError;
  }
  const stderrPromise = proc.exit.then(() => Buffer.concat(stderrChunks).toString("utf8"));
  const exitedPromise = proc.exit.then((exit) => ({
    exitCode: exitCodeOf(exit.code, exit.signal),
    aborted: exit.outcome === "cancelled",
  }));
  void proc.exit.then(
    () => {
      stdoutQueue.finish();
    },
    () => {
      stdoutQueue.finish();
    },
  );
  return {
    stdout: stdoutQueue,
    stderrPromise,
    exitedPromise,
  };
};
