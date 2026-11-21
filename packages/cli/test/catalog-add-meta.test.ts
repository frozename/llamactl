// RED tests for frozename/llamactl#522: `llamactl catalog add --meta
// <json>` passes candidate metadata through to catalogWriter.addCurated,
// which validates it against CuratedMeta.strict() and writes it as
// column 9 of the custom catalog TSV. On the base runAdd ignores every
// flag after the six positionals, so --meta is dropped, unknown flags
// are silently accepted, `--` is not honoured and `--help` anywhere in
// argv prints USAGE — every case fails by assertion on exit code,
// stderr text or the listed/file row, never by import.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { existsSync, readFileSync } from "../src/safe-fs.js";
import { makeTempRuntime, parseJsonArray, requireRecord, runCli } from "./helpers.js";

const REL = "Meta-E2E-GGUF/meta-e2e-Q4.gguf";
const POSITIONALS = [
  "unsloth/Meta-E2E-GGUF",
  "meta-e2e-Q4.gguf",
  "Meta E2E",
  "custom",
  "general",
  "candidate",
];
const ADD_USAGE =
  "add <hf-repo> <gguf-file-or-relpath> [label] [family] [class] [scope] [--meta <json>]";

describe("catalog add --meta (#522)", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  beforeEach(() => {
    temp = makeTempRuntime();
  });
  afterEach(() => {
    temp.cleanup();
  });

  const catalogFileRaw = (): string => {
    const file = temp.env["LOCAL_AI_CUSTOM_CATALOG_FILE"];
    if (file === undefined || !existsSync(file)) return "";
    return readFileSync(file, "utf8");
  };

  const listedRow = (): Record<string, unknown> => {
    const list = runCli(["catalog", "list", "custom", "--json"], temp.env);
    expect(list.code).toBe(0);
    const row = parseJsonArray(list.stdout)
      .map(requireRecord)
      .find((r) => r["rel"] === REL);
    expect(row, `catalog row for ${REL}`).toBeDefined();
    return requireRecord(row);
  };

  // Kills: deleting runAdd's `positionals.length < 2` usage check. With one
  // positional (the meta value must not count as one) or none, the command
  // prints the catalog USAGE on stdout, exits 1 and writes no catalog row.
  for (const argv of [
    [POSITIONALS[0], "--meta", '{"qualification":{"stage":"experimental"}}'],
    [],
  ] as const) {
    test(`catalog add with ${String(argv.length === 0 ? 0 : 1)} positional(s) prints usage`, () => {
      const add = runCli(["catalog", "add", ...argv], temp.env);
      expect(add.code).toBe(1);
      expect(add.stdout).toContain(ADD_USAGE);
      expect(catalogFileRaw()).toBe("");
    });
  }

  test("--meta <json> round-trips into list output and column 9", () => {
    const meta = {
      availability: { declared: "unavailable", reason: "artifact-not-downloaded" },
      qualification: { stage: "experimental" },
      residencyGroup: "z13-large-gpu",
    };
    const add = runCli(
      ["catalog", "add", ...POSITIONALS, "--meta", JSON.stringify(meta)],
      temp.env,
    );
    expect(add.code).toBe(0);

    const row = listedRow();
    expect({
      availability: row["availability"],
      qualification: row["qualification"],
      residencyGroup: row["residencyGroup"],
    }).toEqual(meta);

    const line = catalogFileRaw()
      .split("\n")
      .find((l) => l.includes(REL));
    expect(line, "custom catalog row").toBeDefined();
    const cols = (line ?? "").split("\t");
    expect(cols.length, "column 9 present").toBeGreaterThanOrEqual(9);
    expect(JSON.parse(cols[8] ?? "")).toEqual(meta);
  });

  test("--meta=<json> equals form is parsed", () => {
    const add = runCli(
      ["catalog", "add", ...POSITIONALS, '--meta={"qualification":{"stage":"candidate"}}'],
      temp.env,
    );
    expect(add.code).toBe(0);
    const row = listedRow();
    expect(row["qualification"]).toEqual({ stage: "candidate" });
  });

  test("qualification status reports the catalog stage from --meta", () => {
    const add = runCli(
      [
        "catalog",
        "add",
        ...POSITIONALS,
        "--meta",
        JSON.stringify({ qualification: { stage: "experimental" } }),
      ],
      temp.env,
    );
    expect(add.code).toBe(0);
    const status = runCli(["qualification", "status", REL, "--json"], temp.env);
    expect(status.code).toBe(0);
    const view = requireRecord(JSON.parse(status.stdout));
    expect(view["catalogStage"]).toBe("experimental");
  });

  test("--meta with an unrecognized key is refused and writes nothing", () => {
    const add = runCli(["catalog", "add", ...POSITIONALS, "--meta", '{"bogus":1}'], temp.env);
    expect(add.code).toBe(1);
    expect(add.stderr).toContain("invalid catalog meta: unrecognized key(s): bogus");
    expect(catalogFileRaw().includes(REL), "no row written").toBe(false);
  });

  test("--meta with malformed JSON is refused", () => {
    const add = runCli(["catalog", "add", ...POSITIONALS, "--meta", "{not json"], temp.env);
    expect(add.code).toBe(1);
    expect(add.stderr).toContain("catalog add: --meta is not valid JSON");
    expect(catalogFileRaw().includes(REL), "no row written").toBe(false);
  });

  test("--meta without a value is refused", () => {
    const add = runCli(["catalog", "add", ...POSITIONALS, "--meta"], temp.env);
    expect(add.code).toBe(1);
    expect(add.stderr).toContain("catalog add: --meta requires a JSON value");
    expect(catalogFileRaw().includes(REL), "no row written").toBe(false);
  });

  test("unknown flag after the positionals is refused", () => {
    const add = runCli(["catalog", "add", ...POSITIONALS, "--bogus"], temp.env);
    expect(add.code).toBe(1);
    expect(add.stderr).toContain("catalog add: unknown flag --bogus");
    expect(catalogFileRaw().includes(REL), "no row written").toBe(false);
  });

  test("help text advertises --meta", () => {
    const catalogHelp = runCli(["catalog", "--help"], temp.env);
    expect(catalogHelp.code).toBe(0);
    expect(catalogHelp.stdout).toContain(ADD_USAGE);
    const addHelp = runCli(["catalog", "add", "--help"], temp.env);
    expect(addHelp.code).toBe(0);
    expect(addHelp.stdout).toContain(ADD_USAGE);
  });

  test("`--` ends flag parsing; later --words are positionals", () => {
    const add = runCli(
      [
        "catalog",
        "add",
        "unsloth/Meta-E2E-GGUF",
        "meta-e2e-Q4.gguf",
        "--",
        "--dash-label",
        "custom",
        "general",
        "candidate",
      ],
      temp.env,
    );
    expect(add.code).toBe(0);
    const row = listedRow();
    expect(row["label"]).toBe("--dash-label");
    expect(row["family"]).toBe("custom");
    expect(row["class"]).toBe("general");
    expect(row["scope"]).toBe("candidate");
  });

  test("--meta always consumes the next token, even --help", () => {
    const add = runCli(["catalog", "add", ...POSITIONALS, "--meta", "--help"], temp.env);
    expect(add.code).toBe(1);
    expect(add.stderr).toContain("catalog add: --meta is not valid JSON");
    expect(add.stdout).not.toContain("Usage:");
  });

  // Part of #522 ship-time fix: the --meta value must never be taken as a
  // positional. Mutation "meta value also pushed as positional" makes the
  // JSON the label here, so family/class shift and class is refused.
  test("--meta in the middle leaves the later positionals in place", () => {
    const meta = { qualification: { stage: "candidate" } };
    const add = runCli(
      [
        "catalog",
        "add",
        "unsloth/Meta-E2E-GGUF",
        "meta-e2e-Q4.gguf",
        "--meta",
        JSON.stringify(meta),
        "Meta E2E",
        "custom",
        "general",
        "candidate",
      ],
      temp.env,
    );
    expect(add.code).toBe(0);
    const row = listedRow();
    expect(row["label"]).toBe("Meta E2E");
    expect(row["family"]).toBe("custom");
    expect(row["class"]).toBe("general");
    expect(row["scope"]).toBe("candidate");
    expect(row["qualification"]).toEqual(meta.qualification);
  });

  // Mutation "meta value also pushed as positional" persists the JSON as
  // the scope column of the row.
  test("persisted entry has no stray positional field from --meta", () => {
    const metaJson = JSON.stringify({ qualification: { stage: "experimental" } });
    const add = runCli(
      [
        "catalog",
        "add",
        "unsloth/Meta-E2E-GGUF",
        "meta-e2e-Q4.gguf",
        "Meta E2E",
        "custom",
        "general",
        "--meta",
        metaJson,
      ],
      temp.env,
    );
    expect(add.code).toBe(0);
    expect(listedRow()["scope"]).toBe("candidate");
    const line = catalogFileRaw()
      .split("\n")
      .find((l) => l.includes(REL));
    expect(line, "custom catalog row").toBeDefined();
    const cols = (line ?? "").split("\t");
    expect(cols.length).toBe(9);
    expect(cols.slice(0, 8).some((c) => c.includes("qualification"))).toBe(false);
    expect(cols[4]).toBe("candidate");
    expect(JSON.parse(cols[8] ?? "")).toEqual(JSON.parse(metaJson));
  });

  test("top-level help advertises --meta on catalog add", () => {
    const r = runCli(["--help"], temp.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "llamactl catalog add <repo> <file> [label] [family] [class] [scope] [--meta <json>]",
    );
  });
});
