import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveEnv } from "../src/env.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

// #315: LOCAL_AI_PROVIDER_URL / OPENAI_BASE_URL default to the internal
// proxy, not the tracked llama-server URL. resolveEnv is the parity oracle:
// every case asserts the literal expected value and equality with
// resolveEnv on the same inputs. Spawns get a clean explicit env — no
// process.env inheritance, no network, no services — inside a fresh tmp
// dir per case.

const ENV_ZSH = join(import.meta.dir, "../../../shell/env.zsh");
const LLAMACTL_ZSH = join(import.meta.dir, "../../../shell/llamactl.zsh");

const PX = "http://127.0.0.1:7944/v1";
const TRACKED = "http://127.0.0.1:8080/v1";
const LMS = "http://127.0.0.1:1234/v1";
const CUSTOM_TRACKED = "http://10.0.0.99:9999/v1";
const PROXY_URL = "http://127.0.0.1:9001";
const PROXY_V1 = "http://127.0.0.1:9001/v1";
const TEST_PROFILE_URL = "http://127.0.0.1:65534/v1";
const MACHINE_PROFILE = "macbook-pro-48g";

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-shell-provider-url-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function spawnEnv(vars: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: tmp,
    ...vars,
  };
}

function baseVars(dir: string): Record<string, string> {
  return { DEV_STORAGE: dir, LLAMA_CPP_MACHINE_PROFILE: MACHINE_PROFILE };
}

describe("shell/env.zsh fallback (#315)", () => {
  type VarsFn = (dir: string) => Record<string, string>;
  // [name, vars beyond B, expected LOCAL_AI_PROVIDER_URL]
  const CASES: readonly (readonly [string, VarsFn, string])[] = [
    // kills: LOCAL_AI_PROVIDER_URL="$LOCAL_AI_LLAMA_CPP_BASE_URL" in the
    // fallback's llama.cpp branch.
    ["defaults", (): Record<string, string> => ({}), PX],
    // kills: deriving the provider URL from host:port.
    [
      "LLAMA_CPP_PORT moves only the tracked URL",
      (): Record<string, string> => ({ LLAMA_CPP_PORT: "9090" }),
      PX,
    ],
    // kills: treating a re-fed derived tracked URL as explicit after a port change.
    [
      "seeded shell then LLAMA_CPP_PORT change goes to the proxy",
      (): Record<string, string> => ({
        LOCAL_AI_LLAMA_CPP_BASE_URL: TRACKED,
        LOCAL_AI_LLAMA_CPP_DERIVED_BASE_URL: TRACKED,
        LLAMA_CPP_PORT: "9090",
      }),
      PX,
    ],
    // kills: a port change re-deriving over an explicit tracked URL.
    [
      "explicit tracked URL survives a seeded port change",
      (): Record<string, string> => ({
        LOCAL_AI_LLAMA_CPP_BASE_URL: CUSTOM_TRACKED,
        LOCAL_AI_LLAMA_CPP_DERIVED_BASE_URL: TRACKED,
        LLAMA_CPP_PORT: "9090",
      }),
      CUSTOM_TRACKED,
    ],
    // kills: dropping the LOCAL_AI_PROVIDER_ROUTE=direct opt-out.
    [
      "ROUTE=direct keeps the tracked URL",
      (): Record<string, string> => ({ LOCAL_AI_PROVIDER_ROUTE: "direct" }),
      TRACKED,
    ],
    // kills: the proxy outranking an explicit tracked URL.
    [
      "explicit tracked URL wins, no proxy configured",
      (): Record<string, string> => ({ LOCAL_AI_LLAMA_CPP_BASE_URL: CUSTOM_TRACKED }),
      CUSTOM_TRACKED,
    ],
    // kills: the proxy outranking an explicit tracked URL.
    [
      "explicit tracked URL wins over a configured proxy",
      (): Record<string, string> => ({
        LOCAL_AI_LLAMA_CPP_BASE_URL: CUSTOM_TRACKED,
        LLAMACTL_INTERNAL_PROXY_URL: PROXY_URL,
      }),
      CUSTOM_TRACKED,
    ],
    // kills: treating any non-empty tracked URL as explicit.
    [
      "tracked URL equal to the host:port default still proxies",
      (): Record<string, string> => ({ LOCAL_AI_LLAMA_CPP_BASE_URL: TRACKED }),
      PX,
    ],
    // kills: missing /v1 normalisation.
    [
      "proxy URL bare host:port",
      (): Record<string, string> => ({ LLAMACTL_INTERNAL_PROXY_URL: PROXY_URL }),
      PROXY_V1,
    ],
    // kills: missing trailing-slash stripping.
    [
      "proxy URL with a double trailing slash",
      (): Record<string, string> => ({ LLAMACTL_INTERNAL_PROXY_URL: `${PROXY_URL}//` }),
      PROXY_V1,
    ],
    // kills: missing trailing-slash stripping ahead of the /v1 check.
    [
      "proxy URL with a trailing /v1/",
      (): Record<string, string> => ({ LLAMACTL_INTERNAL_PROXY_URL: `${PROXY_URL}/v1/` }),
      PROXY_V1,
    ],
    // kills: `${VAR+set}`-style empty handling.
    [
      "empty proxy URL counts as unset",
      (): Record<string, string> => ({ LLAMACTL_INTERNAL_PROXY_URL: "" }),
      PX,
    ],
    // kills: dialling the proxy under a hermetic test profile. DEV_STORAGE:""
    // is unset for both `[ -z "$DEV_STORAGE" ]` and the resolver's
    // empty-is-unset rule.
    [
      "test profile keeps the sentinel tracked URL",
      (dir): Record<string, string> => ({ DEV_STORAGE: "", LLAMACTL_TEST_PROFILE: dir }),
      TEST_PROFILE_URL,
    ],
    // kills: applying the proxy rule to the lmstudio branch.
    [
      "lmstudio ignores the proxy",
      (): Record<string, string> => ({
        LOCAL_AI_PROVIDER: "lmstudio",
        LLAMACTL_INTERNAL_PROXY_URL: PROXY_URL,
      }),
      LMS,
    ],
    // kills: reading the stale value back with `${LOCAL_AI_PROVIDER_URL:-...}`.
    [
      "stale inherited provider URLs are ignored",
      (): Record<string, string> => ({ LOCAL_AI_PROVIDER_URL: TRACKED, OPENAI_BASE_URL: TRACKED }),
      PX,
    ],
  ];

  test.each(CASES)("%s", (_name, vars, expected) => {
    const caseVars = vars(tmp);
    const resolvedInput: NodeJS.ProcessEnv = { ...baseVars(tmp), ...caseVars };
    const shellVars: Record<string, string> = {
      ...baseVars(tmp),
      LLAMACTL_HOME: join(tmp, "no-cli"),
      ...caseVars,
    };

    const proc = Bun.spawnSync(
      [
        "bash",
        "-c",
        '. "$1"; printf "%s|%s|%s\\n" "$LOCAL_AI_PROVIDER_URL" "$OPENAI_BASE_URL" "$LOCAL_AI_LLAMA_CPP_BASE_URL"',
        "_",
        ENV_ZSH,
      ],
      { env: spawnEnv(shellVars), stdout: "pipe", stderr: "pipe" },
    );

    const stderr = new TextDecoder().decode(proc.stderr);
    const stdout = new TextDecoder().decode(proc.stdout);
    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe("");

    const [providerUrl, openAiBaseUrl, trackedUrl] = stdout.trim().split("|");
    const resolved = resolveEnv(resolvedInput);
    expect(providerUrl).toBe(expected);
    expect(openAiBaseUrl).toBe(expected);
    expect(providerUrl).toBe(resolved.LOCAL_AI_PROVIDER_URL);
    expect(openAiBaseUrl).toBe(resolved.OPENAI_BASE_URL);
    expect(trackedUrl).toBe(resolved.LOCAL_AI_LLAMA_CPP_BASE_URL);
  });
});

