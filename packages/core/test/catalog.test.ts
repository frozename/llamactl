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
  readCustomCatalog,
  relFromRepoAndFile,
  relKnown,
  repoKnown,
} from "../src/catalog.js";
import * as envModule from "../src/env.js";
import { mkdtempSync, writeFileSync } from "../src/safe-fs.js";
import { CuratedModel } from "../src/schemas.js";
import { FIXTURE_DIR } from "./helpers.js";

describe("catalog.BUILTIN_CATALOG", () => {
  test("has 12 entries in the expected order", () => {
    expect(BUILTIN_CATALOG.length).toBe(12);
    expect(BUILTIN_CATALOG[0]?.id).toBe("gemma4-e4b-q8");
    expect(BUILTIN_CATALOG[BUILTIN_CATALOG.length - 1]?.id).toBe("granite41-3b-q4");
  });
  test("every row has a rel under the expected repo prefix", () => {
    for (const row of BUILTIN_CATALOG) {
      const dir = row.rel.split("/")[0];
      expect(dir).toBe(row.repo.split("/").pop());
    }
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
    for (const row of BUILTIN_CATALOG) {
      const line = formatCatalogRow(row);
      expect(line.split("\t")).toHaveLength(8);

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
});
