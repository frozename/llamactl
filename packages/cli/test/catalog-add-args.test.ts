// Part of #522: `catalog add` argv parsing. The token after `--meta` is
// the meta value and is never a positional. Each case names the mutation
// it guards:
// - M1 "meta value also pushed as positional" (the ship-time bug: the
//   metaValue branch pushes `arg` into positionals as well as meta);
// - M2 "missing --meta value accepted" (the trailing metaValue check
//   after the loop is dropped);
// - M3 "`--` wins over a pending --meta" (the `--` check runs before the
//   metaValue branch).
import { describe, expect, test } from "bun:test";

import { parseAddArgs } from "../src/commands/catalog.js";

const REPO = "unsloth/Meta-E2E-GGUF";
const FILE = "meta-e2e-Q4.gguf";
const REL = "Meta-E2E-GGUF/meta-e2e-Q4.gguf";
const META = JSON.stringify({ qualification: { stage: "experimental" } });

describe("parseAddArgs (#522)", () => {
  test("M1: `<rel> --meta <json>` yields exactly one positional and the meta", () => {
    const parsed = parseAddArgs([REL, "--meta", META]);
    expect(parsed).toEqual({ kind: "ok", positionals: [REL], meta: META });
    if (parsed.kind !== "ok") return;
    expect(JSON.parse(parsed.meta ?? "")).toEqual({ qualification: { stage: "experimental" } });
  });

  test("M1: --meta in the middle does not shift later positionals", () => {
    const parsed = parseAddArgs([REPO, FILE, "--meta", META, "Label", "custom", "general"]);
    expect(parsed).toEqual({
      kind: "ok",
      positionals: [REPO, FILE, "Label", "custom", "general"],
      meta: META,
    });
  });

  test("M1: --meta at the end adds no positional", () => {
    const six = [REPO, FILE, "Label", "custom", "general", "candidate"];
    const parsed = parseAddArgs([...six, "--meta", META]);
    expect(parsed).toEqual({ kind: "ok", positionals: six, meta: META });
  });

  test("M2: a missing --meta value is refused with a clear error", () => {
    expect(parseAddArgs([REPO, FILE, "--meta"])).toEqual({
      kind: "error",
      message: "catalog add: --meta requires a JSON value\n",
    });
    expect(parseAddArgs([REL, "--meta"])).toEqual({
      kind: "error",
      message: "catalog add: --meta requires a JSON value\n",
    });
  });

  test("M3: --meta consumes a following `--` as its value", () => {
    expect(parseAddArgs([REPO, FILE, "--meta", "--", "Label"])).toEqual({
      kind: "ok",
      positionals: [REPO, FILE, "Label"],
      meta: "--",
    });
  });

  test("unchanged: --meta=, --, --help and unknown flags", () => {
    expect(parseAddArgs([REPO, FILE, `--meta=${META}`])).toEqual({
      kind: "ok",
      positionals: [REPO, FILE],
      meta: META,
    });
    expect(parseAddArgs([REPO, FILE, "--meta="])).toEqual({
      kind: "error",
      message: "catalog add: --meta requires a JSON value\n",
    });
    expect(parseAddArgs([REPO, FILE, "--", "--x", "--meta", META])).toEqual({
      kind: "ok",
      positionals: [REPO, FILE, "--x", "--meta", META],
      meta: undefined,
    });
    expect(parseAddArgs([REPO, "--help"])).toEqual({ kind: "help" });
    expect(parseAddArgs([REPO, FILE, "--bogus"])).toEqual({
      kind: "error",
      message: "catalog add: unknown flag --bogus\n",
    });
  });
});
