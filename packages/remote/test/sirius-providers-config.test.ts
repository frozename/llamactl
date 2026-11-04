import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  defaultSiriusProvidersPath,
  loadSiriusProviders,
  removeSiriusProvider,
  saveSiriusProviders,
  SIRIUS_PROVIDER_DEFAULT_BASE_URLS,
  SiriusProviderKindSchema,
  upsertSiriusProvider,
} from "../src/config/sirius-providers.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { ...overrides };
}

// ---------------------------------------------------------------------------
// describe("defaultSiriusProvidersPath")
// ---------------------------------------------------------------------------

describe("defaultSiriusProvidersPath", () => {
  test("rule 1: with LLAMACTL_SIRIUS_PROVIDERS set, the trimmed override wins over DEV_STORAGE", () => {
    const env = makeEnv({
      LLAMACTL_SIRIUS_PROVIDERS: "  /x/p.yaml  ",
      DEV_STORAGE: "/dev",
    });
    expect(defaultSiriusProvidersPath(env)).toBe("/x/p.yaml");
  });

  test("rule 2: a whitespace-only override falls through to DEV_STORAGE", () => {
    const env = makeEnv({
      LLAMACTL_SIRIUS_PROVIDERS: "   ",
      DEV_STORAGE: " /dev ",
    });
    expect(defaultSiriusProvidersPath(env)).toBe(join("/dev", "sirius-providers.yaml"));
  });

  test('rule 3: with neither variable set, falls back to join(homedir(), ".llamactl", "sirius-providers.yaml")', () => {
    const env = makeEnv({});
    expect(defaultSiriusProvidersPath(env)).toBe(
      join(homedir(), ".llamactl", "sirius-providers.yaml"),
    );
  });
});

// ---------------------------------------------------------------------------
// describe("loadSiriusProviders")
// ---------------------------------------------------------------------------

