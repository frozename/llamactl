import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  ModelHostHostedModelSchema,
  ModelHostManifestSchema,
  specForEngine,
} from "../../src/workload/modelhost-schema.js";

// #282 DF-09: per-model oMLX settings on ModelHost hostedModels. The core
// contract module does not exist at the pinned base; the specifier is widened
// to `string` so tsc cannot resolve it — a literal specifier would be a
// resolution error, not an assertion failure.
const CORE_OMLX_SETTINGS_SPEC = "@llamactl/core/engines/omlx-model-settings" as string;

type OmlxSettingsCoreModule = {
  OMLX_MANAGED_MODEL_SETTINGS_KEYS: readonly string[];
};

async function loadCoreSettings(): Promise<OmlxSettingsCoreModule | null> {
  try {
    return (await import(CORE_OMLX_SETTINGS_SPEC)) as OmlxSettingsCoreModule;
  } catch {
    return null;
  }
}

const OMLX_MODEL_ID = "lmstudio-community/Qwen3-8B-MLX-4bit";

// Every managed key at a valid value. mtp_enabled is only valid here because
// this base manifest declares no dflash block.
const OMLX_ALL_KEYS = {
  max_context_window: 40960,
  max_tokens: 32768,
  chat_template_kwargs: { enable_thinking: false, nested: { a: [1] } },
  forced_ct_kwargs: ["enable_thinking"],
  enable_thinking: true,
  preserve_thinking: true,
  thinking_budget_enabled: true,
  thinking_budget_tokens: 2048,
  reasoning_parser: "qwen",
  turboquant_kv_enabled: true,
  turboquant_kv_bits: 3.5,
  turboquant_skip_last: true,
  specprefill_enabled: true,
  specprefill_draft_model: "draft-model.gguf",
  specprefill_keep_pct: 0.2,
  specprefill_threshold: 8192,
  mtp_enabled: true,
  mtp_num_draft_tokens: 4,
};

function manifestWith(
  hostedModel: Record<string, unknown>,
  specPatch: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name: "mlx-host-local" },
    spec: {
      engine: "omlx",
      node: "local",
      enabled: true,
      binary: "/Volumes/WorkSSD/src/omlx/.venv/bin/omlx",
      endpoint: { host: "127.0.0.1", port: 8094 },
      hostedModels: [hostedModel],
      extraArgs: [],
      restartPolicy: "Always",
      timeoutSeconds: 60,
      ...specPatch,
    },
  };
}

function omlxManifest(omlx: Record<string, unknown>): Record<string, unknown> {
  return manifestWith({ rel: OMLX_MODEL_ID, omlx });
}

function omlxOf(hostedModel: unknown): unknown {
  if (typeof hostedModel !== "object" || hostedModel === null) {
    return undefined;
  }
  return (hostedModel as { omlx?: unknown }).omlx;
}

function pathEquals(path: readonly PropertyKey[], expected: readonly (string | number)[]): boolean {
  return path.length === expected.length && expected.every((seg, i) => path[i] === seg);
}

function issueAtPrefix(
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly (string | number)[],
): z.core.$ZodIssue | undefined {
  return issues.find((issue) => prefix.every((seg, i) => issue.path[i] === seg));
}

