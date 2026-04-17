import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the CLI entry (source TS, executed by Bun). */
export const CLI_ENTRY = join(__dirname, '..', 'src', 'bin.ts');

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
  const devStorage = mkdtempSync(join(tmpdir(), 'llamactl-cli-test-'));
  const runtimeDir = join(devStorage, 'ai-models', 'local-ai');
  const modelsDir = join(devStorage, 'ai-models', 'llama.cpp', 'models');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '/tmp',
    DEV_STORAGE: devStorage,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMA_CPP_MODELS: modelsDir,
    LLAMA_CPP_MACHINE_PROFILE: 'macbook-pro-48g',
    LOCAL_AI_RECOMMENDATIONS_SOURCE: 'off', // no network from tests
    LOCAL_AI_CUSTOM_CATALOG_FILE: join(runtimeDir, 'curated-models.tsv'),
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(runtimeDir, 'preset-overrides.tsv'),
  };
  return {
    env,
    devStorage,
    runtimeDir,
    modelsDir,
    cleanup: () => rmSync(devStorage, { recursive: true, force: true }),
  };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `bun src/bin.ts <args>` with the given env. Synchronous — the
 * tests are short enough that streaming would be pointless.
 */
export function runCli(args: string[], env: NodeJS.ProcessEnv): RunResult {
  const proc = spawnSync('bun', [CLI_ENTRY, ...args], {
    env: { ...env },
    encoding: 'utf8',
    cwd: join(__dirname, '..'),
  });
  return {
    code: proc.status ?? -1,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
  };
}
