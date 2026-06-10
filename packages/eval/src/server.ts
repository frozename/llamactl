import { spawn, type Subprocess } from "bun";
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";

export interface ServerOptions {
  modelPath: string;
  port: number;
  ub: 256 | 512;
  ctxSize?: number;
  flashAttn?: boolean;
}

export function buildServerArgs(opts: ServerOptions): string[] {
  const args = [
    "--host",
    "127.0.0.1",
    "--port",
    String(opts.port),
    "--model",
    opts.modelPath,
    "--ctx-size",
    String(opts.ctxSize ?? 8192),
    "--no-warmup",
    "-np",
    "1",
    "-ngl",
    "999",
    "--flash-attn",
    opts.flashAttn === false ? "off" : "on",
    "-ub",
    String(opts.ub),
  ];
  return args;
}

export interface SpawnedServer {
  proc: Subprocess;
  url: string;
  logPath: string;
}

async function pipeStream(
  stream: ReadableStream<Uint8Array> | null,
  writer: WriteStream,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      writer.write(value);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function spawnServer(
  binary: string,
  opts: ServerOptions,
  logPath: string,
): Promise<SpawnedServer> {
  const proc = spawn([binary, ...buildServerArgs(opts)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const log = createWriteStream(logPath, { flags: "a" });
  void pipeStream(proc.stdout, log);
  void pipeStream(proc.stderr, log);
  return { proc, url: `http://127.0.0.1:${opts.port}`, logPath };
}

export async function waitForHealth(
  url: string,
  proc: Subprocess,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`server died during startup (exit code ${proc.exitCode})`);
    }
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(500);
  }
  throw new Error(`server failed health within ${timeoutMs}ms`);
}

export async function killServer(s: SpawnedServer): Promise<void> {
  s.proc.kill("SIGTERM");
  try {
    await s.proc.exited;
  } catch {
    // fine
  }
}
