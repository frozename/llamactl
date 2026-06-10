import { describe, expect, test } from "bun:test";

import {
  canonicalSlotDir,
  parseAbsoluteSlotSavePath,
  parseSlotSavePathFromCommand,
  resolveSlotSavePathArgs,
  SLOT_SAVE_PATH_AUTO,
} from "../src/kvstore/index.js";

describe("kvstore.slotPath", () => {
  test("resolves auto in --slot-save-path flag form", () => {
    const result = resolveSlotSavePathArgs(
      ["--slot-save-path", SLOT_SAVE_PATH_AUTO],
      "/tmp/runtime",
      "workload-a",
    );
    expect(result.slotSavePath).toBe("/tmp/runtime/kvstore/slots/workload-a");
    expect(result.args).toEqual(["--slot-save-path", "/tmp/runtime/kvstore/slots/workload-a"]);
  });

  test("resolves auto in --slot-save-path= form", () => {
    const result = resolveSlotSavePathArgs(["--slot-save-path=auto"], "/tmp/runtime", "workload-a");
    expect(result.slotSavePath).toBe("/tmp/runtime/kvstore/slots/workload-a");
    expect(result.args).toEqual(["--slot-save-path=/tmp/runtime/kvstore/slots/workload-a"]);
  });

  test("returns null when the flag is absent", () => {
    const input = ["--foo", "bar"];
    const result = resolveSlotSavePathArgs(input, "/tmp/runtime", "workload-a");
    expect(result.slotSavePath).toBeNull();
    expect(result.args).toEqual(input);
  });

  test("rejects traversal in workload names", () => {
    expect(() => canonicalSlotDir("/tmp/runtime", "../escape")).toThrow();
  });

  test("parses legacy absolute slot-save-path values only", () => {
    expect(parseAbsoluteSlotSavePath(["--slot-save-path", "/tmp/slots"])).toBe("/tmp/slots");
    expect(parseAbsoluteSlotSavePath(["--slot-save-path=auto"])).toBeNull();
    expect(parseAbsoluteSlotSavePath(["--slot-save-path", "auto"])).toBeNull();
  });

  test("parses slot-save-path from a command string", () => {
    expect(parseSlotSavePathFromCommand("/bin/llama --slot-save-path /tmp/slots")).toBe(
      "/tmp/slots",
    );
    expect(parseSlotSavePathFromCommand("/bin/llama --slot-save-path=auto")).toBeNull();
  });
});
