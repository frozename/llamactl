import { describe, expect, test } from "bun:test";

import {
  OMLX_MANAGED_MODEL_SETTINGS_KEYS,
  OMLX_MODEL_SETTINGS_REVISION,
} from "../../src/engines/omlx-model-settings.js";

// #282 DF-09: oMLX prompt-cache identity — a canonical sha256 over model,
// engine build, artifact identity, cache epoch and the cache-affecting
// TurboQuant settings, plus the retain/invalidate decision on top. The module
// does not exist at the pinned base; the specifier is widened to `string` so
// tsc cannot resolve it — a literal specifier would be a resolution error,
// not an assertion failure.
const MODULE_SPEC = "../../src/engines/omlx-cache-identity.js" as string;

type OmlxCacheIdentityArtifact = {
  path: string;
  sizeBytes?: number;
  mtimeMs?: number;
  sha256?: string;
};

type OmlxCacheIdentityInput = {
  modelId: string;
  engineBuild: string;
  artifact: OmlxCacheIdentityArtifact;
  settings: Record<string, unknown>;
  cacheEpoch?: number;
};

type OmlxCacheIdentityResult = { ok: true; identity: string } | { ok: false; reason: string };

type OmlxCacheRetentionDecision =
  | { action: "retain"; reason: "IdentityMatch"; identity: string }
  | { action: "invalidate"; reason: string; identity: string | null };

type OmlxCacheIdentityModule = {
  OMLX_CACHE_AFFECTING_SETTINGS_KEYS: readonly string[];
  OMLX_CACHE_NEUTRAL_SETTINGS_KEYS: readonly string[];
  deriveOmlxCacheIdentity(input: OmlxCacheIdentityInput): OmlxCacheIdentityResult;
  decideOmlxCacheRetention(
    previousIdentity: string | null | undefined,
    input: OmlxCacheIdentityInput,
  ): OmlxCacheRetentionDecision;
};

type DeriveOmlxCacheIdentity = OmlxCacheIdentityModule["deriveOmlxCacheIdentity"];
type DecideOmlxCacheRetention = OmlxCacheIdentityModule["decideOmlxCacheRetention"];
type SettingsMutation = [string, Record<string, unknown>];
type ArtifactIdentityMutation = [string, OmlxCacheIdentityArtifact, OmlxCacheIdentityArtifact];

const BASE_ARTIFACT_PATH = "/models/mlx-community/Qwen3-8B-4bit";

const BASE: OmlxCacheIdentityInput = {
  modelId: "mlx-community/Qwen3-8B-4bit",
  engineBuild: OMLX_MODEL_SETTINGS_REVISION,
  artifact: {
    path: BASE_ARTIFACT_PATH,
    sizeBytes: 4600000000,
    mtimeMs: 1767225600000,
  },
  settings: {
    max_context_window: 32768,
    turboquant_kv_enabled: true,
    turboquant_kv_bits: 4,
  },
};

// engineBuild is deliberately absent; the cast keeps tsc happy while the
// runtime input stays invalid.
const INPUT_WITHOUT_ENGINE_BUILD = {
  modelId: BASE.modelId,
  artifact: BASE.artifact,
  settings: BASE.settings,
} as unknown as OmlxCacheIdentityInput;

async function loadModule(): Promise<Partial<OmlxCacheIdentityModule>> {
  try {
    return (await import(MODULE_SPEC)) as Partial<OmlxCacheIdentityModule>;
  } catch {
    return {};
  }
}

function requireDerive(mod: Partial<OmlxCacheIdentityModule>): DeriveOmlxCacheIdentity {
  const derive = mod.deriveOmlxCacheIdentity;
  expect(typeof derive).toBe("function");
  if (typeof derive !== "function") {
    throw new Error("deriveOmlxCacheIdentity is not a function");
  }
  return derive;
}

function requireDecide(mod: Partial<OmlxCacheIdentityModule>): DecideOmlxCacheRetention {
  const decide = mod.decideOmlxCacheRetention;
  expect(typeof decide).toBe("function");
  if (typeof decide !== "function") {
    throw new Error("decideOmlxCacheRetention is not a function");
  }
  return decide;
}

