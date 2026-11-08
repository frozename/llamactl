import { describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as catalogModule from "../src/catalog.js";
import {
  BUILTIN_CATALOG,
  curatedStatusForRepoFile,
  findByRel,
  findByRepoFile,
  formatCatalogRow,
  formatCatalogTsv,
  listCatalog,
  parseCatalogRow,
  readCustomCatalog,
  relFromRepoAndFile,
  relKnown,
  repoKnown,
} from "../src/catalog.js";
import * as envModule from "../src/env.js";
import { mkdtempSync, writeFileSync } from "../src/safe-fs.js";
import { curatedMetaFields, CuratedModel } from "../src/schemas.js";
import { FIXTURE_DIR } from "./helpers.js";

describe("catalog.BUILTIN_CATALOG", () => {
  test("has 19 entries in the expected order", () => {
    expect(BUILTIN_CATALOG.length).toBe(19);
    expect(BUILTIN_CATALOG[0]?.id).toBe("gemma4-e4b-q8");
    expect(BUILTIN_CATALOG[11]?.id).toBe("granite41-3b-q4");
    expect(BUILTIN_CATALOG[BUILTIN_CATALOG.length - 1]?.id).toBe("mimo26-flash-mopd-bpw30");
    expect(BUILTIN_CATALOG.slice(12).map((row) => row.id)).toStrictEqual([
      "glm53-flash-aj-iq2xxs",
      "deepseek41-flash-1017-ud-iq1s",
      "deepseek41-flash-1017-ud-iq1m",
      "deepseek41-flash-1017-gsq-rco-iq1m",
      "mimo26-flash-mopd-bpw25",
      "mimo26-flash-mopd-a4x",
      "mimo26-flash-mopd-bpw30",
    ]);
  });
  test("every row has a rel under the expected repo prefix", () => {
    for (const row of BUILTIN_CATALOG) {
      // glm53-flash-aj-iq2xxs is exempt: there is no HF repo named
      // GLM-5.3-Flash-AJ-GGUF — the rel's first segment is the Z13
      // on-disk dir, not the repo basename (glm.md:48).
      if (row.id === "glm53-flash-aj-iq2xxs") continue;
      const dir = row.rel.split("/")[0];
      expect(dir).toBe(row.repo.split("/").pop());
    }
    const glm = BUILTIN_CATALOG.find((row) => row.id === "glm53-flash-aj-iq2xxs");
    expect(glm).toBeDefined();
    expect(glm?.rel.split("/").slice(1).join("/")).toBe(
      "AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf",
    );
  });
});

describe("catalog.readCustomCatalog", () => {
  test("appends format=gguf for legacy rows missing the column", () => {
    const rows = readCustomCatalog(join(FIXTURE_DIR, "curated-custom.tsv"));

    expect(rows[0]?.format).toBe("gguf");
  });

  test("treats an explicit empty format column as legacy gguf", () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-catalog-"));
    const file = join(dir, "empty-format.tsv");
    writeFileSync(
      file,
      "test-empty\tTest Empty\tqwen\tcustom\tcandidate\tempty/model.gguf\tunsloth/empty\t\n",
    );

    const rows = readCustomCatalog(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.format).toBe("gguf");
  });

  test("parses format=mlx when explicitly present", () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-catalog-"));
    const file = join(dir, "mlx.tsv");
    writeFileSync(
      file,
      "test-mlx\tTest MLX\tqwen\tcustom\tcandidate\tmlx-community/Qwen3-8B-MLX-4bit\tmlx-community/Qwen3-8B-MLX-4bit\tmlx\n",
    );

    const rows = readCustomCatalog(file);
    expect(rows[0]?.format).toBe("mlx");
  });

  test("parses valid rows + skips comments + blanks", () => {
    const rows = readCustomCatalog(join(FIXTURE_DIR, "curated-custom.tsv"));
    expect(rows.length).toBe(2);
    expect(rows[0]?.id).toBe("test-qwen3-4b-q4");
    expect(rows[1]?.id).toBe("test-deepseek-14b");
  });
  test("missing file returns []", () => {
    expect(readCustomCatalog("/tmp/does-not-exist.tsv")).toEqual([]);
  });
});

describe("catalog.listCatalog", () => {
  test("builtin scope excludes custom rows", () => {
    expect(
      listCatalog("builtin", { customCatalogFile: join(FIXTURE_DIR, "curated-custom.tsv") }).length,
    ).toBe(BUILTIN_CATALOG.length);
  });
  test("custom scope is only the file rows", () => {
    expect(
      listCatalog("custom", { customCatalogFile: join(FIXTURE_DIR, "curated-custom.tsv") }).length,
    ).toBe(2);
  });
  test("all scope concatenates builtin then custom", () => {
    expect(
      listCatalog("all", { customCatalogFile: join(FIXTURE_DIR, "curated-custom.tsv") }).length,
    ).toBe(BUILTIN_CATALOG.length + 2);
  });
});

