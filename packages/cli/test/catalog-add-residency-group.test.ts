import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { existsSync, readFileSync } from "../src/safe-fs.js";
import { makeTempRuntime, runCli } from "./helpers.js";

const REL = "Group-E2E-GGUF/group-e2e-Q4.gguf";
const POSITIONALS = [
  "unsloth/Group-E2E-GGUF",
  "group-e2e-Q4.gguf",
  "Group E2E",
  "custom",
  "general",
  "candidate",
];

describe("catalog add --meta residencyGroup (#517)", () => {
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

  test("C1: refuses a residency group missing from the declarations", () => {
    const add = runCli(
      ["catalog", "add", ...POSITIONALS, "--meta", '{"residencyGroup":"z13-large"}'],
      temp.env,
    );
    expect(add.code).toBe(1);
    expect(add.stderr).toContain("invalid catalog meta: residencyGroup:");
    expect(add.stderr).toContain("is not declared");
    expect(catalogFileRaw().includes(REL), "no row written").toBe(false);
  });

  test("C2: accepts a declared residency group", () => {
    const add = runCli(
      ["catalog", "add", ...POSITIONALS, "--meta", '{"residencyGroup":"z13-large-gpu"}'],
      temp.env,
    );
    expect(add.code).toBe(0);
    expect(catalogFileRaw().includes(REL), "row written").toBe(true);
  });
});