describe("ModelHostManifestSchema omlx settings", () => {
  test("S1 accepts a full omlx block and passes it through to the engine spec", () => {
    // Kills: a normalizeHostedModel that does not copy omlx, and one that
    // emits omlx: undefined instead of absent.
    const result = ModelHostManifestSchema.safeParse(omlxManifest(OMLX_ALL_KEYS));
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected manifest with omlx block to parse");
    }
    expect(omlxOf(result.data.spec.hostedModels[0])).toEqual(OMLX_ALL_KEYS);
    const engineSpec = specForEngine(result.data.spec);
    const engineHosted = engineSpec.hostedModels[0];
    expect(engineHosted).toBeDefined();
    expect(omlxOf(engineHosted)).toEqual(OMLX_ALL_KEYS);

    const plain = ModelHostManifestSchema.safeParse(manifestWith({ rel: OMLX_MODEL_ID }));
    expect(plain.success).toBe(true);
    if (!plain.success) {
      throw new Error("expected plain manifest to parse");
    }
    const plainHosted = specForEngine(plain.data.spec).hostedModels[0];
    expect(plainHosted).toBeDefined();
    if (plainHosted === undefined) {
      throw new Error("unreachable");
    }
    expect("omlx" in plainHosted).toBe(false);
  });

  test("S2 rejects keys outside the managed set as unrecognized", () => {
    // Kills: dropping .strict() on the omlx object.
    const cases: [string, unknown][] = [
      ["ttl_seconds", 3600],
      ["is_pinned", true],
      ["model_alias", "qwen-alias"],
      ["trust_remote_code", true],
      ["dflash_enabled", true],
      ["vlm_mtp_enabled", true],
    ];
    for (const [key, value] of cases) {
      const result = ModelHostManifestSchema.safeParse(omlxManifest({ [key]: value }));
      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("unreachable");
      }
      const issue = result.error.issues.find(
        (i) =>
          i.code === "unrecognized_keys" && pathEquals(i.path, ["spec", "hostedModels", 0, "omlx"]),
      );
      expect(issue, `expected unrecognized_keys issue for ${key}`).toBeDefined();
      if (issue?.code !== "unrecognized_keys") {
        throw new Error("unreachable");
      }
      expect(issue.keys).toEqual([key]);
    }
  });

  test("S3 enforces value ranges on managed keys", () => {
    // Kills: loosening turboquant_kv_bits to z.number(), and dropping .min(1)
    // on forced_ct_kwargs elements.
    const cases: { key: string; bad: unknown }[] = [
      { key: "turboquant_kv_bits", bad: 5 },
      { key: "specprefill_keep_pct", bad: 0.6 },
      { key: "max_context_window", bad: 0 },
      { key: "mtp_num_draft_tokens", bad: 1.5 },
      { key: "forced_ct_kwargs", bad: [""] },
    ];
    for (const { key, bad } of cases) {
      const result = ModelHostManifestSchema.safeParse(omlxManifest({ [key]: bad }));
      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("unreachable");
      }
      const issue = issueAtPrefix(result.error.issues, ["spec", "hostedModels", 0, "omlx", key]);
      expect(issue, `expected a validation issue at omlx.${key}`).toBeDefined();
    }
  });

  test("S3b reports the element path for an empty forced_ct_kwargs entry", () => {
    const result = ModelHostManifestSchema.safeParse(omlxManifest({ forced_ct_kwargs: [""] }));
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("unreachable");
    }
    // Zod 4.6.6 reports the element path for array items.
    const issue = issueAtPrefix(result.error.issues, [
      "spec",
      "hostedModels",
      0,
      "omlx",
      "forced_ct_kwargs",
      0,
    ]);
    expect(issue).toBeDefined();
  });

  test("S4 rejects omlx settings on a non-omlx engine", () => {
    // Kills: deleting the engine check.
    const result = ModelHostManifestSchema.safeParse(
      manifestWith(
        { rel: OMLX_MODEL_ID, omlx: { max_context_window: 4096 } },
        {
          engine: "llamacpp",
        },
      ),
    );
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("unreachable");
    }
    const issue = result.error.issues.find(
      (i) =>
        pathEquals(i.path, ["spec", "hostedModels", 0, "omlx"]) &&
        i.message.includes("only supported for engine omlx"),
    );
    expect(issue).toBeDefined();
  });

  test("S5 rejects mtp_enabled together with an enabled dflash block", () => {
    // Kills: deleting the refine, or treating dflash.enabled alone as the
    // effective flag.
    const result = ModelHostManifestSchema.safeParse(
      manifestWith({
        rel: OMLX_MODEL_ID,
        omlx: { mtp_enabled: true },
        dflash: { enabled: true },
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("unreachable");
    }
    const issue = result.error.issues.find(
      (i) =>
        pathEquals(i.path, ["spec", "hostedModels", 0, "omlx", "mtp_enabled"]) &&
        i.message.includes("cannot both be enabled"),
    );
    expect(issue).toBeDefined();
  });

  test("S5b accepts mtp_enabled when the effective dflash flag is off", () => {
    const cases: Record<string, unknown>[] = [
      {
        rel: OMLX_MODEL_ID,
        omlx: { mtp_enabled: true },
        dflash: { enabled: true, dflash_enabled: false },
      },
      { rel: OMLX_MODEL_ID, omlx: { mtp_enabled: true }, dflash: { enabled: false } },
      { rel: OMLX_MODEL_ID, omlx: { mtp_enabled: true } },
    ];
    for (const hostedModel of cases) {
      const result = ModelHostManifestSchema.safeParse(manifestWith(hostedModel));
      expect(result.success).toBe(true);
    }
  });

  test("S6 hosted-model omlx schema keys match the core managed set", async () => {
    const omlxSchema = (ModelHostHostedModelSchema.shape as Record<string, unknown>)["omlx"];
    expect(omlxSchema, "hostedModels omlx schema missing").toBeDefined();
    const core = await loadCoreSettings();
    expect(core, "omlx-model-settings core module missing").not.toBeNull();
    if (core === null) {
      throw new Error("unreachable");
    }

    const inner = omlxSchema instanceof z.ZodOptional ? omlxSchema.unwrap() : omlxSchema;
    expect(inner).toBeInstanceOf(z.ZodObject);
    if (!(inner instanceof z.ZodObject)) {
      throw new Error("omlx schema did not unwrap to a ZodObject");
    }
    expect(Object.keys(inner.shape).sort()).toEqual(
      [...core.OMLX_MANAGED_MODEL_SETTINGS_KEYS].sort(),
    );
  });
});

test("oMLX cache epochs are opt-in and own their launch storage flags", () => {
  const hosted = { rel: "fixture" };
  const valid = ModelHostManifestSchema.parse(
    manifestWith(hosted, { omlxCacheEpoch: 0, extraArgs: ["--slot-save-path=auto"] }),
  );
  expect(valid.spec.omlxCacheEpoch).toBe(0);
  expect(ModelHostManifestSchema.parse(manifestWith(hosted)).spec.omlxCacheEpoch).toBeUndefined();
  for (const spec of [
    { omlxCacheEpoch: -1 },
    { omlxCacheEpoch: 1.5 },
    { omlxCacheEpoch: 0, engine: "llamacpp" },
    { omlxCacheEpoch: 0, extraArgs: ["--paged-ssd-cache-dir=/other"] },
    { omlxCacheEpoch: 0, extraArgs: ["--model-d=/other"] },
    { omlxCacheEpoch: 0, extraArgs: ["--slot-save-path=auto", "--slot-save-path=/other"] },
    { omlxCacheEpoch: 0, extraArgs: ["--slot-save-path", "--no-cache"] },
  ]) {
    expect(ModelHostManifestSchema.safeParse(manifestWith(hosted, spec)).success).toBe(false);
  }
});