describe("loadSiriusProviders", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sirius-prov-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("rule 4: a missing file yields [] and the file is not created", () => {
    const missingPath = join(dir, "does-not-exist.yaml");
    const result = loadSiriusProviders(missingPath);
    expect(result).toEqual([]);
    expect(existsSync(missingPath)).toBe(false);
  });

  test("rule 5: an empty file yields []", () => {
    const filePath = join(dir, "empty.yaml");
    writeFileSync(filePath, "", "utf8");
    expect(loadSiriusProviders(filePath)).toEqual([]);
  });

  test("rule 6: a file with only `providers:` and no header loads its entries", () => {
    const filePath = join(dir, "no-header.yaml");
    writeFileSync(
      filePath,
      "providers:\n  - name: alpha\n    kind: openai\n    apiKeyRef: $KEY_A\n",
      "utf8",
    );
    const result = loadSiriusProviders(filePath);
    expect(result).toEqual([{ name: "alpha", kind: "openai", apiKeyRef: "$KEY_A" }]);
  });

  test('rule 7: a file whose apiVersion is "llamactl/v2" throws', () => {
    const filePath = join(dir, "v2.yaml");
    writeFileSync(
      filePath,
      "apiVersion: llamactl/v2\nkind: SiriusProviderList\nproviders:\n  - name: alpha\n    kind: openai\n",
      "utf8",
    );
    expect(() => loadSiriusProviders(filePath)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// describe("loadSiriusProviders" — kind + baseUrl validation)
// ---------------------------------------------------------------------------

describe("loadSiriusProviders — kind and baseUrl validation", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sirius-prov-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('rule 8: a provider whose kind is not in the enum (e.g. "cohere") throws', () => {
    const filePath = join(dir, "bad-kind.yaml");
    writeFileSync(filePath, "providers:\n  - name: cohere-provider\n    kind: cohere\n", "utf8");
    expect(() => loadSiriusProviders(filePath)).toThrow();
  });

  test('rule 9: a provider with a non-URL baseUrl (e.g. "not a url") throws', () => {
    const filePath = join(dir, "bad-url.yaml");
    writeFileSync(
      filePath,
      "providers:\n  - name: broken\n    kind: openai-compatible\n    baseUrl: not a url\n",
      "utf8",
    );
    expect(() => loadSiriusProviders(filePath)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// describe("saveSiriusProviders")
// ---------------------------------------------------------------------------

describe("saveSiriusProviders", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sirius-prov-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("rule 10: saving to a path whose parent dirs do not exist creates them and writes the file", () => {
    const nestedPath = join(dir, "a", "b", "p.yaml");
    saveSiriusProviders([], nestedPath);
    expect(existsSync(nestedPath)).toBe(true);
  });

  test("rule 11: saving [] still writes the apiVersion and kind envelope", () => {
    const filePath = join(dir, "empty-save.yaml");
    saveSiriusProviders([], filePath);
    const parsed = parseYaml(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(parsed).toEqual({
      apiVersion: "llamactl/v1",
      kind: "SiriusProviderList",
      providers: [],
    });
  });

  test("rule 12: an entry with an unknown extra key is stripped on save", () => {
    const filePath = join(dir, "extra-keys.yaml");
    const providers = [
      { name: "alpha", kind: "openai", apiKeyRef: "$KEY", secret: "s" as unknown },
    ];
    saveSiriusProviders(providers as never, filePath);
    const content = readFileSync(filePath, "utf8");
    expect(content).not.toContain("secret");
    const reloaded = loadSiriusProviders(filePath);
    expect(reloaded[0]).toHaveProperty("name", "alpha");
    expect((reloaded[0] as Record<string, unknown>)["secret"]).toBeUndefined();
  });

  test("rule 13: an invalid entry makes save throw and leaves no file at the target path", () => {
    const filePath = join(dir, "invalid-save.yaml");
    const providers = [{ name: "", kind: "openai" }];
    expect(() => {
      saveSiriusProviders(providers as never, filePath);
    }).toThrow();
    expect(existsSync(filePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// describe("upsertSiriusProvider")
// ---------------------------------------------------------------------------

describe("upsertSiriusProvider", () => {
  test("rule 14: a new name is appended after the existing entries, in order", () => {
    const input: { name: string; kind: string }[] = [
      { name: "a", kind: "openai" },
      { name: "b", kind: "anthropic" },
    ];
    const result = upsertSiriusProvider(input as never, { name: "c", kind: "groq" });
    expect(result.map((p: { name: string }) => p.name)).toEqual(["a", "b", "c"]);
  });

  test("rule 15: an existing name is replaced — result has exactly one entry with that name, replaced entry moves to END, others keep relative order", () => {
    const input: { name: string; kind: string; apiKeyRef?: string }[] = [
      { name: "a", kind: "openai" },
      { name: "b", kind: "anthropic", apiKeyRef: "$OLD" },
      { name: "c", kind: "groq" },
    ];
    const result = upsertSiriusProvider(input as never, {
      name: "b",
      kind: "anthropic",
      apiKeyRef: "$NEW",
    });
    const bEntries = result.filter((p: { name: string }) => p.name === "b");
    expect(bEntries).toHaveLength(1);
    expect((bEntries[0] as { apiKeyRef: string }).apiKeyRef).toBe("$NEW");
    // Order: [a, c, b'] — b was replaced and moved to end
    expect(result.map((p: { name: string }) => p.name)).toEqual(["a", "c", "b"]);
  });

  test("rule 16: the input array is not mutated", () => {
    const entry: { name: string; kind: string } = { name: "x", kind: "openai" };
    const input: { name: string; kind: string }[] = [{ name: "a", kind: "openai" }, entry];
    const lenBefore = input.length;
    const result = upsertSiriusProvider(input as never, { name: "x", kind: "groq" });
    expect(input.length).toBe(lenBefore);
    expect(input).toEqual([
      { name: "a", kind: "openai" },
      { name: "x", kind: "openai" },
    ]);
    expect(result).not.toBe(input);
  });
});

// ---------------------------------------------------------------------------
// describe("removeSiriusProvider")
// ---------------------------------------------------------------------------

describe("removeSiriusProvider", () => {
  test("rule 17: removes every entry with the given name, including duplicates, keeps others in order", () => {
    const input: { name: string }[] = [{ name: "a" }, { name: "b" }, { name: "a" }, { name: "c" }];
    const result = removeSiriusProvider(input as never, "a");
    expect(result.map((p: { name: string }) => p.name)).toEqual(["b", "c"]);
  });

  test("rule 18: an unknown name returns an equal but distinct array, input unchanged", () => {
    const input: { name: string }[] = [{ name: "a" }, { name: "b" }];
    const result = removeSiriusProvider(input as never, "z");
    expect(result.map((p: { name: string }) => p.name)).toEqual(["a", "b"]);
    expect(result).not.toBe(input);
    expect(input).toEqual([{ name: "a" }, { name: "b" }]);
  });
});

// ---------------------------------------------------------------------------
// describe("SIRIUS_PROVIDER_DEFAULT_BASE_URLS")
// ---------------------------------------------------------------------------

describe("SIRIUS_PROVIDER_DEFAULT_BASE_URLS", () => {
  test("rule 19: its keys are exactly SiriusProviderKindSchema.options (sorted compare)", () => {
    const keys = Object.keys(SIRIUS_PROVIDER_DEFAULT_BASE_URLS);
    const expected = [...SiriusProviderKindSchema.options].sort();
    expect(keys.sort()).toEqual(expected);
  });

  test('rule 20: "openai-compatible" maps to "" and every other kind maps to an https URL that parses with new URL', () => {
    for (const kind of SiriusProviderKindSchema.options) {
      const url = SIRIUS_PROVIDER_DEFAULT_BASE_URLS[kind];
      if (kind === "openai-compatible") {
        expect(url).toBe("");
      } else {
        const parsed = new URL(url);
        expect(parsed.protocol).toBe("https:");
      }
    }
  });
});
