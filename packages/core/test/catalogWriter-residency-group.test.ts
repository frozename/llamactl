import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { listCatalog } from "../src/catalog.js";
import { addCurated } from "../src/catalogWriter.js";
import { RESIDENCY_GROUPS } from "../src/residency/lifecycle.js";
import { existsSync } from "../src/safe-fs.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

type AddCuratedInputWithGroups = Parameters<typeof addCurated>[0] & { groups?: unknown };

describe("addCurated residencyGroup declarations (#517)", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) Reflect.deleteProperty(process.env, key);
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v !== undefined) process.env[k] = v;
    }
    temp.cleanup();
  });

  const customCatalogFile = (): string => {
    const file = envForTemp(temp)["LOCAL_AI_CUSTOM_CATALOG_FILE"];
    expect(file).toBeDefined();
    if (file === undefined) throw new Error("LOCAL_AI_CUSTOM_CATALOG_FILE missing");
    return file;
  };

  test("R1: refuses a residency group missing from the default declarations", async () => {
    const result = await addCurated({
      repo: "acme/Group-Test-GGUF",
      fileOrRel: "group-a.gguf",
      class: "general",
      meta: { residencyGroup: "z13-large" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("invalid catalog meta: residencyGroup:");
    expect(result.error).toContain("z13-large");
    expect(result.error).toContain("is not declared");
    for (const group of RESIDENCY_GROUPS) {
      expect(result.error).toContain(group.name);
    }
    expect(existsSync(customCatalogFile())).toBe(false);
  });

  test("R2: injected exclusive declarations replace the default group set", async () => {
    const groups = [{ name: "big-moe", exclusive: true }];
    const acceptedInput: AddCuratedInputWithGroups = {
      repo: "acme/Group-Test-GGUF",
      fileOrRel: "group-b1.gguf",
      class: "general",
      meta: { residencyGroup: "big-moe" },
      groups,
    };
    const accepted = await addCurated(acceptedInput);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.entry.residencyGroup).toBe("big-moe");

    const refusedInput: AddCuratedInputWithGroups = {
      repo: "acme/Group-Test-GGUF",
      fileOrRel: "group-b2.gguf",
      class: "general",
      meta: { residencyGroup: "z13-large-gpu" },
      groups,
    };
    const refused = await addCurated(refusedInput);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("invalid catalog meta: residencyGroup:");
    expect(refused.error).toContain("z13-large-gpu");
    expect(refused.error).toContain("is not declared");
  });

  test("R3: injected non-exclusive declarations are valid membership targets", async () => {
    const groups = [{ name: "shared-pool", exclusive: false }];
    const acceptedInput: AddCuratedInputWithGroups = {
      repo: "acme/Group-Test-GGUF",
      fileOrRel: "group-c1.gguf",
      class: "general",
      meta: { residencyGroup: "shared-pool" },
      groups,
    };
    const accepted = await addCurated(acceptedInput);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.entry.residencyGroup).toBe("shared-pool");

    const refusedInput: AddCuratedInputWithGroups = {
      repo: "acme/Group-Test-GGUF",
      fileOrRel: "group-c2.gguf",
      class: "general",
      meta: { residencyGroup: "other-pool" },
      groups,
    };
    const refused = await addCurated(refusedInput);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("invalid catalog meta: residencyGroup:");
    expect(refused.error).toContain("other-pool");
    expect(refused.error).toContain("is not declared");
  });

  test("G1: accepts a declared default residency group and reads it back", async () => {
    const result = await addCurated({
      repo: "acme/Group-Test-GGUF",
      fileOrRel: "group-g1.gguf",
      class: "general",
      meta: { residencyGroup: "z13-large-gpu" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.residencyGroup).toBe("z13-large-gpu");

    const readBack = listCatalog("custom").find(
      (entry) => entry.rel === "Group-Test-GGUF/group-g1.gguf",
    );
    expect(readBack).toBeDefined();
    expect(readBack?.residencyGroup).toBe("z13-large-gpu");
  });

  test("G2: accepts metadata without a residency group", async () => {
    const result = await addCurated({
      repo: "acme/Group-Test-GGUF",
      fileOrRel: "group-g2.gguf",
      class: "general",
      meta: { qualification: { stage: "experimental" } },
    });
    expect(result.ok).toBe(true);
  });

  test("G3: every builtin residency group is declared", () => {
    const declared = new Set(RESIDENCY_GROUPS.map((group) => group.name));
    const undeclared = listCatalog("builtin")
      .filter((entry) => entry.residencyGroup !== undefined && !declared.has(entry.residencyGroup))
      .map((entry) => `${entry.rel}: ${entry.residencyGroup ?? ""}`);
    expect(undeclared).toEqual([]);
  });
});
