import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Create a hermetic temp directory tree shaped like `$LOCAL_AI_RUNTIME_DIR`
 * so tests can exercise writers + readers without touching the real
 * state on disk. Returns an object with the root and a `cleanup` helper
 * the caller should invoke in `afterEach` / `afterAll`.
 */
export function makeTempRuntime(): {
  runtimeDir: string;
  devStorage: string;
  modelsDir: string;
  cleanup: () => void;
} {
  const devStorage = mkdtempSync(join(tmpdir(), 'llamactl-test-'));
  const runtimeDir = join(devStorage, 'ai-models', 'local-ai');
  const modelsDir = join(devStorage, 'ai-models', 'llama.cpp', 'models');
  return {
    runtimeDir,
    devStorage,
    modelsDir,
    cleanup: () => rmSync(devStorage, { recursive: true, force: true }),
  };
}

/**
 * Build an env object that points llamactl's resolvers at the temp
 * runtime. Sets only the variables we want to override so tests don't
 * accidentally pick up the developer's real `$DEV_STORAGE`.
 */
export function envForTemp(temp: ReturnType<typeof makeTempRuntime>): NodeJS.ProcessEnv {
  return {
    DEV_STORAGE: temp.devStorage,
    LOCAL_AI_RUNTIME_DIR: temp.runtimeDir,
    LLAMA_CPP_MODELS: temp.modelsDir,
    LLAMA_CPP_MACHINE_PROFILE: 'macbook-pro-48g',
    LOCAL_AI_RECOMMENDATIONS_SOURCE: 'off',
    LOCAL_AI_CUSTOM_CATALOG_FILE: join(temp.runtimeDir, 'curated-models.tsv'),
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(temp.runtimeDir, 'preset-overrides.tsv'),
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '/tmp',
  };
}

export const FIXTURE_DIR = join(__dirname, 'fixtures');
