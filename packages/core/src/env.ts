import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveProfile } from './profile.js';
import type { MachineProfile, Provider, ResolvedEnv } from './types.js';
import { MANAGED_DIRS } from './types.js';

const GEMMA_CTX_BY_PROFILE: Record<MachineProfile, string> = {
  'mac-mini-16g': '16384',
  balanced: '24576',
  'macbook-pro-48g': '32768',
};

const QWEN_CTX_BY_PROFILE: Record<MachineProfile, string> = {
  'mac-mini-16g': '16384',
  balanced: '32768',
  'macbook-pro-48g': '65536',
};

/**
 * Default model ranking per profile. Each list is walked in order and the
 * first existing relative path wins. Mirrors the historical zsh ladder so
 * freshly booted shells resolve to the same rel as before the port.
 */
const DEFAULT_MODEL_CHOICES: Record<MachineProfile, readonly string[]> = {
  'mac-mini-16g': [
    'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf',
    'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf',
    'gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf',
  ],
  balanced: [
    'gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf',
    'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf',
    'gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf',
  ],
  'macbook-pro-48g': [
    'gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf',
    'gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf',
    'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf',
  ],
} as const;

/** First choice used when no file in the ladder exists on disk. */
const DEFAULT_MODEL_FALLBACK: Record<MachineProfile, string> = {
  'mac-mini-16g': 'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf',
  balanced: 'gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf',
  'macbook-pro-48g': 'gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf',
};

function pick(
  override: string | undefined,
  fallback: string,
): string {
  return override && override.length > 0 ? override : fallback;
}

/**
 * Hermetic test-profile defaults. When `$LLAMACTL_TEST_PROFILE` is set to
 * a directory path, every AI-model / runtime / cache path gets rerooted
 * under that prefix so audits and CI runs stay isolated from the
 * operator's real state. Individually-set env vars still win — these are
 * defaults, not forced overrides.
 *
 * `LLAMA_CPP_HOST` is pinned to `127.0.0.1` and `LLAMA_CPP_PORT` to
 * `65534` (sentinel) so Logs/Server modules show "offline" instead of
 * tailing a real llama-server when the caller forgets to stub them.
 *
 * Returns `null` when the env var is unset or empty, so callers fall
 * through to the production defaults with zero behaviour change.
 */
function testProfileDefaults(
  env: NodeJS.ProcessEnv,
): Record<string, string> | null {
  const testProfile = env.LLAMACTL_TEST_PROFILE;
  if (!testProfile || testProfile.length === 0) return null;
  const llamaCppRoot = join(testProfile, 'ai-models/llama.cpp');
  const hfHome = join(testProfile, 'cache/huggingface');
  return {
    DEV_STORAGE: testProfile,
    LOCAL_AI_RUNTIME_DIR: join(testProfile, 'ai-models/local-ai'),
    LLAMA_CPP_ROOT: llamaCppRoot,
    LLAMA_CPP_MODELS: join(llamaCppRoot, 'models'),
    LLAMA_CPP_CACHE: join(llamaCppRoot, '.cache'),
    LLAMA_CPP_LOGS: join(testProfile, 'logs/llama.cpp'),
    LLAMA_CPP_BIN: join(testProfile, 'bin'),
    HF_HOME: hfHome,
    HUGGINGFACE_HUB_CACHE: join(hfHome, 'hub'),
    OLLAMA_MODELS: join(testProfile, 'ai-models/ollama'),
    LLAMA_CPP_HOST: '127.0.0.1',
    LLAMA_CPP_PORT: '65534',
  };
}

/**
 * Combine `env.FOO` with a test-profile-derived fallback, deferring to a
 * production fallback if the profile has nothing for this key. Keeps the
 * priority order: individual env var > test-profile default > prod default.
 */
function pickWithTestProfile(
  override: string | undefined,
  testDefault: string | undefined,
  prodFallback: string,
): string {
  if (override && override.length > 0) return override;
  if (testDefault && testDefault.length > 0) return testDefault;
  return prodFallback;
}

function resolveProvider(raw: string | undefined): Provider {
  return raw === 'lmstudio' ? 'lmstudio' : 'llama.cpp';
}