function identityOf(derive: DeriveOmlxCacheIdentity, input: OmlxCacheIdentityInput): string {
  const result = derive(input);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`derive failed: ${result.reason}`);
  }
  return result.identity;
}

function withSettings(patch: Record<string, unknown>): OmlxCacheIdentityInput {
  return { ...BASE, settings: { ...BASE.settings, ...patch } };
}

const CACHE_AFFECTING_MUTATIONS: SettingsMutation[] = [
  ["turboquant_kv_bits 4 -> 8", { turboquant_kv_bits: 8 }],
  ["turboquant_skip_last -> false", { turboquant_skip_last: false }],
  ["turboquant_kv_enabled -> false", { turboquant_kv_enabled: false }],
];

const CACHE_NEUTRAL_MUTATIONS: SettingsMutation[] = [
  ["max_context_window", { max_context_window: 65536 }],
  ["max_tokens", { max_tokens: 4096 }],
  ["chat_template_kwargs", { chat_template_kwargs: { enable_thinking: false } }],
  ["forced_ct_kwargs", { forced_ct_kwargs: ["enable_thinking"] }],
  ["enable_thinking", { enable_thinking: false }],
  ["preserve_thinking", { preserve_thinking: true }],
  ["thinking budget", { thinking_budget_enabled: true, thinking_budget_tokens: 2048 }],
  ["reasoning_parser", { reasoning_parser: "qwen3" }],
  [
    "specprefill",
    {
      specprefill_enabled: true,
      specprefill_draft_model: "/models/draft",
      specprefill_keep_pct: 0.2,
      specprefill_threshold: 8192,
    },
  ],
  ["mtp_num_draft_tokens", { mtp_num_draft_tokens: 3 }],
];

const ARTIFACT_IDENTITY_MUTATIONS: ArtifactIdentityMutation[] = [
  ["sizeBytes +1", BASE.artifact, { ...BASE.artifact, sizeBytes: 4600000001 }],
  ["mtimeMs +1", BASE.artifact, { ...BASE.artifact, mtimeMs: 1767225600001 }],
  [
    "different path",
    BASE.artifact,
    { ...BASE.artifact, path: "/models/mlx-community/Qwen3-8B-4bit-mirror" },
  ],
  [
    "sha256 a->b",
    { path: BASE_ARTIFACT_PATH, sha256: "a".repeat(64) },
    { path: BASE_ARTIFACT_PATH, sha256: "b".repeat(64) },
  ],
];

