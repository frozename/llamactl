import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type * as OverridesNs from "../../src/qualification/overrides.js";

import { existsSync, mkdirSync, writeFileSync } from "../../src/safe-fs.js";
import { envForTemp, makeTempRuntime } from "../helpers.js";

type Overrides = typeof OverridesNs;

async function loadOverrides(): Promise<Overrides> {
  const m: Overrides | null = await import("../../src/qualification/overrides.js").catch(
    () => null,
  );
  expect(m).not.toBeNull();
  if (m === null) {
    throw new Error("qualification/overrides module missing");
  }
  return m;
}

const temp = makeTempRuntime();
const UPDATED_AT = "2026-11-07T00:00:00Z";

afterEach(() => {
  temp.cleanup();
});

describe("qualification.overrides.readQualificationOverrides", () => {
  test("returns [] when the file does not exist", async () => {
    const { readQualificationOverrides } = await loadOverrides();
    expect(readQualificationOverrides(join(temp.runtimeDir, "missing.tsv"))).toEqual([]);
  });

  test("skips comments, blanks and malformed rows and preserves updated_at", async () => {
    const { readQualificationOverrides } = await loadOverrides();
    mkdirSync(temp.runtimeDir, { recursive: true });
    const file = join(temp.runtimeDir, "overrides.tsv");
    writeFileSync(
      file,
      [
        "# comment",
        "",
        "only\ttwo",
        "m.gguf\tpin\tvalidated\top\tmanual\t2026-11-07T00:00:00Z",
        "m.gguf\tfreeze\t\top\thold\t",
        "",
      ].join("\n"),
    );
    const rows = readQualificationOverrides(file);
    expect(rows).toHaveLength(2);
    expect(rows).toMatchObject([
      {
        rel: "m.gguf",
        action: "pin",
        stage: "validated",
        author: "op",
        reason: "manual",
        updated_at: "2026-11-07T00:00:00Z",
      },
      { rel: "m.gguf", action: "freeze", stage: "", updated_at: "" },
    ]);
  });

  test("skips rows with invalid action, stage or stage/action mismatch", async () => {
    const { readQualificationOverrides } = await loadOverrides();
    mkdirSync(temp.runtimeDir, { recursive: true });
    const file = join(temp.runtimeDir, "overrides.tsv");
    writeFileSync(
      file,
      [
        "m.gguf\tpin\t\top\tempty stage\t2026-01-01T00:00:00Z",
        "m.gguf\tfreeze\tvalidated\top\tfreeze with stage\t2026-01-01T00:00:00Z",
        "m.gguf\tpromote\tcandidate\top\tbad action\t2026-01-01T00:00:00Z",
        "m.gguf\tpin\tbogus\top\tbad stage\t2026-01-01T00:00:00Z",
        "ok.gguf\tpin\tcandidate\top\tgood row\t2026-11-07T00:00:00Z",
        "",
      ].join("\n"),
    );
    const rows = readQualificationOverrides(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rel: "ok.gguf", action: "pin", stage: "candidate" });
  });
});

