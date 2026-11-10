import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { formatCatalogRow, listCatalog } from "../src/catalog.js";
import { addCurated } from "../src/catalogWriter.js";
import { existsSync, readFileSync } from "../src/safe-fs.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

describe("catalogWriter.addCurated (integration)", () => {
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

  test("appends a new row with derived family + label", async () => {
    const result = await addCurated({
      repo: "unsloth/Shim-Test-GGUF",
      fileOrRel: "shim-test-Q4.gguf",
      class: "general",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.family).toBe("custom"); // repo name doesn't match gemma/qwen/deepseek
    expect(result.entry.label).toBe("shim-test-Q4");
    expect(result.entry.scope).toBe("candidate");
    expect(result.entry.rel).toBe("Shim-Test-GGUF/shim-test-Q4.gguf");

    const body = readFileSync(result.file, "utf8");
    expect(body.trim().split("\n").length).toBe(1);
    expect(body).toContain("Shim-Test-GGUF/shim-test-Q4.gguf");
  });

  test("derives gemma4 / qwen35 / qwen36 / deepseek families from repo id", async () => {
    const fam = async (repo: string, file: string): Promise<string> => {
      const r = await addCurated({ repo, fileOrRel: file, class: "general" });
      if (!r.ok) throw new Error(r.error);
      return r.entry.family;
    };
    expect(await fam("unsloth/gemma-4-X-GGUF", "a.gguf")).toBe("gemma4");
    expect(await fam("unsloth/qwen3.5-X-GGUF", "b.gguf")).toBe("qwen35");
    expect(await fam("unsloth/Qwen3.6-X-GGUF", "c.gguf")).toBe("qwen36");
    expect(await fam("unsloth/deepseek-X-GGUF", "d.gguf")).toBe("deepseek");
    // #515 families; filenames stay clear of every builtin rel.
    expect(await fam("aj9o9/GLM-5.3-Flash-GGUF", "g.gguf")).toBe("glm53");
    expect(await fam("unsloth/DeepSeek-V4.1-Flash-1017-GGUF", "e.gguf")).toBe("deepseek41");
    expect(await fam("AesSedai/MiMo-V2.6-Flash-MOPD-GGUF", "m.gguf")).toBe("mimo26");
    expect(await fam("j2ipper/MiMo-V2.6-Flash-MOPD-a4-x", "n.gguf")).toBe("mimo26");
  });

  test("refuses duplicate rel", async () => {
    await addCurated({
      repo: "unsloth/Dupe-GGUF",
      fileOrRel: "dupe.gguf",
      class: "general",
    });
    const second = await addCurated({
      repo: "unsloth/Dupe-GGUF",
      fileOrRel: "dupe.gguf",
      class: "general",
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/already contains/i);
  });

  test("rejects missing args", async () => {
    const r = await addCurated({ repo: "", fileOrRel: "" });
    expect(r.ok).toBe(false);
  });

  test("full-relpath input is honoured as-is", async () => {
    const r = await addCurated({
      repo: "unsloth/Foo-GGUF",
      fileOrRel: "subdir/foo.gguf",
      class: "general",
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.entry.rel).toBe("subdir/foo.gguf");
    expect(existsSync(r.file)).toBe(true);
  });

  test("uses basename suffix for format inference", async () => {
    const r = await addCurated({
      repo: "acme/my.gguf-models",
      fileOrRel: "Qwen3-8B-MLX-4bit",
      class: "general",
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.entry.format).toBe("mlx");
    expect(r.entry.rel).toBe("my.gguf-models/Qwen3-8B-MLX-4bit");
  });

  test("rejects TSV control characters in user-supplied fields", async () => {
    const r = await addCurated({
      repo: "unsloth/Bad-GGUF",
      fileOrRel: "bad\tfile.gguf",
      class: "general",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/illegal control character/i);
  });

  test("rejects an invalid class before writing the catalog row", async () => {
    const r = await addCurated({
      repo: "unsloth/Bad-Class-GGUF",
      fileOrRel: "bad-class.gguf",
      class: "not-a-class",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/invalid class/i);
    expect(existsSync(resultFile(temp))).toBe(false);
  });
});

describe("addCurated candidate metadata (#515)", () => {
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

  test("records valid meta on the returned entry and in column 9", async () => {
    const meta = {
      availability: { declared: "unavailable", reason: "artifact-not-downloaded" },
      qualification: { stage: "experimental" },
      residencyGroup: "z13-large-gpu",
      contextMax: 131072,
    };
    const input: Parameters<typeof addCurated>[0] & { meta?: unknown } = {
      repo: "acme/Meta-Test-GGUF",
      fileOrRel: "meta-a.gguf",
      class: "general",
      meta,
    };
    const result = await addCurated(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.qualification?.stage).toBe("experimental");
    expect(result.entry.availability).toEqual({
      declared: "unavailable",
      reason: "artifact-not-downloaded",
    });
    expect(result.entry.residencyGroup).toBe("z13-large-gpu");

    const body = readFileSync(result.file, "utf8");
    const lines = body.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(1);
    const cols = (lines[0] ?? "").split("\t");
    expect(cols).toHaveLength(9);
    expect(JSON.parse(cols[8] ?? "")).toEqual(meta);
  });

  test("a row written with meta reads back through listCatalog with the same metadata", async () => {
    const meta = {
      availability: { declared: "unavailable", reason: "artifact-not-downloaded" },
      qualification: { stage: "experimental" },
      residencyGroup: "z13-large-gpu",
      contextMax: 131072,
    };
    const input: Parameters<typeof addCurated>[0] & { meta?: unknown } = {
      repo: "acme/Meta-Test-GGUF",
      fileOrRel: "meta-b.gguf",
      class: "general",
      meta,
    };
    const result = await addCurated(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const readBack = listCatalog("custom").find((e) => e.rel === "Meta-Test-GGUF/meta-b.gguf");
    expect(readBack).toBeDefined();
    if (!readBack) return;
    expect(readBack.qualification?.stage).toBe("experimental");
    expect(readBack.availability).toEqual({
      declared: "unavailable",
      reason: "artifact-not-downloaded",
    });
    expect(readBack.residencyGroup).toBe("z13-large-gpu");
    expect(readBack.contextMax).toBe(131072);

    const body = readFileSync(result.file, "utf8");
    const lines = body.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(1);
    expect(formatCatalogRow(readBack)).toBe(lines[0] ?? "");
  });

  test("rejects availability unavailable without reason and writes nothing", async () => {
    const input: Parameters<typeof addCurated>[0] & { meta?: unknown } = {
      repo: "acme/Meta-Test-GGUF",
      fileOrRel: "meta-c.gguf",
      class: "general",
      meta: { availability: { declared: "unavailable" } },
    };
    const result = await addCurated(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/meta/i);
    expect(existsSync(resultFile(temp))).toBe(false);
  });

  test("rejects an unknown qualification stage and writes nothing", async () => {
    const input: Parameters<typeof addCurated>[0] & { meta?: unknown } = {
      repo: "acme/Meta-Test-GGUF",
      fileOrRel: "meta-d.gguf",
      class: "general",
      meta: { qualification: { stage: "shipping" } },
    };
    const result = await addCurated(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/meta/i);
    expect(existsSync(resultFile(temp))).toBe(false);
  });

  test("rejects unknown meta keys instead of silently dropping them", async () => {
    const input: Parameters<typeof addCurated>[0] & { meta?: unknown } = {
      repo: "acme/Meta-Test-GGUF",
      fileOrRel: "meta-e.gguf",
      class: "general",
      meta: { qualifcation: { stage: "experimental" } },
    };
    const result = await addCurated(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/qualifcation/);
    expect(existsSync(resultFile(temp))).toBe(false);
  });

  test("without meta the row stays 8 columns", async () => {
    const result = await addCurated({
      repo: "acme/Meta-Test-GGUF",
      fileOrRel: "meta-f.gguf",
      class: "general",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = readFileSync(result.file, "utf8");
    const lines = body.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(1);
    expect((lines[0] ?? "").split("\t")).toHaveLength(8);
  });
});

function resultFile(temp: ReturnType<typeof makeTempRuntime>): string {
  return temp.runtimeDir + "/curated-models.tsv";
}
