import { describe, expect, test } from "bun:test";

import { num } from "../src/commands/supervisor.js";

describe("supervisor numeric flags", () => {
  test("honors zero and falls back only for missing or unparseable values", () => {
    expect(num("0", "", 512)).toBe(0);
    expect(num(undefined, "", 512)).toBe(512);
    expect(num("abc", "", 512)).toBe(512);
  });
});
