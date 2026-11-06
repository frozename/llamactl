// This test pins the exported name surface of safe-fs and the barrel.
// Interpreted `export *` gives identical references (same as explicit
// re-exports), so say so — the test proves that, not compile-safety
// under `bun build --compile` (#121).

import { describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";

import * as policy from "../src/index.js";
import safeFsDefault, * as safeFs from "../src/safe-fs.js";
import { decideGuardianAction } from "../src/state.js";

describe("safe-fs name surface", () => {
  test("safeFs.accessSync is a function and same reference as nodeFs.accessSync", () => {
    expect(typeof safeFs.accessSync).toBe("function");
    expect(safeFs.accessSync).toBe(nodeFs.accessSync);
  });

  test("safeFs.appendFileSync is a function and same reference as nodeFs.appendFileSync", () => {
    expect(typeof safeFs.appendFileSync).toBe("function");
    expect(safeFs.appendFileSync).toBe(nodeFs.appendFileSync);
  });

  test("safeFs.chmodSync is a function and same reference as nodeFs.chmodSync", () => {
    expect(typeof safeFs.chmodSync).toBe("function");
    expect(safeFs.chmodSync).toBe(nodeFs.chmodSync);
  });

  test("safeFs.closeSync is a function and same reference as nodeFs.closeSync", () => {
    expect(typeof safeFs.closeSync).toBe("function");
    expect(safeFs.closeSync).toBe(nodeFs.closeSync);
  });

  test("safeFs.copyFileSync is a function and same reference as nodeFs.copyFileSync", () => {
    expect(typeof safeFs.copyFileSync).toBe("function");
    expect(safeFs.copyFileSync).toBe(nodeFs.copyFileSync);
  });

  test("safeFs.createReadStream is a function and same reference as nodeFs.createReadStream", () => {
    expect(typeof safeFs.createReadStream).toBe("function");
    expect(safeFs.createReadStream).toBe(nodeFs.createReadStream);
  });

  test("safeFs.createWriteStream is a function and same reference as nodeFs.createWriteStream", () => {
    expect(typeof safeFs.createWriteStream).toBe("function");
    expect(safeFs.createWriteStream).toBe(nodeFs.createWriteStream);
  });

  test("safeFs.existsSync is a function and same reference as nodeFs.existsSync", () => {
    expect(typeof safeFs.existsSync).toBe("function");
    expect(safeFs.existsSync).toBe(nodeFs.existsSync);
  });

  test("safeFs.lstatSync is a function and same reference as nodeFs.lstatSync", () => {
    expect(typeof safeFs.lstatSync).toBe("function");
    expect(safeFs.lstatSync).toBe(nodeFs.lstatSync);
  });

  test("safeFs.mkdirSync is a function and same reference as nodeFs.mkdirSync", () => {
    expect(typeof safeFs.mkdirSync).toBe("function");
    expect(safeFs.mkdirSync).toBe(nodeFs.mkdirSync);
  });

  test("safeFs.mkdtempSync is a function and same reference as nodeFs.mkdtempSync", () => {
    expect(typeof safeFs.mkdtempSync).toBe("function");
    expect(safeFs.mkdtempSync).toBe(nodeFs.mkdtempSync);
  });

  test("safeFs.openSync is a function and same reference as nodeFs.openSync", () => {
    expect(typeof safeFs.openSync).toBe("function");
    expect(safeFs.openSync).toBe(nodeFs.openSync);
  });

  test("safeFs.readdirSync is a function and same reference as nodeFs.readdirSync", () => {
    expect(typeof safeFs.readdirSync).toBe("function");
    expect(safeFs.readdirSync).toBe(nodeFs.readdirSync);
  });

  test("safeFs.readFileSync is a function and same reference as nodeFs.readFileSync", () => {
    expect(typeof safeFs.readFileSync).toBe("function");
    expect(safeFs.readFileSync).toBe(nodeFs.readFileSync);
  });

  test("safeFs.readlinkSync is a function and same reference as nodeFs.readlinkSync", () => {
    expect(typeof safeFs.readlinkSync).toBe("function");
    expect(safeFs.readlinkSync).toBe(nodeFs.readlinkSync);
  });

  test("safeFs.readSync is a function and same reference as nodeFs.readSync", () => {
    expect(typeof safeFs.readSync).toBe("function");
    expect(safeFs.readSync).toBe(nodeFs.readSync);
  });

  test("safeFs.renameSync is a function and same reference as nodeFs.renameSync", () => {
    expect(typeof safeFs.renameSync).toBe("function");
    expect(safeFs.renameSync).toBe(nodeFs.renameSync);
  });

  test("safeFs.rmSync is a function and same reference as nodeFs.rmSync", () => {
    expect(typeof safeFs.rmSync).toBe("function");
    expect(safeFs.rmSync).toBe(nodeFs.rmSync);
  });

  test("safeFs.statSync is a function and same reference as nodeFs.statSync", () => {
    expect(typeof safeFs.statSync).toBe("function");
    expect(safeFs.statSync).toBe(nodeFs.statSync);
  });

  test("safeFs.symlinkSync is a function and same reference as nodeFs.symlinkSync", () => {
    expect(typeof safeFs.symlinkSync).toBe("function");
    expect(safeFs.symlinkSync).toBe(nodeFs.symlinkSync);
  });

  test("safeFs.truncateSync is a function and same reference as nodeFs.truncateSync", () => {
    expect(typeof safeFs.truncateSync).toBe("function");
    expect(safeFs.truncateSync).toBe(nodeFs.truncateSync);
  });

  test("safeFs.unlinkSync is a function and same reference as nodeFs.unlinkSync", () => {
    expect(typeof safeFs.unlinkSync).toBe("function");
    expect(safeFs.unlinkSync).toBe(nodeFs.unlinkSync);
  });

  test("safeFs.unwatchFile is a function and same reference as nodeFs.unwatchFile", () => {
    expect(typeof safeFs.unwatchFile).toBe("function");
    expect(safeFs.unwatchFile).toBe(nodeFs.unwatchFile);
  });

  test("safeFs.utimesSync is a function and same reference as nodeFs.utimesSync", () => {
    expect(typeof safeFs.utimesSync).toBe("function");
    expect(safeFs.utimesSync).toBe(nodeFs.utimesSync);
  });

  test("safeFs.watchFile is a function and same reference as nodeFs.watchFile", () => {
    expect(typeof safeFs.watchFile).toBe("function");
    expect(safeFs.watchFile).toBe(nodeFs.watchFile);
  });

  test("safeFs.writeFileSync is a function and same reference as nodeFs.writeFileSync", () => {
    expect(typeof safeFs.writeFileSync).toBe("function");
    expect(safeFs.writeFileSync).toBe(nodeFs.writeFileSync);
  });

  test("safeFs.writeSync is a function and same reference as nodeFs.writeSync", () => {
    expect(typeof safeFs.writeSync).toBe("function");
    expect(safeFs.writeSync).toBe(nodeFs.writeSync);
  });
});

describe("safe-fs constants", () => {
  test("safeFs.constants is the same reference as nodeFs.constants", () => {
    expect(safeFs.constants).toBe(nodeFs.constants);
  });
});

describe("safe-fs default export", () => {
  test("default export readFileSync is nodeFs.readFileSync", () => {
    expect(safeFsDefault.readFileSync).toBe(nodeFs.readFileSync);
  });

  test("default export writeFileSync is nodeFs.writeFileSync", () => {
    expect(safeFsDefault.writeFileSync).toBe(nodeFs.writeFileSync);
  });
});

describe("safe-fs no-export-star source guard", () => {
  test("module source does not contain `export * from`", () => {
    const source = safeFs.readFileSync(new URL("../src/safe-fs.ts", import.meta.url), "utf8");
    // Comment lines that mention `export *` start with `//`, so the
    // anchored regex does not match them. `export type { WriteStream }`
    // does not match either.
    expect(source).not.toMatch(/^export \*\s+from/m);
  });
});

describe("barrel exports", () => {
  test("Object.keys(policy).sort() equals the expected list", () => {
    expect(Object.keys(policy).sort()).toEqual([
      "CostGuardianBudgetSchema",
      "CostGuardianConfigSchema",
      "CostGuardianThresholdsSchema",
      "appendCostJournal",
      "decideGuardianAction",
      "defaultCostGuardianConfigPath",
      "defaultCostJournalPath",
      "emptyCostGuardianConfig",
      "loadCostGuardianConfig",
    ]);
  });

  test("policy.decideGuardianAction is the same function as the one from state.js", () => {
    expect(policy.decideGuardianAction).toBe(decideGuardianAction);
  });
});