describe("catalog.listCatalog lazy env resolution", () => {
  // Regression: listCatalog used to call resolveEnv() unconditionally,
  // which shells out to `sysctl -n hw.memsize` on every call (~4ms each,
  // ~100ms across a repoKnown loop). The builtin-only path must not
  // touch env resolution at all. Three spied seams cover every way the
  // probe can be reached: resolveEnv itself, any subprocess spawn, and
  // homedir (the default-path resolution in env.ts goes through
  // detectDevStorageDefault -> homedir).
  test("builtin scope never resolves env or probes hardware", () => {
    const resolveEnvSpy = spyOn(envModule, "resolveEnv");
    const execSpy = spyOn(childProcess, "execSync");
    const homeSpy = spyOn(os, "homedir");
    try {
      expect(listCatalog("builtin")).toHaveLength(BUILTIN_CATALOG.length);
      expect(resolveEnvSpy).not.toHaveBeenCalled();
      expect(execSpy).not.toHaveBeenCalled();
      expect(homeSpy).not.toHaveBeenCalled();
    } finally {
      resolveEnvSpy.mockRestore();
      execSpy.mockRestore();
      homeSpy.mockRestore();
    }
  });

  test("explicit customCatalogFile needs no env resolution", () => {
    const resolveEnvSpy = spyOn(envModule, "resolveEnv");
    const execSpy = spyOn(childProcess, "execSync");
    const homeSpy = spyOn(os, "homedir");
    try {
      expect(
        listCatalog("all", { customCatalogFile: join(FIXTURE_DIR, "curated-custom.tsv") }),
      ).toHaveLength(BUILTIN_CATALOG.length + 2);
      expect(resolveEnvSpy).not.toHaveBeenCalled();
      expect(execSpy).not.toHaveBeenCalled();
      expect(homeSpy).not.toHaveBeenCalled();
    } finally {
      resolveEnvSpy.mockRestore();
      execSpy.mockRestore();
      homeSpy.mockRestore();
    }
  });
});

describe("catalog lookup helpers", () => {
  const opts = { customCatalogFile: join(FIXTURE_DIR, "curated-custom.tsv") };

  test("findByRel hits builtin rows", () => {
    const row = findByRel("gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf", opts);
    expect(row?.id).toBe("gemma4-31b-q4");
  });
  test("findByRel hits custom rows", () => {
    const row = findByRel("Qwen3.5-4B-GGUF/Qwen3.5-4B-UD-Q4_K_XL.gguf", opts);
    expect(row?.id).toBe("test-qwen3-4b-q4");
  });
  test("relKnown + repoKnown", () => {
    expect(relKnown("Qwen3.5-4B-GGUF/Qwen3.5-4B-UD-Q4_K_XL.gguf", opts)).toBe(true);
    expect(relKnown("Does-Not-Exist/file.gguf", opts)).toBe(false);
    expect(repoKnown("unsloth/Qwen3.6-35B-A3B-GGUF", opts)).toBe(true);
    expect(repoKnown("unsloth/nothing-here", opts)).toBe(false);
  });
  test("findByRepoFile handles bare filename and full rel", () => {
    expect(
      findByRepoFile("unsloth/gemma-4-E4B-it-GGUF", "gemma-4-E4B-it-Q8_0.gguf", opts)?.id,
    ).toBe("gemma4-e4b-q8");
    expect(
      findByRepoFile(
        "unsloth/gemma-4-E4B-it-GGUF",
        "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf",
        opts,
      )?.id,
    ).toBe("gemma4-e4b-q8");
  });
});

describe("catalog.relFromRepoAndFile + curatedStatusForRepoFile", () => {
  test("joins repo basename with bare filename", () => {
    expect(relFromRepoAndFile("unsloth/foo-GGUF", "foo-UD-Q4_K_XL.gguf")).toBe(
      "foo-GGUF/foo-UD-Q4_K_XL.gguf",
    );
  });
  test("respects relpath files untouched", () => {
    expect(relFromRepoAndFile("unsloth/foo-GGUF", "distilled/foo.gguf")).toBe("distilled/foo.gguf");
  });
  test("curatedStatusForRepoFile labels curated / family-known / new", () => {
    const opts = { customCatalogFile: join(FIXTURE_DIR, "curated-custom.tsv") };
    expect(
      curatedStatusForRepoFile(
        "unsloth/gemma-4-31B-it-GGUF",
        "gemma-4-31B-it-UD-Q4_K_XL.gguf",
        opts,
      ),
    ).toBe("curated");
    expect(
      curatedStatusForRepoFile(
        "unsloth/gemma-4-31B-it-GGUF",
        "gemma-4-31B-it-UD-Q2_K_XL.gguf",
        opts,
      ),
    ).toBe("family-known");
    expect(curatedStatusForRepoFile("unsloth/some-new-repo", "model-UD-Q4_K_XL.gguf", opts)).toBe(
      "new",
    );
  });
});