describe("shell/llamactl.zsh _local_ai_sync_env (#315)", () => {
  const seed = (input: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...input,
    ...Object.fromEntries(
      (Object.entries(resolveEnv(input)) as [string, unknown][]).map(
        ([key, value]): [string, string] => [key, String(value)],
      ),
    ),
  });

  type SyncInput = {
    env: NodeJS.ProcessEnv;
    patch?: Record<string, string>;
    unseeded?: boolean;
  };
  type InputFn = (dir: string) => SyncInput;

  // [name, seeded-shell input, expected LOCAL_AI_PROVIDER_URL]
  const CASES: readonly (readonly [string, InputFn, string])[] = [
    // kills: LOCAL_AI_PROVIDER_URL="$LOCAL_AI_LLAMA_CPP_BASE_URL" in sync.
    ["seeded defaults", (dir): SyncInput => ({ env: baseVars(dir) }), PX],
    // kills: treating the seeded tracked URL as explicit after a port change.
    [
      "seeded then LLAMA_CPP_PORT change goes to the proxy",
      (dir): SyncInput => ({ env: baseVars(dir), patch: { LLAMA_CPP_PORT: "9090" } }),
      PX,
    ],
    // kills: direct mode following the stale seeded tracked URL instead of the changed port.
    [
      "seeded ROUTE=direct then port change follows the port",
      (dir): SyncInput => ({
        env: { ...baseVars(dir), LOCAL_AI_PROVIDER_ROUTE: "direct" },
        patch: { LLAMA_CPP_PORT: "9090" },
      }),
      "http://127.0.0.1:9090/v1",
    ],
    // kills: a port change re-deriving over an explicit seeded tracked URL.
    [
      "seeded explicit tracked URL survives a port change",
      (dir): SyncInput => ({
        env: { ...baseVars(dir), LOCAL_AI_LLAMA_CPP_BASE_URL: CUSTOM_TRACKED },
        patch: { LLAMA_CPP_PORT: "9090" },
      }),
      CUSTOM_TRACKED,
    ],
    // kills: reusing the stale lmstudio provider URL after a provider switch.
    [
      "lmstudio seed then switch to llama.cpp",
      (dir): SyncInput => ({
        env: { ...baseVars(dir), LOCAL_AI_PROVIDER: "lmstudio" },
        patch: { LOCAL_AI_PROVIDER: "llama.cpp" },
      }),
      PX,
    ],
    // kills: dropping the LOCAL_AI_PROVIDER_ROUTE=direct opt-out.
    [
      "seeded ROUTE=direct keeps the tracked URL",
      (dir): SyncInput => ({ env: { ...baseVars(dir), LOCAL_AI_PROVIDER_ROUTE: "direct" } }),
      TRACKED,
    ],
    // kills: ignoring LLAMACTL_INTERNAL_PROXY_URL.
    [
      "seeded proxy override normalises to /v1",
      (dir): SyncInput => ({ env: { ...baseVars(dir), LLAMACTL_INTERNAL_PROXY_URL: PROXY_URL } }),
      PROXY_V1,
    ],
    // kills: the proxy outranking an explicit tracked URL.
    [
      "seeded explicit tracked URL wins",
      (dir): SyncInput => ({
        env: { ...baseVars(dir), LOCAL_AI_LLAMA_CPP_BASE_URL: CUSTOM_TRACKED },
      }),
      CUSTOM_TRACKED,
    ],
    // kills: dialling the proxy under a hermetic test profile.
    [
      "seeded test profile keeps the sentinel",
      (dir): SyncInput => ({
        env: { LLAMACTL_TEST_PROFILE: dir, LLAMA_CPP_MACHINE_PROFILE: MACHINE_PROFILE },
      }),
      TEST_PROFILE_URL,
    ],
    // kills: printing an empty provider URL when nothing is seeded.
    ["unseeded shell", (): SyncInput => ({ env: {}, unseeded: true }), PX],
    // kills: dropping the port=65534 test-profile branch in the mirror.
    [
      "unseeded test profile without LLAMA_CPP_PORT keeps the sentinel",
      (dir): SyncInput => ({ env: { LLAMACTL_TEST_PROFILE: dir }, unseeded: true }),
      TEST_PROFILE_URL,
    ],
    // kills: dropping the trailing-slash strip loop in the mirror.
    [
      "unseeded proxy URL with a trailing slash",
      (dir): SyncInput => ({
        env: { ...baseVars(dir), LLAMACTL_INTERNAL_PROXY_URL: `${PROXY_URL}/` },
        unseeded: true,
      }),
      PROXY_V1,
    ],
    // kills: dropping the trailing-slash strip loop ahead of the /v1 check.
    [
      "unseeded proxy URL with a trailing /v1/",
      (dir): SyncInput => ({
        env: { ...baseVars(dir), LLAMACTL_INTERNAL_PROXY_URL: `${PROXY_URL}/v1/` },
        unseeded: true,
      }),
      PROXY_V1,
    ],
    // kills: the mirror's tracked default hardcoding port 8080.
    [
      "unseeded ROUTE=direct follows LLAMA_CPP_PORT",
      (dir): SyncInput => ({
        env: { ...baseVars(dir), LOCAL_AI_PROVIDER_ROUTE: "direct", LLAMA_CPP_PORT: "9090" },
        unseeded: true,
      }),
      "http://127.0.0.1:9090/v1",
    ],
    // kills: applying the proxy rule to the lmstudio branch.
    [
      "seeded lmstudio stays on lmstudio",
      (dir): SyncInput => ({ env: { ...baseVars(dir), LOCAL_AI_PROVIDER: "lmstudio" } }),
      LMS,
    ],
  ];

  const ZSH_CMD =
    'source "$1"; _local_ai_source_model(){ print -r -- x/y.gguf; }; ' +
    "_local_ai_lmstudio_model_key(){ print -r -- k; }; " +
    '_local_ai_sync_env; print -r -- "$LOCAL_AI_PROVIDER_URL|$OPENAI_BASE_URL"';

  test.skipIf(!Bun.which("zsh")).each(CASES)(
    "shell/llamactl.zsh _local_ai_sync_env %s",
    (_name, inputFn, expected) => {
      const spec = inputFn(tmp);
      const shellVars: NodeJS.ProcessEnv = {
        ...(spec.unseeded === true ? spec.env : seed(spec.env)),
        ...(spec.patch ?? {}),
      };

      const proc = Bun.spawnSync(["zsh", "-f", "-c", ZSH_CMD, "_", LLAMACTL_ZSH], {
        env: spawnEnv(shellVars),
        stdout: "pipe",
        stderr: "pipe",
      });

      const stderr = new TextDecoder().decode(proc.stderr);
      const stdout = new TextDecoder().decode(proc.stdout);
      expect(proc.exitCode).toBe(0);
      expect(stderr).toBe("");

      const [providerUrl, openAiBaseUrl] = stdout.trim().split("|");
      const resolved = resolveEnv(shellVars);
      expect(providerUrl).toBe(expected);
      expect(openAiBaseUrl).toBe(expected);
      expect(providerUrl).toBe(resolved.LOCAL_AI_PROVIDER_URL);
      expect(openAiBaseUrl).toBe(resolved.OPENAI_BASE_URL);
    },
  );
});