const ARTIFACT_UNAVAILABLE: [string, OmlxCacheIdentityArtifact][] = [
  ["path only", { path: BASE_ARTIFACT_PATH }],
  ["missing mtimeMs", { path: BASE_ARTIFACT_PATH, sizeBytes: 4600000000 }],
  ["empty path", { path: "", sizeBytes: 1, mtimeMs: 1 }],
  [
    "uppercase sha256",
    { path: BASE_ARTIFACT_PATH, sha256: "A".repeat(64), sizeBytes: 1, mtimeMs: 1 },
  ],
  ["short sha256", { path: BASE_ARTIFACT_PATH, sha256: "a".repeat(63), sizeBytes: 1, mtimeMs: 1 }],
  // An empty sha256 falls back to sizeBytes/mtimeMs (T17); with neither it fails.
  ["empty sha256 only", { path: BASE_ARTIFACT_PATH, sha256: "" }],
  // A present sha256 that is not a string fails even with a valid size and
  // mtime: only the empty string falls back. The casts keep tsc happy while
  // the runtime input stays invalid.
  ...(
    [
      ["number", 123],
      ["null", null],
      ["boolean", true],
      ["object", { hex: "a".repeat(64) }],
    ] as [string, unknown][]
  ).map(([kind, sha256]): [string, OmlxCacheIdentityArtifact] => [
    `${kind} sha256 with size and mtime`,
    {
      path: BASE_ARTIFACT_PATH,
      sha256,
      sizeBytes: 1,
      mtimeMs: 1,
    } as unknown as OmlxCacheIdentityArtifact,
  ]),
  ["artifact missing", undefined as unknown as OmlxCacheIdentityArtifact],
  ["artifact null", null as unknown as OmlxCacheIdentityArtifact],
  ["negative sizeBytes", { path: BASE_ARTIFACT_PATH, sizeBytes: -1, mtimeMs: 1 }],
  ["fractional sizeBytes", { path: BASE_ARTIFACT_PATH, sizeBytes: 1.5, mtimeMs: 1 }],
  ["NaN sizeBytes", { path: BASE_ARTIFACT_PATH, sizeBytes: Number.NaN, mtimeMs: 1 }],
  [
    "Infinity sizeBytes",
    { path: BASE_ARTIFACT_PATH, sizeBytes: Number.POSITIVE_INFINITY, mtimeMs: 1 },
  ],
  ["negative mtimeMs", { path: BASE_ARTIFACT_PATH, sizeBytes: 1, mtimeMs: -1 }],
  ["fractional mtimeMs", { path: BASE_ARTIFACT_PATH, sizeBytes: 1, mtimeMs: 1.5 }],
  ["NaN mtimeMs", { path: BASE_ARTIFACT_PATH, sizeBytes: 1, mtimeMs: Number.NaN }],
  [
    "Infinity mtimeMs",
    { path: BASE_ARTIFACT_PATH, sizeBytes: 1, mtimeMs: Number.POSITIVE_INFINITY },
  ],
  [
    "-Infinity mtimeMs",
    { path: BASE_ARTIFACT_PATH, sizeBytes: 1, mtimeMs: Number.NEGATIVE_INFINITY },
  ],
];

const ENGINE_BUILD_UNAVAILABLE: [string, OmlxCacheIdentityInput][] = [
  ["empty string", { ...BASE, engineBuild: "" }],
  ["whitespace", { ...BASE, engineBuild: "   " }],
  ["deleted", INPUT_WITHOUT_ENGINE_BUILD],
];

// modelId is deliberately absent or non-string; the casts keep tsc happy while
// the runtime input stays invalid.
const MODEL_ID_UNAVAILABLE: [string, OmlxCacheIdentityInput][] = [
  ["empty string", { ...BASE, modelId: "" }],
  ["whitespace", { ...BASE, modelId: "  \t" }],
  [
    "deleted",
    {
      engineBuild: BASE.engineBuild,
      artifact: BASE.artifact,
      settings: BASE.settings,
    } as unknown as OmlxCacheIdentityInput,
  ],
  ["number", { ...BASE, modelId: 42 } as unknown as OmlxCacheIdentityInput],
  ["null", { ...BASE, modelId: null } as unknown as OmlxCacheIdentityInput],
];

// Values that have no unambiguous canonical JSON form. NaN and Infinity both
// stringify to null. sortObjectKeys rebuilds a Date or Map from its
// Object.entries, which are empty, so either would hash as {}. -0 stringifies
// to 0, and undefined
// or a hole inside an array becomes null. Hashing any of them would let
// distinct values collide.
const INVALID_SETTINGS: [string, OmlxCacheIdentityInput][] = [
  ["unknown key NaN", withSettings({ future_kv_layout: Number.NaN })],
  ["unknown key Infinity", withSettings({ future_kv_layout: Number.POSITIVE_INFINITY })],
  ["unknown key Date", withSettings({ future_kv_layout: new Date(0) })],
  ["unknown key Map", withSettings({ future_kv_layout: new Map([["a", 1]]) })],
  ["unknown key function", withSettings({ future_kv_layout: () => 1 })],
  ["unknown key bigint", withSettings({ future_kv_layout: 1n })],
  ["unknown key nested undefined", withSettings({ future_kv_layout: [1, undefined] })],
  ["unknown key nested NaN", withSettings({ future_kv_layout: { a: Number.NaN } })],
  ["unknown key -0", withSettings({ future_kv_layout: -0 })],
  ["unknown key nested -0", withSettings({ future_kv_layout: { a: [-0] } })],
  // eslint-disable-next-line no-sparse-arrays
  ["unknown key sparse array", withSettings({ future_kv_layout: [1, , 2] })],
  ["turboquant_kv_enabled string", withSettings({ turboquant_kv_enabled: "true" })],
  ["turboquant_kv_bits NaN", withSettings({ turboquant_kv_bits: Number.NaN })],
  ["turboquant_kv_bits string", withSettings({ turboquant_kv_bits: "8" })],
  ["turboquant_skip_last string", withSettings({ turboquant_skip_last: "false" })],
  ["settings null", { ...BASE, settings: null } as unknown as OmlxCacheIdentityInput],
  ["settings array", { ...BASE, settings: [] } as unknown as OmlxCacheIdentityInput],
];

