import { runProcess, superviseProcess } from "@novaproto/exec-primitives";
import { constants as osConstants } from "node:os";
import type { Readable } from "node:stream";
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

async function* passThroughLines(lines: AsyncIterable<string>): AsyncIterable<string> {
  for await (const line of lines) yield line;
}

async function* takeLines(lines: AsyncIterable<string>, max: number): AsyncIterable<string> {
  let n = 0;
  for await (const line of lines) {
    if (n >= max) return;
    n++;
    yield line;
  }
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

async function* readLines(stream: Readable): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk as Buffer, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        yield line;
        nl = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      yield buffer;
    }
  } finally {
    stream.destroy();
  }
}

async function collectStream(stream: Readable | undefined): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const librarySpawnStream: SpawnStreamFn = async (argv, opts) => {
  const [command, ...args] = argv;
  const proc = superviseProcess({
    command,
    args,
    cwd: process.cwd(),
    env: toHostEnv(opts.env),
    signal: callerSignal(opts),
    cancelGraceMs: cancelGraceMs(opts),
    watchdogMs: WATCHDOG_BACKSTOP_MS,
    stdin: opts.promptOnStdin ? opts.prompt : "ignore",
  });
  await new Promise<void>((r) => setImmediate(() => r()));
  if (proc.spawnError) {
    throw proc.spawnError;
  }
  const stderrPromise = collectStream(proc.stderr);
  const exitedPromise = proc.exit.then((exit) => ({
    exitCode: exitCodeOf(exit.code, exit.signal),
    aborted: exit.outcome === "cancelled",
  }));
  return {
    stdout: proc.stdout ? passThroughLines(readLines(proc.stdout)) : (async function* () {})(),
    stderrPromise,
    exitedPromise,
  };
};