function resolveDefaultModel(
  env: NodeJS.ProcessEnv,
  profile: MachineProfile,
  llamaCppModels: string,
): string {
  const override = env.LLAMA_CPP_DEFAULT_MODEL;
  if (override && override.length > 0) return override;

  for (const rel of DEFAULT_MODEL_CHOICES[profile]) {
    if (existsSync(join(llamaCppModels, rel))) return rel;
  }
  return DEFAULT_MODEL_FALLBACK[profile];
}

/**
 * Pure function: given a starting environment, compute every variable
 * llamactl's shell surface has historically exposed. No side effects.
 * The CLI's `env --eval` serialises this; Electron main calls it during
 * startup and writes the result straight into process.env.
 */
export function resolveEnv(env: NodeJS.ProcessEnv = process.env): ResolvedEnv {
  const testProfile = testProfileDefaults(env);
  const t = (key: string): string | undefined => testProfile?.[key];

  const devStorage = pickWithTestProfile(
    env.DEV_STORAGE,
    t('DEV_STORAGE'),
    join(homedir(), '.llamactl'),
  );
  const hfHome = pickWithTestProfile(
    env.HF_HOME,
    t('HF_HOME'),
    join(devStorage, 'cache/huggingface'),
  );
  const llamaCppSrc = pick(env.LLAMA_CPP_SRC, join(devStorage, 'src/llama.cpp'));
  const llamaCppBin = pickWithTestProfile(
    env.LLAMA_CPP_BIN,
    t('LLAMA_CPP_BIN'),
    join(llamaCppSrc, 'build/bin'),
  );
  const llamaCppRoot = pickWithTestProfile(
    env.LLAMA_CPP_ROOT,
    t('LLAMA_CPP_ROOT'),
    join(devStorage, 'ai-models/llama.cpp'),
  );
  const llamaCppModels = pickWithTestProfile(
    env.LLAMA_CPP_MODELS,
    t('LLAMA_CPP_MODELS'),
    join(llamaCppRoot, 'models'),
  );
  const llamaCppCache = pickWithTestProfile(
    env.LLAMA_CPP_CACHE,
    t('LLAMA_CPP_CACHE'),
    join(llamaCppRoot, '.cache'),
  );

  const profile = resolveProfile(env);

  const host = pickWithTestProfile(env.LLAMA_CPP_HOST, t('LLAMA_CPP_HOST'), '127.0.0.1');
  const port = pickWithTestProfile(env.LLAMA_CPP_PORT, t('LLAMA_CPP_PORT'), '8080');
  const advertisedHost = pick(env.LLAMA_CPP_ADVERTISED_HOST, '');

  const lmStudioHost = pick(env.LOCAL_AI_LMSTUDIO_HOST, '127.0.0.1');
  const lmStudioPort = pick(env.LOCAL_AI_LMSTUDIO_PORT, '1234');
  const lmStudioBaseUrl = pick(
    env.LOCAL_AI_LMSTUDIO_BASE_URL,
    `http://${lmStudioHost}:${lmStudioPort}/v1`,
  );
  const llamaCppBaseUrl = pick(
    env.LOCAL_AI_LLAMA_CPP_BASE_URL,
    `http://${host}:${port}/v1`,
  );

  const runtimeDir = pickWithTestProfile(
    env.LOCAL_AI_RUNTIME_DIR,
    t('LOCAL_AI_RUNTIME_DIR'),
    join(devStorage, 'ai-models/local-ai'),
  );
  const defaultModel = resolveDefaultModel(env, profile, llamaCppModels);
  const gemmaCtx = pick(env.LLAMA_CPP_GEMMA_CTX_SIZE, GEMMA_CTX_BY_PROFILE[profile]);
  const qwenCtx = pick(env.LLAMA_CPP_QWEN_CTX_SIZE, QWEN_CTX_BY_PROFILE[profile]);

  const provider = resolveProvider(env.LOCAL_AI_PROVIDER);
  const sourceModel = pick(env.LOCAL_AI_SOURCE_MODEL, defaultModel);
  const contextLength = pick(env.LOCAL_AI_CONTEXT_LENGTH, gemmaCtx);

  let providerUrl: string;
  let apiKey: string;
  let model: string;
  if (provider === 'lmstudio') {
    providerUrl = lmStudioBaseUrl;
    apiKey = pick(env.LM_API_TOKEN, 'local');
    model = pick(
      env.LOCAL_AI_MODEL,
      `local/${sourceModel.split('/')[0] ?? sourceModel}`,
    );
  } else {
    providerUrl = llamaCppBaseUrl;
    apiKey = 'local';
    model = pick(env.LOCAL_AI_MODEL, pick(env.LLAMA_CPP_SERVER_ALIAS, 'local'));
  }

  return {
    DEV_STORAGE: devStorage,
    HF_HOME: hfHome,
    HUGGINGFACE_HUB_CACHE: pickWithTestProfile(
      env.HUGGINGFACE_HUB_CACHE,
      t('HUGGINGFACE_HUB_CACHE'),
      join(hfHome, 'hub'),
    ),
    OLLAMA_MODELS: pickWithTestProfile(
      env.OLLAMA_MODELS,
      t('OLLAMA_MODELS'),
      join(devStorage, 'ai-models/ollama'),
    ),
    LLAMA_CPP_SRC: llamaCppSrc,
    LLAMA_CPP_BIN: llamaCppBin,
    LLAMA_CPP_ROOT: llamaCppRoot,
    LLAMA_CPP_MODELS: llamaCppModels,
    LLAMA_CPP_CACHE: llamaCppCache,
    LLAMA_CPP_LOGS: pickWithTestProfile(
      env.LLAMA_CPP_LOGS,
      t('LLAMA_CPP_LOGS'),
      join(devStorage, 'logs/llama.cpp'),
    ),
    LLAMA_CPP_HOST: host,
    LLAMA_CPP_PORT: port,
    LLAMA_CPP_ADVERTISED_HOST: advertisedHost,
    LLAMA_CPP_MACHINE_PROFILE: profile,
    LLAMA_CPP_GEMMA_CTX_SIZE: gemmaCtx,
    LLAMA_CPP_QWEN_CTX_SIZE: qwenCtx,
    LLAMA_CPP_DEFAULT_MODEL: defaultModel,
    LLAMA_CPP_SERVER_ALIAS: pick(env.LLAMA_CPP_SERVER_ALIAS, 'local'),
    LLAMA_CACHE: pick(env.LLAMA_CACHE, llamaCppCache),
    LOCAL_AI_LMSTUDIO_HOST: lmStudioHost,
    LOCAL_AI_LMSTUDIO_PORT: lmStudioPort,
    LOCAL_AI_LMSTUDIO_BASE_URL: lmStudioBaseUrl,
    LOCAL_AI_LLAMA_CPP_BASE_URL: llamaCppBaseUrl,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LOCAL_AI_ENABLE_THINKING: pick(env.LOCAL_AI_ENABLE_THINKING, 'false'),
    LOCAL_AI_PRESERVE_THINKING: pick(env.LOCAL_AI_PRESERVE_THINKING, 'true'),
    LOCAL_AI_RECOMMENDATIONS_SOURCE: pick(env.LOCAL_AI_RECOMMENDATIONS_SOURCE, 'hf'),
    LOCAL_AI_HF_CACHE_TTL_SECONDS: pick(env.LOCAL_AI_HF_CACHE_TTL_SECONDS, '43200'),
    LOCAL_AI_DISCOVERY_AUTHOR: pick(env.LOCAL_AI_DISCOVERY_AUTHOR, 'unsloth'),
    LOCAL_AI_DISCOVERY_LIMIT: pick(env.LOCAL_AI_DISCOVERY_LIMIT, '24'),
    LOCAL_AI_DISCOVERY_SEARCH: pick(env.LOCAL_AI_DISCOVERY_SEARCH, 'GGUF'),
    LOCAL_AI_CUSTOM_CATALOG_FILE: pick(
      env.LOCAL_AI_CUSTOM_CATALOG_FILE,
      join(runtimeDir, 'curated-models.tsv'),
    ),
    LOCAL_AI_PRESET_OVERRIDES_FILE: pick(
      env.LOCAL_AI_PRESET_OVERRIDES_FILE,
      join(runtimeDir, 'preset-overrides.tsv'),
    ),
    LLAMA_CPP_KEEP_ALIVE_INTERVAL: pick(env.LLAMA_CPP_KEEP_ALIVE_INTERVAL, '5'),
    LLAMA_CPP_KEEP_ALIVE_MAX_BACKOFF: pick(env.LLAMA_CPP_KEEP_ALIVE_MAX_BACKOFF, '30'),
    LLAMA_CPP_AUTO_TUNE_ON_PULL: pick(env.LLAMA_CPP_AUTO_TUNE_ON_PULL, 'true'),
    LLAMA_CPP_AUTO_BENCH_VISION: pick(env.LLAMA_CPP_AUTO_BENCH_VISION, 'true'),
    LOCAL_AI_BENCH_IMAGE: env.LOCAL_AI_BENCH_IMAGE ?? '',
    LOCAL_AI_SOURCE_MODEL: sourceModel,
    LOCAL_AI_PROVIDER: provider,
    LOCAL_AI_CONTEXT_LENGTH: contextLength,
    LOCAL_AI_PROVIDER_URL: providerUrl,
    LOCAL_AI_API_KEY: apiKey,
    LOCAL_AI_MODEL: model,
    OPENAI_BASE_URL: providerUrl,
    OPENAI_API_KEY: apiKey,
  };
}

