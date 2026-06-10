import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
