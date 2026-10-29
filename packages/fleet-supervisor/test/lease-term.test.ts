import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { bumpLeaseTerm, defaultLeaseTermPath } from "../src/lease-term.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";

/**
 * Pins lease-term: bumpLeaseTerm reads the persisted term (0 when absent or
 * unparseable), adds one, writes the new value back and returns it. Every case
 * passes an explicit path inside a private mkdtemp dir, so nothing reads or
 * writes the operator's ~/.llamactl/fleet/lease-term. No clock, sleep or network.
 */

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lease-term-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Writes `content` to <dir>/<name> and returns that path.
function seed(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function readTerm(path: string): string {
  return readFileSync(path, "utf8");
}

describe("bumpLeaseTerm", () => {
  test("an absent file in a missing nested dir returns 1, creates the dir and writes 1", () => {
    const parent = join(dir, "fleet", "nested");
    const path = join(parent, "lease-term");
    expect(existsSync(parent)).toBe(false);
    expect(bumpLeaseTerm(path)).toBe(1);
    expect(existsSync(parent)).toBe(true);
    expect(readTerm(path)).toBe("1");
  });

  test("a stored term with a trailing newline is incremented and persisted", () => {
    const path = seed("lease-term", "41\n");
    expect(bumpLeaseTerm(path)).toBe(42);
    expect(readTerm(path)).toBe("42");
  });

  test("successive calls on one path return 1, 2, 3", () => {
    const path = join(dir, "lease-term");
    const terms = [bumpLeaseTerm(path), bumpLeaseTerm(path), bumpLeaseTerm(path)];
    expect(terms).toEqual([1, 2, 3]);
    expect(readTerm(path)).toBe("3");
  });

  test("a negative stored term restarts at 1", () => {
    const path = seed("lease-term", "-3");
    expect(bumpLeaseTerm(path)).toBe(1);
    expect(readTerm(path)).toBe("1");
  });

  test("unparseable or empty content restarts at 1", () => {
    const rows: { name: string; content: string }[] = [
      { name: "garbage", content: "garbage" },
      { name: "empty", content: "" },
      { name: "blank", content: "  \n" },
    ];
    const paths = rows.map((row) => seed(row.name, row.content));
    expect(paths.map((path) => bumpLeaseTerm(path))).toEqual([1, 1, 1]);
    expect(paths.map((path) => readTerm(path))).toEqual(["1", "1", "1"]);
  });

  test("a leading integer followed by junk is read leniently (parseInt)", () => {
    const path = seed("lease-term", "7abc");
    expect(bumpLeaseTerm(path)).toBe(8);
    expect(readTerm(path)).toBe("8");
  });

  test("surrounding whitespace is trimmed before parsing", () => {
    const path = seed("lease-term", "  9  \n");
    expect(bumpLeaseTerm(path)).toBe(10);
    expect(readTerm(path)).toBe("10");
  });
});

describe("defaultLeaseTermPath", () => {
  test("is ~/.llamactl/fleet/lease-term under the current home dir", () => {
    expect(defaultLeaseTermPath()).toBe(join(homedir(), ".llamactl", "fleet", "lease-term"));
  });
});