/**
 * Side-effectful: create the directories llamactl operates inside. Pass
 * the original `env` so the test-profile case can also precreate the
 * (empty) bin dir — that keeps the PATH-prepend guard firing and means
 * every directory the resolver named actually exists on disk before the
 * function returns.
 */
export function ensureDirs(
  resolved: ResolvedEnv,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dirs: string[] = MANAGED_DIRS.map((key) => resolved[key]).filter(
    (d): d is string => Boolean(d),
  );
  // Under a test profile, also precreate the (empty) bin dir. No
  // behaviour change in production: this branch only runs when
  // $LLAMACTL_TEST_PROFILE is set.
  if (env.LLAMACTL_TEST_PROFILE && env.LLAMACTL_TEST_PROFILE.length > 0) {
    dirs.push(resolved.LLAMA_CPP_BIN);
  }
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Swallow — missing dirs are the caller's problem at use site.
    }
  }
}

const POSIX_SAFE = /^[A-Za-z0-9_./:=@%+,\-]+$/;

/**
 * Escape a value for inclusion in a POSIX `export KEY="VALUE"` line.
 * Uses single-quoted form with `'\''` escaping to stay safe regardless
 * of the value (no shell interpretation happens inside single quotes).
 * Plain values matching `POSIX_SAFE` are emitted unquoted for readability.
 */