describe("qualification.overrides.writeQualificationOverride", () => {
  test("creates parent dirs and round-trips a pin row", async () => {
    const { readQualificationOverrides, writeQualificationOverride } = await loadOverrides();
    const file = join(temp.runtimeDir, "nested", "overrides.tsv");
    writeQualificationOverride(
      file,
      { rel: "m.gguf", action: "pin", stage: "candidate", author: "op", reason: "r" },
      UPDATED_AT,
    );
    expect(existsSync(file)).toBe(true);
    expect(readQualificationOverrides(file)).toMatchObject([
      {
        rel: "m.gguf",
        action: "pin",
        stage: "candidate",
        author: "op",
        reason: "r",
        updated_at: UPDATED_AT,
      },
    ]);
  });

  test("replaces the same (rel, action) row in place", async () => {
    const { readQualificationOverrides, writeQualificationOverride } = await loadOverrides();
    const file = join(temp.runtimeDir, "overrides.tsv");
    writeQualificationOverride(
      file,
      { rel: "m.gguf", action: "pin", stage: "candidate", author: "op", reason: "first" },
      UPDATED_AT,
    );
    writeQualificationOverride(
      file,
      { rel: "m.gguf", action: "pin", stage: "validated", author: "op", reason: "second" },
      UPDATED_AT,
    );
    const rows = readQualificationOverrides(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rel: "m.gguf", action: "pin", stage: "validated" });
  });

  test("freeze is a separate row for the same rel", async () => {
    const { readQualificationOverrides, writeQualificationOverride } = await loadOverrides();
    const file = join(temp.runtimeDir, "overrides.tsv");
    writeQualificationOverride(
      file,
      { rel: "m.gguf", action: "pin", stage: "candidate", author: "op", reason: "pin it" },
      UPDATED_AT,
    );
    writeQualificationOverride(
      file,
      { rel: "m.gguf", action: "freeze", stage: "", author: "op", reason: "hold" },
      UPDATED_AT,
    );
    const rows = readQualificationOverrides(file);
    expect(rows).toHaveLength(2);
    expect(rows).toMatchObject([
      { rel: "m.gguf", action: "pin", stage: "candidate" },
      { rel: "m.gguf", action: "freeze", stage: "" },
    ]);
  });

  test("rejects a rel containing a tab and writes nothing", async () => {
    const { writeQualificationOverride } = await loadOverrides();
    const file = join(temp.runtimeDir, "overrides.tsv");
    expect(() =>
      writeQualificationOverride(
        file,
        { rel: "m\tgguf", action: "pin", stage: "candidate", author: "op", reason: "r" },
        UPDATED_AT,
      ),
    ).toThrow();
    expect(existsSync(file)).toBe(false);
  });

  test("rejects an author containing a newline and writes nothing", async () => {
    const { writeQualificationOverride } = await loadOverrides();
    const file = join(temp.runtimeDir, "overrides.tsv");
    expect(() =>
      writeQualificationOverride(
        file,
        { rel: "m.gguf", action: "pin", stage: "candidate", author: "o\np", reason: "r" },
        UPDATED_AT,
      ),
    ).toThrow();
    expect(existsSync(file)).toBe(false);
  });

  test("rejects a reason containing a tab and writes nothing", async () => {
    const { writeQualificationOverride } = await loadOverrides();
    const file = join(temp.runtimeDir, "overrides.tsv");
    expect(() =>
      writeQualificationOverride(
        file,
        { rel: "m.gguf", action: "pin", stage: "candidate", author: "op", reason: "a\tb" },
        UPDATED_AT,
      ),
    ).toThrow();
    expect(existsSync(file)).toBe(false);
  });
});

describe("qualification.overrides.deleteQualificationOverride", () => {
  test("removes the row, reports repeats and unlinks the file with the last row", async () => {
    const { deleteQualificationOverride, readQualificationOverrides, writeQualificationOverride } =
      await loadOverrides();
    const file = join(temp.runtimeDir, "overrides.tsv");
    writeQualificationOverride(
      file,
      { rel: "m.gguf", action: "pin", stage: "candidate", author: "op", reason: "pin it" },
      UPDATED_AT,
    );
    writeQualificationOverride(
      file,
      { rel: "m.gguf", action: "freeze", stage: "", author: "op", reason: "hold" },
      UPDATED_AT,
    );
    expect(deleteQualificationOverride(file, "m.gguf", "pin")).toBe(true);
    expect(deleteQualificationOverride(file, "m.gguf", "pin")).toBe(false);
    expect(readQualificationOverrides(file)).toMatchObject([{ rel: "m.gguf", action: "freeze" }]);
    expect(deleteQualificationOverride(file, "m.gguf", "freeze")).toBe(true);
    expect(existsSync(file)).toBe(false);
  });
});

describe("qualification.overrides.overridesFor", () => {
  test("groups a rel's rows into pin and freeze and ignores other rels", async () => {
    const { overridesFor, readQualificationOverrides } = await loadOverrides();
    mkdirSync(temp.runtimeDir, { recursive: true });
    const file = join(temp.runtimeDir, "overrides.tsv");
    writeFileSync(
      file,
      [
        "m.gguf\tpin\tvalidated\top\tmanual pin\t2026-11-07T00:00:00Z",
        "m.gguf\tfreeze\t\top\thold\t",
        "other.gguf\tpin\tcandidate\top\tother rel\t2026-01-01T00:00:00Z",
        "",
      ].join("\n"),
    );
    const rows = readQualificationOverrides(file);
    expect(overridesFor(rows, "m.gguf")).toMatchObject({
      pin: {
        rel: "m.gguf",
        action: "pin",
        stage: "validated",
        updated_at: "2026-11-07T00:00:00Z",
      },
      freeze: { rel: "m.gguf", action: "freeze", updated_at: "" },
    });
    expect(overridesFor(rows, "unknown")).toEqual({});
  });
});

describe("qualification.overrides.qualificationOverridesFile", () => {
  test("prefers LOCAL_AI_QUALIFICATION_OVERRIDES_FILE", async () => {
    const { qualificationOverridesFile } = await loadOverrides();
    expect(qualificationOverridesFile({ LOCAL_AI_QUALIFICATION_OVERRIDES_FILE: "/x/q.tsv" })).toBe(
      "/x/q.tsv",
    );
  });

  test("defaults to qualification-overrides.tsv under the runtime dir", async () => {
    const { qualificationOverridesFile } = await loadOverrides();
    expect(qualificationOverridesFile(envForTemp(temp))).toBe(
      join(temp.runtimeDir, "qualification-overrides.tsv"),
    );
  });
});
