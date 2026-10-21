import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  applyStartLine,
  defaultUpdateHistoryPath,
  formatHistoryRef,
  lastFromRef,
  okLine,
  parseHistoryRef,
  rollbackStartLine,
  rolledBackLine,
} from "../src/commands/update/history.js";

const A = "5b5bc51f0fce300bb4ab2cbe1caf8552213b9a0d";
const B = "5b91e5c0795785b30094428313ba8168f5fd60f2";

describe("defaultUpdateHistoryPath", () => {
  test("LLAMACTL_UPDATE_HISTORY wins", () => {
    expect(
      defaultUpdateHistoryPath({ LLAMACTL_UPDATE_HISTORY: " /x/h.log ", DEV_STORAGE: "/d" }),
    ).toBe("/x/h.log");
  });

  test("falls back to the llamactl state home", () => {
    expect(defaultUpdateHistoryPath({ DEV_STORAGE: "/d" })).toBe("/d/update-history.log");
    expect(defaultUpdateHistoryPath({ DEV_STORAGE: "  " })).toBe(
      join(homedir(), ".llamactl", "update-history.log"),
    );
  });
});

describe("history refs", () => {
  test("parseHistoryRef", () => {
    expect(parseHistoryRef(`feat/strata-engine@${A}`)).toEqual({
      branch: "feat/strata-engine",
      sha: A,
    });
    expect(parseHistoryRef(A)).toEqual({ branch: null, sha: A });
    expect(parseHistoryRef(`DETACHED@${A}`)).toEqual({ branch: null, sha: A });
    // The bash updater wrote `<sha>@<sha>` for a detached checkout.
    expect(parseHistoryRef(`${A}@${A}`)).toEqual({ branch: null, sha: A });
    expect(parseHistoryRef("main@5b91e5c")).toEqual({ branch: "main", sha: "5b91e5c" });
    expect(parseHistoryRef("main")).toBeNull();
    expect(parseHistoryRef("main@not-a-sha")).toBeNull();
    expect(parseHistoryRef(`@${A}`)).toBeNull();
  });

  test("formatHistoryRef round-trips", () => {
    for (const ref of [
      { branch: "feat/x", sha: A },
      { branch: null, sha: B },
    ]) {
      expect(parseHistoryRef(formatHistoryRef(ref))).toEqual(ref);
    }
  });
});

describe("lastFromRef", () => {
  test("reads the bash updater's history file", () => {
    const text = [
      `2026-10-21T17:28:23-04:00 from=feat/strata-engine@${A} to=${B}`,
      "2026-10-21T17:28:27-04:00 ok 5b91e5c",
      "",
    ].join("\n");
    expect(lastFromRef(text)).toEqual({ branch: "feat/strata-engine", sha: A });
  });

  test("a rollback entry's from= is the default target, so a second rollback undoes the first", () => {
    const text = [
      `t1 from=feat/strata-engine@${A} to=${B}`,
      "t2 ok 5b91e5c",
      `t3 rollback from=main@${B} to=feat/strata-engine@${A}`,
      "t4 ok 5b5bc51",
    ].join("\n");
    expect(lastFromRef(text)).toEqual({ branch: "main", sha: B });
  });

  test("no from= anywhere is null", () => {
    expect(lastFromRef("")).toBeNull();
    expect(lastFromRef("t ok abc1234\n")).toBeNull();
  });
});

describe("history lines", () => {
  test("format", () => {
    expect(applyStartLine("T", { branch: "feat/x", sha: A }, B)).toBe(
      `T from=feat/x@${A} to=${B}\n`,
    );
    expect(applyStartLine("T", { branch: null, sha: A }, B)).toBe(`T from=${A} to=${B}\n`);
    expect(rollbackStartLine("T", { branch: "main", sha: B }, { branch: null, sha: A })).toBe(
      `T rollback from=main@${B} to=DETACHED@${A}\n`,
    );
    expect(okLine("T", B)).toBe("T ok 5b91e5c\n");
    expect(rolledBackLine("T", { branch: "feat/x", sha: A })).toBe(
      "T rolled-back to feat/x@5b5bc51\n",
    );
  });

  test("an apply line written now is what the next rollback reads", () => {
    const text = applyStartLine("T", { branch: "feat/x", sha: A }, B) + okLine("T", B);
    expect(lastFromRef(text)).toEqual({ branch: "feat/x", sha: A });
  });
});
