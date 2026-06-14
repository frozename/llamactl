import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { llamactlHome } from "../src/config/env.js";

/**
 * llamactlHome is the canonical base resolver for operator state. The
 * empty-string cases are the bug the divergent `?.trim() ??` / `?? $HOME`
 * spellings had: a blank DEV_STORAGE must NOT become the literal base.
 */
describe("llamactlHome", () => {
  const home = join(homedir(), ".llamactl");

  test("uses a non-empty DEV_STORAGE verbatim", () => {
    expect(llamactlHome({ DEV_STORAGE: "/srv/llamactl" })).toBe("/srv/llamactl");
  });

  test("falls back to ~/.llamactl when DEV_STORAGE is unset", () => {
    expect(llamactlHome({})).toBe(home);
  });

  test("ignores an empty or whitespace-only DEV_STORAGE", () => {
    expect(llamactlHome({ DEV_STORAGE: "" })).toBe(home);
    expect(llamactlHome({ DEV_STORAGE: "   " })).toBe(home);
  });

  test("trims a padded DEV_STORAGE", () => {
    expect(llamactlHome({ DEV_STORAGE: "  /srv/x  " })).toBe("/srv/x");
  });
});