describe("catalog TSV formatters", () => {
  test("writes format=mlx round-trips", () => {
    const written = formatCatalogTsv([
      {
        id: "mlx-host",
        label: "qwen3-8b-mlx",
        family: "qwen",
        class: "custom",
        scope: "candidate",
        rel: "mlx-community/Qwen3-8B-MLX-4bit",
        repo: "mlx-community/Qwen3-8B-MLX-4bit",
        format: "mlx",
      },
    ]);

    expect(written.split("\t")).toHaveLength(8);
    expect(written.endsWith("\tmlx")).toBe(true);
  });

  test("roundtrips column order", () => {
    const row = BUILTIN_CATALOG[0];
    expect(row).toBeDefined();
    if (!row) return;
    expect(formatCatalogRow(row).split("\t").length).toBe(8);
    expect(formatCatalogRow(row).split("\t")[7]).toBe("gguf");
    expect(formatCatalogTsv(BUILTIN_CATALOG).split("\n").length).toBe(BUILTIN_CATALOG.length);
  });
});

describe("catalog candidate metadata (#515)", () => {
  const parseCatalogRow = (catalogModule as Record<string, unknown>)["parseCatalogRow"] as
    | undefined
    | ((line: string) => { ok: true; entry: CuratedModel } | { ok: false; error: string });

  const base: CuratedModel = {
    id: "x",
    label: "X",
    family: "glm",
    class: "reasoning",
    scope: "candidate",
    rel: "X-GGUF/x.gguf",
    repo: "org/X-GGUF",
    format: "gguf",
  };

  test("every builtin row parses unchanged and round-trips byte-for-byte", () => {
    const hasMeta = (row: CuratedModel): boolean =>
      curatedMetaFields.some((key) => row[key] !== undefined);

    // Column 9 belongs to the #515 experimental rows: exactly the
    // first twelve legacy rows stay meta-free and eight-column.
    expect(BUILTIN_CATALOG.filter((row) => !hasMeta(row))).toHaveLength(12);
    expect(BUILTIN_CATALOG.slice(0, 12).every((row) => !hasMeta(row))).toBe(true);
    expect(BUILTIN_CATALOG.slice(12).every(hasMeta)).toBe(true);

    for (const row of BUILTIN_CATALOG) {
      const line = formatCatalogRow(row);
      expect(line.split("\t")).toHaveLength(hasMeta(row) ? 9 : 8);

      expect(typeof parseCatalogRow).toBe("function");
      const r = parseCatalogRow!(line);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(r.error);
      expect(r.entry).toStrictEqual({ ...row });
      expect(formatCatalogRow(r.entry)).toBe(line);
    }

    const tsv = formatCatalogTsv(BUILTIN_CATALOG);
    const dir = mkdtempSync(join(tmpdir(), "llamactl-catalog-meta-"));
    const file = join(dir, "builtin.tsv");
    writeFileSync(file, `${tsv}\n`);

    const rows = readCustomCatalog(file);
    expect(rows).toStrictEqual(BUILTIN_CATALOG.map((r) => ({ ...r })));
    expect(formatCatalogTsv(rows)).toBe(tsv);
  });

  test("the first twelve builtin rows keep their legacy eight-column bytes", () => {
    // Literal generated at the pre-#515 base. The seven experimental
    // rows appended after them must not perturb these bytes.
    const legacyTsv = [
      "gemma4-e4b-q8\tGemma 4 E4B Q8\tgemma4\tmultimodal\tfast\tgemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf\tunsloth/gemma-4-E4B-it-GGUF\tgguf",
      "gemma4-e4b-q4\tGemma 4 E4B Q4\tgemma4\tmultimodal\tcompact\tgemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf\tunsloth/gemma-4-E4B-it-GGUF\tgguf",
      "gemma4-26b-q4\tGemma 4 26B Q4\tgemma4\tmultimodal\tbalanced\tgemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf\tunsloth/gemma-4-26B-A4B-it-GGUF\tgguf",
      "gemma4-31b-q4\tGemma 4 31B Q4\tgemma4\tmultimodal\tquality\tgemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf\tunsloth/gemma-4-31B-it-GGUF\tgguf",
      "qwen36-iq2m\tQwen 3.6 35B-A3B IQ2_M\tqwen36\treasoning\tcompact-fit-16g\tQwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-IQ2_M.gguf\tunsloth/Qwen3.6-35B-A3B-GGUF\tgguf",
      "qwen36-q3s\tQwen 3.6 35B-A3B Q3_K_S\tqwen36\treasoning\tcompact\tQwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q3_K_S.gguf\tunsloth/Qwen3.6-35B-A3B-GGUF\tgguf",
      "qwen36-q4m\tQwen 3.6 35B-A3B Q4_K_M\tqwen36\treasoning\tbalanced\tQwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf\tunsloth/Qwen3.6-35B-A3B-GGUF\tgguf",
      "qwen36-q4\tQwen 3.6 35B-A3B Q4_K_XL\tqwen36\treasoning\tquality\tQwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf\tunsloth/Qwen3.6-35B-A3B-GGUF\tgguf",
      "qwen27-iq2m\tQwen 3.5 27B IQ2_M\tqwen35\treasoning\tcompact-fit-16g\tQwen3.5-27B-GGUF/Qwen3.5-27B-UD-IQ2_M.gguf\tunsloth/Qwen3.5-27B-GGUF\tgguf",
      "qwen27-q5\tQwen 3.5 27B Q5\tqwen35\treasoning\tlegacy-balanced\tQwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf\tunsloth/Qwen3.5-27B-GGUF\tgguf",
      "granite41-8b-q4\tGranite 4.1 8B Q4\tgranite41\tgeneral\tcompact-fit-16g\tgranite-4.1-8b-GGUF/granite-4.1-8b-Q4_K_M.gguf\tunsloth/granite-4.1-8b-GGUF\tgguf",
      "granite41-3b-q4\tGranite 4.1 3B Q4\tgranite41\tgeneral\tfast\tgranite-4.1-3b-GGUF/granite-4.1-3b-Q4_K_M.gguf\tunsloth/granite-4.1-3b-GGUF\tgguf",
    ].join("\n");

    expect(formatCatalogTsv(BUILTIN_CATALOG.slice(0, 12))).toBe(legacyTsv);
  });

  test("byte-exact round-trip with reordered nested keys produces canonical output", () => {
    // The example 9-column row from docs/tsv-schemas.md, verbatim, as
    // the canonical fixture. A computed fixture would let a key-order
    // swap in schemas.ts move the expected bytes with it; a literal
    // pins the documented order independently.
    const literal =
      'glm53-flash\tGLM-5.3 Flash\tglm\treasoning\tcandidate\tGLM-5.3-Flash-GGUF/glm-5.3-flash-Q4_K_M.gguf\tunsloth/GLM-5.3-Flash-GGUF\tgguf\t{"availability":{"declared":"unavailable","reason":"runtime-not-pinned"},"qualification":{"stage":"experimental","since":"2026-11-07","evidenceRef":"eval/glm53-flash-001"},"runtime":{"engines":["llamacpp","omlx"],"minBuild":"b6100"},"contextMax":131072,"params":{"totalB":106,"activeB":12,"experts":128},"memory":{"residentGiB":18.5},"residencyGroup":"big-moe","license":"mit"}';

    expect(literal.split("\t")).toHaveLength(9);

    expect(typeof parseCatalogRow).toBe("function");
    const parsed = parseCatalogRow!(literal);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(formatCatalogRow(parsed.entry)).toBe(literal);

    // Same data with top-level and nested keys reordered: formatting
    // must canonicalise back to the literal byte-for-byte.
    const basePart = literal.split("\t").slice(0, 8).join("\t");
    const reOrderedMeta = JSON.stringify({
      license: "mit",
      residencyGroup: "big-moe",
      memory: { residentGiB: 18.5 },
      params: { experts: 128, activeB: 12, totalB: 106 },
      contextMax: 131072,
      runtime: { minBuild: "b6100", engines: ["llamacpp", "omlx"] },
      qualification: {
        evidenceRef: "eval/glm53-flash-001",
        since: "2026-11-07",
        stage: "experimental",
      },
      availability: { reason: "runtime-not-pinned", declared: "unavailable" },
    });

    const reOrderedParse = parseCatalogRow!(`${basePart}\t${reOrderedMeta}`);
    expect(reOrderedParse.ok).toBe(true);
    if (!reOrderedParse.ok) throw new Error(reOrderedParse.error);
    expect(formatCatalogRow(reOrderedParse.entry)).toBe(literal);
  });

  test("byte-exact round-trip pins every runtime and memory key in schema order", () => {
    // The docs row above sets only runtime {engines, minBuild} and
    // memory {residentGiB}, so it cannot pin the order of the other
    // nested keys. This literal fills every runtime and memory field.
    const literal =
      'dsv41-flash-iq1s\tDeepSeek V4.1 Flash\tdeepseek\treasoning\tcandidate\tDeepSeek-V4.1-Flash-GGUF/UD-IQ1_S/model-00001.gguf\tunsloth/DeepSeek-V4.1-Flash-GGUF\tgguf\t{"availability":{"declared":"unavailable","reason":"artifact-not-downloaded"},"runtime":{"engines":["llamacpp"],"minBuild":"b11870","toolCallFormat":"deepseek","reasoningFormat":"deepseek-r1","chatTemplate":"deepseek-v4"},"memory":{"residentGiB":114,"diskBackedGiB":20,"kvGiBPer32k":4.5}}';

    expect(literal.split("\t")).toHaveLength(9);
    const parsed = parseCatalogRow!(literal);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(formatCatalogRow(parsed.entry)).toBe(literal);

    const basePart = literal.split("\t").slice(0, 8).join("\t");
    const reOrderedMeta = JSON.stringify({
      memory: { kvGiBPer32k: 4.5, diskBackedGiB: 20, residentGiB: 114 },
      runtime: {
        chatTemplate: "deepseek-v4",
        reasoningFormat: "deepseek-r1",
        toolCallFormat: "deepseek",
        minBuild: "b11870",
        engines: ["llamacpp"],
      },
      availability: { reason: "artifact-not-downloaded", declared: "unavailable" },
    });
    const reOrderedParse = parseCatalogRow!(`${basePart}\t${reOrderedMeta}`);
    expect(reOrderedParse.ok).toBe(true);
    if (!reOrderedParse.ok) throw new Error(reOrderedParse.error);
    expect(formatCatalogRow(reOrderedParse.entry)).toBe(literal);
  });

  test("formatCatalogRow drops invalid meta and emits exactly eight columns", () => {
    const invalidMetaEntry = {
      ...base,
      availability: { declared: "unavailable" },
    } as unknown as CuratedModel;

    const line = formatCatalogRow(invalidMetaEntry);
    const cols = line.split("\t");
    expect(cols).toHaveLength(8);
    expect(cols[7]).toBe("gguf");
    expect(cols[8]).toBeUndefined();
  });

  test("a legacy 7-column row still loads", () => {
    const line =
      "legacy-7\tLegacy Seven\tqwen35\tgeneral\tcandidate\tLegacy-GGUF/legacy-Q4_K_M.gguf\tunsloth/Legacy-GGUF";

    expect(typeof parseCatalogRow).toBe("function");
    const r = parseCatalogRow!(line);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.entry.format).toBe("gguf");
    expect(Object.keys(r.entry).sort()).toStrictEqual([
      "class",
      "family",
      "format",
      "id",
      "label",
      "rel",
      "repo",
      "scope",
    ]);

    const formatted = formatCatalogRow(r.entry);
    expect(formatted).toBe(`${line}\tgguf`);
    expect(formatted.split("\t")).toHaveLength(8);

    const dir = mkdtempSync(join(tmpdir(), "llamactl-catalog-meta-"));
    const file = join(dir, "legacy-7.tsv");
    writeFileSync(file, `${line}\n`);

    const rows = readCustomCatalog(file);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (!row) return;
    expect(Object.keys(row).sort()).toStrictEqual([
      "class",
      "family",
      "format",
      "id",
      "label",
      "rel",
      "repo",
      "scope",
    ]);
  });

  test("availability.declared=unavailable without reason is rejected", () => {
    expect(
      CuratedModel.safeParse({ ...base, availability: { declared: "unavailable" } }).success,
    ).toBe(false);

    const withReason = CuratedModel.safeParse({
      ...base,
      availability: { declared: "unavailable", reason: "artifact-not-downloaded" },
    });
    expect(withReason.success).toBe(true);
    if (!withReason.success) throw new Error("unavailable with reason must parse");
    expect((withReason.data as Record<string, unknown>)["availability"]).toStrictEqual({
      declared: "unavailable",
      reason: "artifact-not-downloaded",
    });

    const declaredAvailable = CuratedModel.safeParse({
      ...base,
      availability: { declared: "available" },
    });
    expect(declaredAvailable.success).toBe(true);
    if (!declaredAvailable.success) throw new Error("available must parse");
    expect((declaredAvailable.data as Record<string, unknown>)["availability"]).toStrictEqual({
      declared: "available",
    });

    expect(typeof parseCatalogRow).toBe("function");
    const metaLine = `${formatCatalogRow(base)}\t${JSON.stringify({
      availability: { declared: "unavailable" },
    })}`;
    expect(parseCatalogRow!(metaLine).ok).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "llamactl-catalog-meta-"));
    const file = join(dir, "unavailable-no-reason.tsv");
    writeFileSync(file, `${metaLine}\n`);

    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(readCustomCatalog(file)).toStrictEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test("an unknown qualification.stage is rejected", () => {
    expect(CuratedModel.safeParse({ ...base, qualification: { stage: "beta" } }).success).toBe(
      false,
    );

    for (const stage of ["experimental", "candidate", "validated", "production", "degraded"]) {
      const res = CuratedModel.safeParse({ ...base, qualification: { stage } });
      expect(res.success).toBe(true);
      if (!res.success) throw new Error(`stage ${stage} must parse`);
      expect((res.data as Record<string, unknown>)["qualification"]).toStrictEqual({ stage });
    }

    expect(typeof parseCatalogRow).toBe("function");
    const metaLine = `${formatCatalogRow(base)}\t${JSON.stringify({
      qualification: { stage: "beta" },
    })}`;
    expect(parseCatalogRow!(metaLine).ok).toBe(false);
  });

  test("a row with all new fields round-trips", () => {
    const full: CuratedModel = {
      ...base,
      availability: { declared: "unavailable", reason: "runtime-not-pinned" },
      qualification: {
        stage: "experimental",
        since: "2026-11-07",
        evidenceRef: "eval/glm53-flash-001",
      },
      runtime: {
        engines: ["llamacpp", "omlx"],
        minBuild: "b6100",
        toolCallFormat: "glm45",
        reasoningFormat: "deepseek",
        chatTemplate: "glm-4.5",
      },
      contextMax: 131072,
      params: { totalB: 106, activeB: 12, experts: 128 },
      memory: { residentGiB: 18.5, diskBackedGiB: 42, kvGiBPer32k: 2.25 },
      residencyGroup: "big-moe",
      license: "mit",
    };

    const line = formatCatalogRow(full);
    expect(line.split("\t")).toHaveLength(9);
    expect(
      Object.keys(JSON.parse(line.split("\t")[8] ?? "{}") as Record<string, unknown>),
    ).toStrictEqual([
      "availability",
      "qualification",
      "runtime",
      "contextMax",
      "params",
      "memory",
      "residencyGroup",
      "license",
    ]);

    expect(typeof parseCatalogRow).toBe("function");
    const r = parseCatalogRow!(line);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.entry).toStrictEqual(full);
    expect(formatCatalogRow(r.entry)).toBe(line);

    const dir = mkdtempSync(join(tmpdir(), "llamactl-catalog-meta-"));
    const file = join(dir, "full-meta.tsv");
    writeFileSync(file, `${line}\n`);
    expect(readCustomCatalog(file)).toStrictEqual([full]);
  });

  test("meta column null/[]/primitive is skipped with warning; rest loads", () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-catalog-meta-"));
    const file = join(dir, "bad-meta.tsv");

    const goodLine = formatCatalogRow({
      id: "good-row",
      label: "Good",
      family: "qwen",
      class: "general",
      scope: "candidate",
      rel: "Qwen-GGUF/good.gguf",
      repo: "org/Qwen-GGUF",
      format: "gguf",
    });

    const nullMetaLine = `${goodLine}\tnull`;
    const arrayMetaLine = `${goodLine}\t[1, 2]`;
    const primitiveMetaLine = `${goodLine}\t5`;

    writeFileSync(file, `${nullMetaLine}\n${arrayMetaLine}\n${primitiveMetaLine}\n${goodLine}\n`);

    const calls: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((...args: unknown[]) => {
      calls.push(String(args[0]));
      return true;
    });
    try {
      const rows = readCustomCatalog(file);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("good-row");
      // Each bad meta line produces one warning; assert the row's rel and a reason are present.
      expect(calls.length).toBe(3);
      const allMessages = calls.join("\n");
      expect(allMessages).toContain("Qwen-GGUF/good.gguf");
      expect(allMessages).toMatch(/meta must be a JSON object/);
    } finally {
      spy.mockRestore();
    }
  });

  test("invalid JSON in meta column is skipped with warning; rest loads", () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-catalog-meta-"));
    const file = join(dir, "bad-json.tsv");

    const goodLine = formatCatalogRow({
      id: "good-row",
      label: "Good",
      family: "qwen",
      class: "general",
      scope: "candidate",
      rel: "Qwen-GGUF/good.gguf",
      repo: "org/Qwen-GGUF",
      format: "gguf",
    });

    const badJsonLine = `${goodLine}\t{bad`;
    const validMetaLine = `${goodLine}\t${JSON.stringify({
      availability: { declared: "available" },
    })}`;

    writeFileSync(file, `${badJsonLine}\n${validMetaLine}\n`);

    const calls: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((...args: unknown[]) => {
      calls.push(String(args[0]));
      return true;
    });
    try {
      const rows = readCustomCatalog(file);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("good-row");
      expect(calls.length).toBe(1);
      expect(calls[0]).toContain("Qwen-GGUF/good.gguf");
      expect(calls[0]).toMatch(/invalid meta JSON/);
      expect((rows[0] as Record<string, unknown>)["availability"]).toStrictEqual({
        declared: "available",
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("empty column 9 (trailing tab) is treated as absent: row loads with no meta", () => {
    const base = formatCatalogRow({
      id: "trailing-tab",
      label: "Trailing Tab",
      family: "qwen",
      class: "general",
      scope: "candidate",
      rel: "Qwen-GGUF/trailing.gguf",
      repo: "org/Qwen-GGUF",
      format: "gguf",
    });

    const dir = mkdtempSync(join(tmpdir(), "llamactl-catalog-meta-"));
    const file = join(dir, "trailing-tab.tsv");
    writeFileSync(file, `${base}\t\n`);

    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const rows = readCustomCatalog(file);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("trailing-tab");
      // No meta keys should be present (trailing empty column = absent).
      const keys = Object.keys(rows[0]!).filter(
        (k) => !["id", "label", "family", "class", "scope", "rel", "repo", "format"].includes(k),
      );
      expect(keys).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("formatCatalogRow emits canonical nested key order", () => {
    const entry: CuratedModel = {
      id: "order-test",
      label: "Order Test",
      family: "qwen",
      class: "general",
      scope: "candidate",
      rel: "Qwen-GGUF/order.gguf",
      repo: "org/Qwen-GGUF",
      format: "gguf",
      runtime: {
        minBuild: "b100",
        engines: ["llamacpp"],
      },
      availability: {
        declared: "available",
      },
    };

    const line = formatCatalogRow(entry);
    const metaStr = line.split("\t")[8];
    expect(metaStr).toBeDefined();

    const keys = Object.keys(JSON.parse(metaStr ?? "{}") as Record<string, unknown>);
    // Only present keys are emitted; they appear in schema order.
    expect(keys).toStrictEqual(["availability", "runtime"]);

    const runtimeMeta = (JSON.parse(metaStr ?? "{}") as Record<string, unknown>)["runtime"] as
      | Record<string, unknown>
      | undefined;
    expect(runtimeMeta).toBeDefined();
    const runtimeKeys = Object.keys(runtimeMeta ?? {});
    // Only present nested keys in schema order: engines before minBuild.
    expect(runtimeKeys).toStrictEqual(["engines", "minBuild"]);
  });
});

describe("catalog experimental candidate rows (#515)", () => {
  const GLM_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";
  const DS_S_REL =
    "DeepSeek-V4.1-Flash-1017-GGUF/UD-IQ1_S/DeepSeek-V4.1-Flash-1017-UD-IQ1_S-00001-of-00005.gguf";
  const DS_M_REL =
    "DeepSeek-V4.1-Flash-1017-GGUF/UD-IQ1_M/DeepSeek-V4.1-Flash-1017-UD-IQ1_M-00001-of-00005.gguf";
  const DS_GSQ_REL = "DeepSeek-V4.1-Flash-1017-GSQ-RCO-GGUF/IQ1_M";
  const MIMO25_REL = "MiMo-V2.6-Flash-MOPD-GGUF/BPW2.5/MiMo-V2.6-Flash-MOPD-BPW2.5.gguf";
  const MIMO_A4X_REL = "MiMo-V2.6-Flash-MOPD-a4-x";
  const MIMO30_REL = "MiMo-V2.6-Flash-MOPD-GGUF/BPW3.0";

  const EXPERIMENTAL: readonly (readonly [string, string])[] = [
    [GLM_REL, "glm53-flash-aj-iq2xxs"],
    [DS_S_REL, "deepseek41-flash-1017-ud-iq1s"],
    [DS_M_REL, "deepseek41-flash-1017-ud-iq1m"],
    [DS_GSQ_REL, "deepseek41-flash-1017-gsq-rco-iq1m"],
    [MIMO25_REL, "mimo26-flash-mopd-bpw25"],
    [MIMO_A4X_REL, "mimo26-flash-mopd-a4x"],
    [MIMO30_REL, "mimo26-flash-mopd-bpw30"],
  ];

  test("each experimental rel resolves to its builtin row id", () => {
    for (const [rel, id] of EXPERIMENTAL) {
      expect(findByRel(rel, { scope: "builtin" })?.id).toBe(id);
    }
  });

  test("every experimental row is reasoning/gguf on z13-large-gpu at experimental stage", () => {
    for (const [rel] of EXPERIMENTAL) {
      const row = findByRel(rel, { scope: "builtin" });
      expect(row?.qualification?.stage).toBe("experimental");
      expect(row?.residencyGroup).toBe("z13-large-gpu");
      expect(row?.class).toBe("reasoning");
      expect(row?.format).toBe("gguf");
    }
  });

  test("glm53-flash-aj-iq2xxs pins the gufo fork, 1M ctx and NC license", () => {
    const row = findByRel(GLM_REL, { scope: "builtin" });
    expect(row?.family).toBe("glm53");
    expect(row?.repo).toBe("aj9o9/GLM-5.3-Flash-GGUF");
    expect(row?.runtime).toStrictEqual({
      engines: ["llamacpp"],
      minBuild: "fork:mikealanni/gufo@2e499c39",
    });
    expect(row?.contextMax).toBe(1048576);
    expect(row?.license ?? "").toContain("CC-BY-NC-ND-4.0");
    expect(row?.availability).toBeUndefined();
  });

  test("deepseek41 rows pin b11870 and declare unavailable with reasons", () => {
    const iq1s = findByRel(DS_S_REL, { scope: "builtin" });
    const iq1m = findByRel(DS_M_REL, { scope: "builtin" });
    const gsq = findByRel(DS_GSQ_REL, { scope: "builtin" });
    for (const row of [iq1s, iq1m, gsq]) {
      expect(row?.family).toBe("deepseek41");
      expect(row?.runtime).toStrictEqual({ engines: ["llamacpp"], minBuild: "b11870" });
      expect(row?.availability?.declared).toBe("unavailable");
    }
    expect(iq1s?.availability?.reason).toBe("artifact-not-downloaded; runtime-not-pinned");
    expect(iq1m?.availability?.reason).toBe("artifact-not-downloaded; runtime-not-pinned");
    expect(gsq?.availability?.reason).toBe(
      "artifact-not-downloaded; runtime-not-pinned; exceeds-node-budget-resident",
    );
    expect(iq1s?.memory).toStrictEqual({ residentGiB: 114.0, diskBackedGiB: 103 });
    expect(iq1m?.memory).toStrictEqual({ residentGiB: 130.2, diskBackedGiB: 103 });
    expect(gsq?.memory).toBeUndefined();
    expect(iq1s?.repo).toBe("unsloth/DeepSeek-V4.1-Flash-1017-GGUF");
    expect(iq1m?.repo).toBe("unsloth/DeepSeek-V4.1-Flash-1017-GGUF");
    expect(gsq?.repo).toBe("ISTA-DASLab/DeepSeek-V4.1-Flash-1017-GSQ-RCO-GGUF");
  });

  test("mimo26 rows pin b11298 with mimo-xml tool calls and think-tags reasoning", () => {
    const bpw25 = findByRel(MIMO25_REL, { scope: "builtin" });
    const a4x = findByRel(MIMO_A4X_REL, { scope: "builtin" });
    const bpw30 = findByRel(MIMO30_REL, { scope: "builtin" });
    for (const row of [bpw25, a4x, bpw30]) {
      expect(row?.family).toBe("mimo26");
      expect(row?.runtime).toStrictEqual({
        engines: ["llamacpp"],
        minBuild: "b11298",
        toolCallFormat: "mimo-xml",
        reasoningFormat: "think-tags",
      });
      expect(row?.availability?.declared).toBe("unavailable");
    }
    expect(bpw25?.availability?.reason).toBe("artifact-not-downloaded");
    expect(a4x?.availability?.reason).toBe("artifact-not-downloaded; runtime-unverified");
    expect(bpw30?.availability?.reason).toBe("exceeds-node-budget");
    expect(bpw25?.repo).toBe("AesSedai/MiMo-V2.6-Flash-MOPD-GGUF");
    expect(bpw30?.repo).toBe("AesSedai/MiMo-V2.6-Flash-MOPD-GGUF");
    expect(a4x?.repo).toBe("j2ipper/MiMo-V2.6-Flash-MOPD-a4-x");
  });

  test("each experimental row serialises to a parseable nine-column line", () => {
    for (const [rel] of EXPERIMENTAL) {
      const row = findByRel(rel, { scope: "builtin" });
      expect(row).not.toBeNull();
      if (row === null) continue;
      const line = formatCatalogRow(row);
      expect(line.split("\t")).toHaveLength(9);
      const parsed = parseCatalogRow(line);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.error);
      expect(parsed.entry).toStrictEqual({ ...row });
      expect(formatCatalogRow(parsed.entry)).toBe(line);
    }
  });

  test("no builtin row claims production; ids and rels are unique", () => {
    for (const row of BUILTIN_CATALOG) {
      expect(row.qualification?.stage).not.toBe("production");
    }
    expect(new Set(BUILTIN_CATALOG.map((row) => row.id)).size).toBe(BUILTIN_CATALOG.length);
    expect(new Set(BUILTIN_CATALOG.map((row) => row.rel)).size).toBe(BUILTIN_CATALOG.length);
  });
});
