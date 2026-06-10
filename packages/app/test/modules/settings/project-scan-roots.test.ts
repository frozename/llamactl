import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PROJECT_SCAN_ROOTS,
  getProjectScanRoots,
  parseProjectScanRootsText,
} from "../../../src/modules/settings/project-scan-roots";

describe("project scan roots setting", () => {
  test("parses newline and comma separated roots", () => {
    expect(parseProjectScanRootsText("~/a, ~/b\n~/c")).toEqual([
      "~/a",
      "~/b",
      "~/c",
    ]);
  });

  test("dedupes duplicate roots while preserving first occurrence order", () => {
    expect(parseProjectScanRootsText("~/a, ~/b\n~/a, ~/c\n~/b")).toEqual([
      "~/a",
      "~/b",
      "~/c",
    ]);
  });

  test("falls back to the built-in defaults when empty", () => {
    expect(getProjectScanRoots("")).toEqual([...DEFAULT_PROJECT_SCAN_ROOTS]);
    expect(getProjectScanRoots("   \n , ")).toEqual([
      ...DEFAULT_PROJECT_SCAN_ROOTS,
    ]);
  });
});