const INVALID_CACHE_EPOCHS: [string, number][] = [
  ["negative", -1],
  ["fractional", 1.5],
  ["NaN", Number.NaN],
];

describe("#282 DF-09 oMLX cache identity", () => {
  test("T1 cache-affecting keys partition the managed settings keys", async () => {
    const mod = await loadModule();
    const affecting = mod.OMLX_CACHE_AFFECTING_SETTINGS_KEYS;
    const neutral = mod.OMLX_CACHE_NEUTRAL_SETTINGS_KEYS;

    // Kills: dropping a managed key from both lists, or moving mtp/specprefill
    // into AFFECTING.
    expect(Array.isArray(affecting)).toBe(true);
    expect(Array.isArray(neutral)).toBe(true);
    if (affecting === undefined || neutral === undefined) {
      throw new Error("unreachable");
    }
    expect(affecting).toEqual([
      "turboquant_kv_enabled",
      "turboquant_kv_bits",
      "turboquant_skip_last",
    ]);
    expect([...affecting, ...neutral].sort()).toEqual([...OMLX_MANAGED_MODEL_SETTINGS_KEYS].sort());
    expect(affecting.filter((key) => neutral.includes(key))).toEqual([]);
  });

  test("T2 derive emits deterministic golden identities", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);

    // Kills: changing the hash or prefix, unsorted keys, omitting defaults,
    // or leaving cacheEpoch/engineBuild out of the payload.
    expect(derive(BASE)).toEqual({
      ok: true,
      identity: "omlx-cache-v1:e32e7770181ee15fa1c610aa67f54311eab3b3a3390ddf1b48847b88e91c7f86",
    });

    const sha256ArtifactInput: OmlxCacheIdentityInput = {
      modelId: BASE.modelId,
      engineBuild: BASE.engineBuild,
      artifact: { path: BASE_ARTIFACT_PATH, sha256: "a".repeat(64) },
      settings: {},
    };
    expect(derive(sha256ArtifactInput)).toEqual({
      ok: true,
      identity: "omlx-cache-v1:4c80b1f0cf36a74e79ddd26e1f9f3f354cb838cdc680e1500ebe4cd06de10db3",
    });

    expect(derive({ ...BASE, cacheEpoch: 3 })).toEqual({
      ok: true,
      identity: "omlx-cache-v1:cc061cb5da8eee11deacdc618bf0c126aab785dbabdd3018969133ef10ec58d0",
    });
  });

  test("T3 identity is independent of settings and artifact key order", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);
    const identity = identityOf(derive, BASE);

    // Kills: JSON.stringify without a recursive key sort.
    const reordered: OmlxCacheIdentityInput = {
      settings: {
        turboquant_kv_bits: 4,
        turboquant_kv_enabled: true,
        max_context_window: 32768,
      },
      artifact: {
        mtimeMs: 1767225600000,
        sizeBytes: 4600000000,
        path: BASE_ARTIFACT_PATH,
      },
      engineBuild: OMLX_MODEL_SETTINGS_REVISION,
      modelId: "mlx-community/Qwen3-8B-4bit",
    };
    expect(derive(reordered)).toEqual({ ok: true, identity });
  });

  test("T4 a matching previous identity retains", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);
    const decide = requireDecide(mod);
    const identity = identityOf(derive, BASE);

    // Kills: always-invalidate.
    expect(decide(identity, BASE)).toEqual({
      action: "retain",
      reason: "IdentityMatch",
      identity,
    });
  });

  for (const [name, patch] of CACHE_AFFECTING_MUTATIONS) {
    test(`T5 cache-affecting settings change invalidates: ${name}`, async () => {
      const mod = await loadModule();
      const derive = requireDerive(mod);
      const decide = requireDecide(mod);
      const previousIdentity = identityOf(derive, BASE);
      const mutated = withSettings(patch);
      const nextIdentity = identityOf(derive, mutated);

      // Kills: excluding any one TurboQuant key from the identity payload.
      expect(nextIdentity).not.toBe(previousIdentity);
      expect(decide(previousIdentity, mutated)).toEqual({
        action: "invalidate",
        reason: "IdentityChanged",
        identity: nextIdentity,
      });
    });
  }

  for (const [name, patch] of CACHE_NEUTRAL_MUTATIONS) {
    test(`T6 neutral settings change retains: ${name}`, async () => {
      const mod = await loadModule();
      const derive = requireDerive(mod);
      const decide = requireDecide(mod);
      const identity = identityOf(derive, BASE);
      const mutated = withSettings(patch);

      // Kills: hashing the whole settings object.
      expect(identityOf(derive, mutated)).toBe(identity);
      expect(decide(identity, mutated)).toEqual({
        action: "retain",
        reason: "IdentityMatch",
        identity,
      });
    });
  }

  test("T7 contract defaults normalise TurboQuant", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);

    // Kills: not normalising bits/skip_last when TurboQuant is disabled, or
    // not applying the upstream defaults 4/true.
    const disabledSettings = identityOf(derive, { ...BASE, settings: {} });
    const disabledExplicit = identityOf(derive, {
      ...BASE,
      settings: { turboquant_kv_enabled: false, turboquant_kv_bits: 8 },
    });
    expect(disabledExplicit).toBe(disabledSettings);

    const enabledImplicit = identityOf(derive, {
      ...BASE,
      settings: { turboquant_kv_enabled: true },
    });
    const enabledExplicit = identityOf(derive, {
      ...BASE,
      settings: {
        turboquant_kv_enabled: true,
        turboquant_kv_bits: 4,
        turboquant_skip_last: true,
      },
    });
    expect(enabledExplicit).toBe(enabledImplicit);
  });

  for (const [name, previousArtifact, nextArtifact] of ARTIFACT_IDENTITY_MUTATIONS) {
    test(`T8 artifact identity change invalidates: ${name}`, async () => {
      const mod = await loadModule();
      const derive = requireDerive(mod);
      const decide = requireDecide(mod);
      const previousInput: OmlxCacheIdentityInput = { ...BASE, artifact: previousArtifact };
      const nextInput: OmlxCacheIdentityInput = { ...BASE, artifact: nextArtifact };
      const previousIdentity = identityOf(derive, previousInput);
      const nextIdentity = identityOf(derive, nextInput);

      // Kills: dropping any artifact field.
      expect(nextIdentity).not.toBe(previousIdentity);
      expect(decide(previousIdentity, nextInput)).toEqual({
        action: "invalidate",
        reason: "IdentityChanged",
        identity: nextIdentity,
      });
    });
  }

  test("T9 sha256 takes precedence over sizeBytes and mtimeMs", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);
    const decide = requireDecide(mod);
    const artifact = {
      path: BASE_ARTIFACT_PATH,
      sha256: "a".repeat(64),
      sizeBytes: 4600000000,
      mtimeMs: 1767225600000,
    };
    const input: OmlxCacheIdentityInput = { ...BASE, artifact };
    const identity = identityOf(derive, input);

    // Kills: hashing size/mtime alongside sha256.
    const mutations: OmlxCacheIdentityArtifact[] = [
      { ...artifact, sizeBytes: artifact.sizeBytes + 1 },
      { ...artifact, mtimeMs: artifact.mtimeMs + 1 },
    ];
    for (const mutatedArtifact of mutations) {
      expect(decide(identity, { ...input, artifact: mutatedArtifact })).toEqual({
        action: "retain",
        reason: "IdentityMatch",
        identity,
      });
    }
  });

  for (const [name, artifact] of ARTIFACT_UNAVAILABLE) {
    test(`T10 underivable artifact identity fails closed: ${name}`, async () => {
      const mod = await loadModule();
      const derive = requireDerive(mod);
      const decide = requireDecide(mod);
      const input: OmlxCacheIdentityInput = { ...BASE, artifact };
      const previousIdentity = identityOf(derive, BASE);

      // Kills: treating a missing artifact identity as a match.
      expect(derive(input)).toMatchObject({
        ok: false,
        reason: "ArtifactIdentityUnavailable",
      });
      expect(decide(previousIdentity, input)).toEqual({
        action: "invalidate",
        reason: "ArtifactIdentityUnavailable",
        identity: null,
      });
    });
  }

  test("T11 engine build change invalidates", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);
    const decide = requireDecide(mod);
    const previousIdentity = identityOf(derive, BASE);
    const mutated = { ...BASE, engineBuild: "0".repeat(40) };
    const nextIdentity = identityOf(derive, mutated);

    // Kills: dropping engineBuild from the payload.
    expect(nextIdentity).not.toBe(previousIdentity);
    expect(decide(previousIdentity, mutated)).toEqual({
      action: "invalidate",
      reason: "IdentityChanged",
      identity: nextIdentity,
    });
  });

  for (const [name, input] of ENGINE_BUILD_UNAVAILABLE) {
    test(`T11 unavailable engine build fails closed: ${name}`, async () => {
      const mod = await loadModule();
      const derive = requireDerive(mod);
      const decide = requireDecide(mod);
      const previousIdentity = identityOf(derive, BASE);

      // Kills: defaulting a missing build to a constant.
      expect(derive(input)).toMatchObject({ ok: false, reason: "EngineBuildUnavailable" });
      expect(decide(previousIdentity, input)).toEqual({
        action: "invalidate",
        reason: "EngineBuildUnavailable",
        identity: null,
      });
    });
  }

  test("T12 cache epoch change invalidates and zero equals omitted", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);
    const decide = requireDecide(mod);
    const previousIdentity = identityOf(derive, BASE);

    // Kills: dropping cacheEpoch from the payload.
    const epochOne = { ...BASE, cacheEpoch: 1 };
    const epochOneIdentity = identityOf(derive, epochOne);
    expect(epochOneIdentity).not.toBe(previousIdentity);
    expect(decide(previousIdentity, epochOne)).toEqual({
      action: "invalidate",
      reason: "IdentityChanged",
      identity: epochOneIdentity,
    });

    // Kills: no default of 0 for a missing cacheEpoch.
    expect(identityOf(derive, { ...BASE, cacheEpoch: 0 })).toBe(previousIdentity);
  });

  for (const [name, cacheEpoch] of INVALID_CACHE_EPOCHS) {
    test(`T12 invalid cache epoch fails closed: ${name}`, async () => {
      const mod = await loadModule();
      const derive = requireDerive(mod);
      const decide = requireDecide(mod);
      const input = { ...BASE, cacheEpoch };
      const previousIdentity = identityOf(derive, BASE);

      // Kills: accepting a non-integer epoch.
      expect(derive(input)).toMatchObject({ ok: false, reason: "CacheEpochInvalid" });
      expect(decide(previousIdentity, input)).toEqual({
        action: "invalidate",
        reason: "CacheEpochInvalid",
        identity: null,
      });
    });
  }

  test("T13 absent previous identity invalidates", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);
    const decide = requireDecide(mod);
    const identity = identityOf(derive, BASE);
    const expected: OmlxCacheRetentionDecision = {
      action: "invalidate",
      reason: "NoPreviousIdentity",
      identity,
    };

    // Kills: retaining when nothing was recorded.
    expect(decide(undefined, BASE)).toEqual(expected);
    expect(decide(null, BASE)).toEqual(expected);
  });

  test("T14 modelId change invalidates", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);
    const decide = requireDecide(mod);
    const previousIdentity = identityOf(derive, BASE);
    const mutated = { ...BASE, modelId: "mlx-community/Qwen3-4B-4bit" };
    const nextIdentity = identityOf(derive, mutated);

    // Kills: dropping modelId.
    expect(nextIdentity).not.toBe(previousIdentity);
    expect(decide(previousIdentity, mutated)).toEqual({
      action: "invalidate",
      reason: "IdentityChanged",
      identity: nextIdentity,
    });
  });

  test("T11 surrounding whitespace in engineBuild does not change the identity", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);
    const identity = identityOf(derive, BASE);

    // Kills: hashing the untrimmed build string.
    expect(derive({ ...BASE, engineBuild: `  ${OMLX_MODEL_SETTINGS_REVISION}\n` })).toEqual({
      ok: true,
      identity,
    });
  });

  for (const [name, input] of MODEL_ID_UNAVAILABLE) {
    test(`T14 unavailable modelId fails closed: ${name}`, async () => {
      const mod = await loadModule();
      const derive = requireDerive(mod);
      const decide = requireDecide(mod);
      const previousIdentity = identityOf(derive, BASE);

      // Kills: hashing a missing or non-string modelId.
      expect(derive(input)).toMatchObject({ ok: false, reason: "ModelIdUnavailable" });
      expect(decide(previousIdentity, input)).toEqual({
        action: "invalidate",
        reason: "ModelIdUnavailable",
        identity: null,
      });
    });
  }

  test("T14 surrounding whitespace in modelId does not change the identity", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);
    const identity = identityOf(derive, BASE);

    // Kills: hashing the untrimmed model id.
    expect(derive({ ...BASE, modelId: ` ${BASE.modelId}  ` })).toEqual({ ok: true, identity });
  });

  test("T15 derive does not mutate its input", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);
    const input = structuredClone(BASE);
    const before = structuredClone(input);

    // Kills: in-place normalisation of the input.
    expect(derive(input).ok).toBe(true);
    expect(input).toEqual(before);
  });

  test("T16 a fractional stat mtimeMs must be truncated by the caller", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);
    const decide = requireDecide(mod);
    const previousIdentity = identityOf(derive, BASE);
    const statMtimeMs = 1767225600000.75;
    const input: OmlxCacheIdentityInput = {
      ...BASE,
      artifact: { ...BASE.artifact, mtimeMs: statMtimeMs },
    };

    // Kills: accepting a fractional mtimeMs, or rounding it internally.
    expect(decide(previousIdentity, input)).toEqual({
      action: "invalidate",
      reason: "ArtifactIdentityUnavailable",
      identity: null,
    });
    expect(
      identityOf(derive, {
        ...BASE,
        artifact: { ...BASE.artifact, mtimeMs: Math.trunc(statMtimeMs) },
      }),
    ).toBe(previousIdentity);
  });

  test("T17 an empty sha256 falls back to sizeBytes and mtimeMs", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);
    const decide = requireDecide(mod);
    const identity = identityOf(derive, BASE);
    const input: OmlxCacheIdentityInput = {
      ...BASE,
      artifact: { ...BASE.artifact, sha256: "" },
    };

    // Kills: failing on an empty sha256, or hashing the empty sha256 alongside
    // size/mtime. A size or mtime change must still invalidate.
    expect(decide(identity, input)).toEqual({
      action: "retain",
      reason: "IdentityMatch",
      identity,
    });
    expect(
      decide(identity, { ...input, artifact: { ...input.artifact, mtimeMs: 1767225600001 } }),
    ).toMatchObject({ action: "invalidate", reason: "IdentityChanged" });
  });

  test("T18 an unknown settings key is part of the identity", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);
    const decide = requireDecide(mod);
    const baseIdentity = identityOf(derive, BASE);
    const layoutOne = withSettings({ future_kv_layout: 1 });
    const layoutTwo = withSettings({ future_kv_layout: 2 });
    const layoutOneIdentity = identityOf(derive, layoutOne);
    const layoutTwoIdentity = identityOf(derive, layoutTwo);

    // Kills: reading only the TurboQuant allow-list, which would retain a
    // cache across a change to a key this module does not know about.
    expect(layoutOneIdentity).not.toBe(baseIdentity);
    expect(layoutTwoIdentity).not.toBe(layoutOneIdentity);
    expect(decide(layoutOneIdentity, layoutTwo)).toEqual({
      action: "invalidate",
      reason: "IdentityChanged",
      identity: layoutTwoIdentity,
    });
    expect(decide(baseIdentity, layoutOne)).toEqual({
      action: "invalidate",
      reason: "IdentityChanged",
      identity: layoutOneIdentity,
    });

    // Kills: a non-canonical encoding of unknown values.
    expect(derive(layoutOne)).toEqual({
      ok: true,
      identity: "omlx-cache-v1:92784acf47173de837a6f1e769b8d73b511e43c4c18eaec040d1c97e939c2dcc",
    });
  });

  test("T18 unknown settings are hashed in canonical key order", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);
    const forward = withSettings({ future_a: { y: 1, x: [true, null] }, future_b: "z" });
    const reversed = withSettings({ future_b: "z", future_a: { x: [true, null], y: 1 } });

    // Kills: hashing unknown keys in insertion order.
    expect(identityOf(derive, reversed)).toBe(identityOf(derive, forward));
    // An undefined top-level value is an absent key, as for every optional key.
    expect(identityOf(derive, withSettings({ future_kv_layout: undefined }))).toBe(
      identityOf(derive, BASE),
    );
  });

  test("T18 an unknown key is not mistaken for a neutral key", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);
    const baseIdentity = identityOf(derive, BASE);

    // Kills: a prefix or case-insensitive match against the neutral list.
    for (const key of ["max_tokens_v2", "MAX_TOKENS", "mtp", "turboquant_kv_layout"]) {
      expect(identityOf(derive, withSettings({ [key]: 1 }))).not.toBe(baseIdentity);
    }
  });

  test("T18 a __proto__ settings key from JSON is hashed like any other key", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);
    const baseIdentity = identityOf(derive, BASE);
    const parsed = (text: string): OmlxCacheIdentityInput =>
      withSettings(JSON.parse(text) as Record<string, unknown>);
    const one = identityOf(derive, parsed('{"__proto__": {"future_kv_layout": 1}}'));
    const two = identityOf(derive, parsed('{"__proto__": {"future_kv_layout": 2}}'));

    // Kills: copying keys into a plain {} whose __proto__ setter swallows the
    // key, so the value never reaches the hash.
    expect(one).not.toBe(baseIdentity);
    expect(two).not.toBe(one);
  });

  for (const [name, input] of INVALID_SETTINGS) {
    test(`T19 settings without a canonical form fail closed: ${name}`, async () => {
      const mod = await loadModule();
      const derive = requireDerive(mod);
      const decide = requireDecide(mod);
      const previousIdentity = identityOf(derive, BASE);

      // Kills: hashing a value whose JSON form collides with another value.
      expect(derive(input)).toMatchObject({ ok: false, reason: "SettingsInvalid" });
      expect(decide(previousIdentity, input)).toEqual({
        action: "invalidate",
        reason: "SettingsInvalid",
        identity: null,
      });
    });
  }

  test("T19 neutral keys are ignored whatever their value", async () => {
    const mod = await loadModule();
    const derive = requireDerive(mod);

    // Kills: canonicalising neutral values, which would fail closed on a key
    // that cannot change cache content.
    expect(identityOf(derive, withSettings({ max_tokens: Number.NaN }))).toBe(
      identityOf(derive, BASE),
    );
  });
});
