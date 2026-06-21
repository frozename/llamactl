import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveBuildId } from "../src/build.js";
import { resolveEnv } from "../src/env.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

describe("resolveBuildId", () => {
  test("returns a hex short-SHA from a real git checkout", () => {
    const repoRoot = join(import.meta.dir, "../../..");
    const resolved = resolveEnv({
      ...process.env,
      LLAMA_CPP_SRC: repoRoot,
      LLAMACTL_TEST_PROFILE: "",
    });
    expect(resolveBuildId(resolved)).toMatch(/^[0-9a-f]{4,}/i);
  });

  test("falls back to bin-<mtime> when SRC is not a git repo but binary exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-build-"));
    try {
      const fakeBin = join(tmp, "bin");
      mkdirSync(fakeBin);
      writeFileSync(join(fakeBin, "llama-server"), "");
      const resolved = resolveEnv({
        ...process.env,
        LLAMA_CPP_SRC: tmp,
        LLAMA_CPP_BIN: fakeBin,
        LLAMACTL_TEST_PROFILE: "",
      });
      expect(resolveBuildId(resolved)).toMatch(/^bin-\d+$/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns 'unknown' when neither source nor binary is present", () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-build-"));
    try {
      const resolved = resolveEnv({
        ...process.env,
        LLAMA_CPP_SRC: tmp,
        LLAMA_CPP_BIN: tmp,
        LLAMACTL_TEST_PROFILE: "",
      });
      expect(resolveBuildId(resolved)).toBe("unknown");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
