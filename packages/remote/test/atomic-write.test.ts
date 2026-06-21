import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../src/atomic-write.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";

let dir = "";

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("atomicWriteFileSync", () => {
  test("writes the file contents", () => {
    dir = mkdtempSync(join(tmpdir(), "atomic-write-"));
    const path = join(dir, "f.txt");
    atomicWriteFileSync(path, "hello");
    expect(readFileSync(path, "utf8")).toBe("hello");
  });

  test("overwrites an existing file", () => {
    dir = mkdtempSync(join(tmpdir(), "atomic-write-"));
    const path = join(dir, "f.txt");
    writeFileSync(path, "stale", "utf8");
    atomicWriteFileSync(path, "fresh");
    expect(readFileSync(path, "utf8")).toBe("fresh");
  });

  test("leaves no .tmp sibling behind after a successful write", () => {
    dir = mkdtempSync(join(tmpdir(), "atomic-write-"));
    const path = join(dir, "f.txt");
    atomicWriteFileSync(path, "x");
    expect(readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual([]);
  });
});
