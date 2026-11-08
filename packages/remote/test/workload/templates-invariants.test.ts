/**
 * G-1 (part of #285) — dynamic-fleet regression guards.
 *
 * EXPECTED_SPEC_HASHES pins the launch-affecting spec digest of every
 * committed workload template. An intended template change must update this
 * table in the same PR; an unintended drift (template edit, addition or
 * removal) fails here before it reaches a fleet.
 */
import { profile, residencyAdmission } from "@llamactl/core";
import { computeModelHostSpecHash } from "@llamactl/core/engines/state";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { readdirSync, readFileSync } from "../../src/safe-fs.js";
import { defaultNodeBudgetGiB } from "../../src/workload/admission.js";
import { specForHash } from "../../src/workload/modelhost-schema.js";
import { parseModelHost } from "../../src/workload/modelhost-store.js";
import { ModelRunSchema } from "../../src/workload/schema.js";
import { parseManifestYaml } from "../../src/workload/store.js";

const TEMPLATES_DIR = resolve(import.meta.dir, "../../../../templates/workloads");
const FIXED_ENV = { LLAMA_SERVER_BIN: "/opt/llamactl-test/bin/llama-server" };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return value === undefined ? "null" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function specDigest(file: string): string {
  const raw = readFileSync(resolve(TEMPLATES_DIR, file), "utf8");
  const kind = (parseYaml(raw) as { kind?: string } | null)?.kind;
  let input: string;
  if (kind === "ModelHost") {
    const manifest = parseModelHost(raw);
    input = computeModelHostSpecHash(specForHash(manifest.spec));
  } else if (kind === "ModelRun") {
    const spec = ModelRunSchema.parse(parseManifestYaml(raw, FIXED_ENV)).spec;
    input = canonicalJson(spec);
  } else {
    throw new Error(`${file}: unhandled kind ${String(kind)}`);
  }
  return createHash("sha256").update(input).digest("hex");
}

const EXPECTED_SPEC_HASHES: Readonly<Record<string, string>> = {
  "gemma4-e4b-vanilla-local.yaml":
    "180e0b4f307c58aaa8786b64a5bf216768623f77118c773cba7287b52771700c",
  "granite41-3b-home-mgmt-mac-mini.yaml":
    "d3809698d9b522a1a5113c5437e5bc0f2167af240423ef0a066239c3897cf29f",
  "granite41-3b-judge-local.yaml":
    "188d2d472b8ac6e969e1c853effb10f3a99b196385cb59277c30ff2935e0b5f7",
  "granite41-3b-judge-mac-mini.yaml":
    "2cefa63ac50085284daf97f27ac1a2d7f1fa16aabe11765f52e0caafceefe970",
  "granite41-3b-local.yaml": "b5cac182a4155d5c24eda4748c5ab6ef49f4375a385166bc57af15b3a973e81a",
  "granite41-3b-long-lived-local.yaml":
    "5904a226cb8dfc9e0e5c81c7e5b6f82fe2d360634c8b5267276138c7981d9953",
  "granite41-8b-local.yaml": "974764130ba9d3add49fddb00c0671c7ad898aca5398e0335360639d02b85e39",
  "granite41-8b-long-lived-local.yaml":
    "88e9c5dfd9ff9c71df0708821414103020b3932bbc8e01e321483ea938a6db24",
  "granite41-8b-mac-mini.yaml": "efb925bbf6a9dd5bb475b2d659c1e5aa009733bf4b683ae594f76d2ba8a76569",
  "gufo-glm53-exp-z13.yaml": "107a6d71f35796d31bd501eb3b6ee13f0c22a85fa9088be46d667c0e24d39c94",
  "llamacpp-mimo26-flash-bpw25-z13.yaml":
    "98a489b0dd7a3aaf19f31e14d48be50bd4bb3cf0da5ff222c20d467020366b88",
  "mlx-granite-3b-iso-mac-mini.yaml":
    "087bb40fa6b90c6105da3ad12afa835b7fe984ceee03bf173da97e83aa9dd42a",
  "mlx-granite-3b-judge-mac-mini.yaml":
    "49461087814961d62bd98e283f7c683f05fde656dc1dee0bdc47ab49439040c3",
  "mlx-granite-3b-slot-canary-mac-mini.yaml":
    "00d4520c50e79ed670304720802361e9fcbac8671be3c6e8358c8eba536e7f6d",
  "mlx-granite-8b-iso-mac-mini.yaml":
    "e7f3cc535cc3889f4407c520cd13191798df50bacde05cc3a8ac3510fb8cd8ef",
  "mlx-host-dflash.yaml": "afce97a2a0c5bc7b72f38c61f448eb16dbd7e0bdd640f67fcc00981437e6cb1f",
  "mlx-host-local.yaml": "fbd5db38a31741c43a0c04800075adb1eebb3058e654ade495d4e99275f53d25",
  "mlx-qwen3-8b-iso-mac-mini.yaml":
    "11530e2722cfc51645060cbed6bce271e2ee7fe651e6141775e15dcc4436df96",
  "mlx-qwen3-8b-mac-mini.yaml": "91e0712309a40818c84999c0faa9faeab69791819090b0252ef9f77496d6d831",
  "mlx-qwen36-35b-a3b-local.yaml":
    "9639c1130d48061b6f61441cb6d7b589b2a98f0f6f5ad6b0dd6531d200c7eb32",
  "qwen3-8b-home-mgmt-mac-mini.yaml":
    "82146aef11dd15f2cb0763118735e9a5b0c50994d6a3bb76d61f47f9c7ac757f",
  "qwen3-8b-local.yaml": "bef830b7551ca143261bacf6e75d04a1a017fa82c893bfd578d4cfb0e4203f36",
  "qwen3-8b-mac-mini.yaml": "b62aa4db71d3708480d85af23b5e12ca487ace3a4e8f2251c6e654fa51202d38",
  "qwen35-4b-mac-mini.yaml": "dae7c9609d9ccbbc4781e8930d28a31d2a925b1b4db75a750133d81dd05d0196",
  "strata-host-local.yaml": "671ab93e6420708c824c185fedc2cdde059cd89f7f04262b506c38089bdfd7f4",
  "stress-fleet-A-mac-mini.yaml":
    "a6970c677f0ed6ff4efa945f7118490eb903762e064b3c9677aa844344c7cf16",
  "stress-fleet-B-granite-3b-mac-mini.yaml":
    "521372008ea7e7bb20e5cfa469cdec61330352a076c514ff5d884daded4e81df",
  "stress-fleet-B-granite-8b-mac-mini.yaml":
    "e565c9bb0d0146497be8361825dd7982fa01431263b0dbe246d84751d8a6f1a6",
  "stress-fleet-C-granite-8b-mac-mini.yaml":
    "f3e17a637bbc752b9492c9ee4be169114a9ea61248f399313c6f7eb11ecb78b8",
  "stress-fleet-C-qwen3-8b-mac-mini.yaml":
    "b261f98a510c58e38ce6e053a16590729ce2c7f8f9fa491852c3260eebea72c9",
  "stress-fleet-D-granite-3b-mac-mini.yaml":
    "02e2ac102fd796102f7d215975fb100dcb65d650b72cb2926bf0f723d659a95a",
  "stress-fleet-D-granite-8b-mac-mini.yaml":
    "3d3bcd421f3a424b63c6e2bb2a8f81b14490bf420f23388cb6d4e3292ce798de",
  "stress-fleet-D-qwen3-8b-mac-mini.yaml":
    "f027768fab144248445999b5ce9765d957bd5b77d4afbf9446c53cacb0348c49",
  "stress-fleet-L-mac-mini.yaml":
    "1911f6180f21e1c5573d1ac0bdc70b0a92b833f2ce60c416c49db24b10b6feff",
};