function shellEscape(value: string): string {
  if (value === '') return "''";
  if (POSIX_SAFE.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Serialise a resolved env as POSIX shell `export` lines plus a single
 * trailing `mkdir -p` line covering the managed dirs. Designed for
 * `eval "$(llamactl env --eval)"` in a shell startup file. When the
 * optional `env` arg carries `$LLAMACTL_TEST_PROFILE`, the bin dir is
 * added to the mkdir pass so a hermetic audit run starts with every
 * path that got rerooted under the profile actually present on disk.
 */
export function formatEvalScript(
  resolved: ResolvedEnv,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(resolved)) {
    lines.push(`export ${key}=${shellEscape(String(value))}`);
  }

  const managed: string[] = MANAGED_DIRS.map((key) => resolved[key]).filter(
    (d): d is string => Boolean(d),
  );
  if (env.LLAMACTL_TEST_PROFILE && env.LLAMACTL_TEST_PROFILE.length > 0) {
    managed.push(resolved.LLAMA_CPP_BIN);
  }
  const dirs = managed.map(shellEscape);
  if (dirs.length > 0) {
    lines.push(`mkdir -p ${dirs.join(' ')} 2>/dev/null || true`);
  }

  // Prepend LLAMA_CPP_BIN to PATH when it exists on disk, mirroring the
  // historical zsh behaviour without re-ordering PATH when the bin dir
  // is missing (e.g. llama.cpp not built yet).
  const bin = resolved.LLAMA_CPP_BIN;
  if (bin) {
    lines.push(
      `if [ -d ${shellEscape(bin)} ]; then case ":$PATH:" in *:${bin}:*) ;; *) export PATH=${shellEscape(bin)}:$PATH ;; esac; fi`,
    );
  }

  return `${lines.join('\n')}\n`;
}
