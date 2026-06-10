import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the CLI entry (source TS, executed by Bun). */
export const CLI_ENTRY = join(__dirname, "..", "src", "bin.ts");

/**
 * Hermetic runtime rooted in a temp dir. Tests should use this rather
 * than pointing at the developer's `$DEV_STORAGE` so they can mutate
 * state freely. Returns the env map to pass into `runCli` and a
 * cleanup helper.
 */
export function makeTempRuntime(): {
  env: NodeJS.ProcessEnv;
  devStorage: string;
  runtimeDir: string;
  modelsDir: string;
  cleanup: () => void;
} {
  const devStorage = mkdtempSync(join(tmpdir(), "llamactl-cli-test-"));
  const runtimeDir = join(devStorage, "ai-models", "local-ai");
  const modelsDir = join(devStorage, "ai-models", "llama.cpp", "models");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "/tmp",
    DEV_STORAGE: devStorage,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMA_CPP_MODELS: modelsDir,
    LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    LOCAL_AI_RECOMMENDATIONS_SOURCE: "off", // no network from tests
    LOCAL_AI_CUSTOM_CATALOG_FILE: join(runtimeDir, "curated-models.tsv"),
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(runtimeDir, "preset-overrides.tsv"),
  };
  return {
    env,
    devStorage,
    runtimeDir,
    modelsDir,
    cleanup: () => {
      rmSync(devStorage, { recursive: true, force: true });
    },
  };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CapturedIo {
  out: string;
  err: string;
}

export async function captureProcessIo<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; cap: CapturedIo }> {
  const cap: CapturedIo = { out: "", err: "" };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = makeWriteStub((chunk) => {
    cap.out += chunkToString(chunk);
  });
  process.stderr.write = makeWriteStub((chunk) => {
    cap.err += chunkToString(chunk);
  });
  try {
    return { result: await fn(), cap };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

export async function captureProcessStreams<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  const { result, cap } = await captureProcessIo(fn);
  return { result, stdout: cap.out, stderr: cap.err };
}

export function makeWriteStub(
  onChunk: (chunk: string | Uint8Array) => void,
): typeof process.stdout.write {
  return (chunk: string | Uint8Array): boolean => {
    onChunk(chunk);
    return true;
  };
}

export function chunkToString(chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : String(chunk);
}

export function parseJsonRecord(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isPlainRecord(parsed)) throw new Error("expected JSON object");
  return parsed;
}

export function parseJsonArray(text: string): unknown[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("expected JSON array");
  return parsed;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error("expected object");
  return value;
}

export function requireArrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`expected array field ${key}`);
  return value;
}

export function requireRecordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return requireRecord(record[key]);
}

/**
 * Spawn `bun src/bin.ts <args>` with the given env. Synchronous — the
 * tests are short enough that streaming would be pointless.
 */
export function runCli(args: string[], env: NodeJS.ProcessEnv): RunResult {
  const proc = spawnSync("bun", [CLI_ENTRY, ...args], {
    env: { ...env },
    encoding: "utf8",
    cwd: join(__dirname, ".."),
  });
  return {
    code: proc.status ?? -1,
    stdout: proc.stdout,
    stderr: proc.stderr,
  };
}