function templateFiles(): string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((name) => name.endsWith(".yaml"))
    .sort();
}

describe("workload template spec-hash snapshots (G-1, #285)", () => {
  test("the templates directory matches the committed table exactly", () => {
    expect(templateFiles()).toEqual(Object.keys(EXPECTED_SPEC_HASHES).sort());
  });

  for (const file of Object.keys(EXPECTED_SPEC_HASHES).sort()) {
    test(file, () => {
      const expected = EXPECTED_SPEC_HASHES[file];
      if (expected === undefined) {
        throw new Error(`${file} has no committed spec hash`);
      }
      expect(specDigest(file)).toBe(expected);
    });
  }
});

describe("machine-profile thresholds (G-1, #285)", () => {
  test("16 GiB boundary is inclusive on mac-mini-16g", () => {
    expect(profile.profileFromMemory(17_179_869_184)).toBe("mac-mini-16g");
    expect(profile.profileFromMemory(17_179_869_185)).toBe("balanced");
  });

  test("32 GiB boundary is inclusive on balanced", () => {
    expect(profile.profileFromMemory(34_359_738_368)).toBe("balanced");
    expect(profile.profileFromMemory(34_359_738_369)).toBe("macbook-pro-48g");
  });

  test("64 GiB boundary is inclusive on macbook-pro-48g", () => {
    expect(profile.profileFromMemory(68_719_476_736)).toBe("macbook-pro-48g");
    expect(profile.profileFromMemory(68_719_476_737)).toBe("large-128g");
  });

  test("zero and unknown memory", () => {
    expect(profile.profileFromMemory(0)).toBe("mac-mini-16g");
    expect(profile.profileFromMemory(null)).toBe("macbook-pro-48g");
  });
});

describe("default memory headroom (G-1, #285)", () => {
  test("headroom ratio is pinned at 0.75", () => {
    expect(residencyAdmission.MEMORY_BUDGET_HEADROOM_RATIO).toBe(0.75);
  });

  test("capacityBudgetGiB applies the ratio", () => {
    expect(residencyAdmission.capacityBudgetGiB(128 * 1024 ** 3)).toBe(96);
    expect(residencyAdmission.capacityBudgetGiB(16 * 1024 ** 3)).toBe(12);
  });

  test("defaultNodeBudgetGiB falls back to capacity and lets the manifest win", () => {
    expect(defaultNodeBudgetGiB(undefined, 124 * 1024 ** 3)).toBe(93);
    expect(defaultNodeBudgetGiB(undefined, 48 * 1024 ** 3)).toBe(36);
    expect(defaultNodeBudgetGiB(40, 124 * 1024 ** 3)).toBe(40);
  });
});
