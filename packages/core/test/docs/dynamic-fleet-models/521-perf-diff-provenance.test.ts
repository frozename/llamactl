import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { existsSync } from "../../../src/safe-fs.js";
import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

describe("#521 provenance in a perf diff", () => {
  const diffSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/diff.ts"));
  const typesSrc = readOrEmpty(join(REPO, "packages/eval/src/matrix/types.ts"));
  const sec = flat(sectionBody(/^### Provenance in a perf diff/) ?? "");

  const FIELDS = [
    "engine",
    "engine_version",
    "engine_commit",
    "binary_sha256",
    "gguf_sha256",
    "hf_revision",
    "quant",
    "ctx",
    "flags",
    "host",
  ];

  function fieldsFromSrc(): string[] {
    const match = /export const PERF_PROVENANCE_DIFF_FIELDS = \[([^\]]*)\]/.exec(diffSrc);
    const body = match?.[1];
    if (body === undefined) return [];
    return [...body.matchAll(/"([a-z_0-9]+)"/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
  }

  // Kills: provenance renamed or reordered without a doc update; provenance
  // counted in the exit code.
  test("source pins", () => {
    expect(fieldsFromSrc()).toEqual(FIELDS);
    expect(enclosingBody(diffSrc, "export function diffPerfProvenance(")).toContain(
      '"not recorded"',
    );
    expect(enclosingBody(diffSrc, "export function renderPerfDiffMd(")).toContain(
      '"| Provenance | Baseline | Candidate | Verdict |"',
    );
    expect(diffSrc).toContain('"(none)"');
    expect(enclosingBody(diffSrc, "export function perfDiffMain(")).toContain(
      'return diffs.some((d) => d.verdict === "regressed") ? 3 : 0;',
    );
  });

  // Kills: the subsection inserted in the wrong place or at the wrong level.
  test("placement", () => {
    const lines = doc.split("\n");
    const cmpIdx = lines.indexOf("### Comparing perf runs for an arm");
    const loadIdx = lines.indexOf("### Load and prefill metrics for an arm");
    const provIdx = lines.indexOf("### Provenance in a perf diff");
    expect(cmpIdx).toBeGreaterThanOrEqual(0);
    expect(loadIdx).toBeGreaterThan(cmpIdx);
    expect(provIdx).toBeGreaterThan(cmpIdx);
    expect(provIdx).toBeLessThan(loadIdx);
    expect(lines.slice(cmpIdx + 1, loadIdx).some((line) => line.startsWith("## "))).toBe(false);
  });

  // Kills: the doc listing fields in a different order than the diff.
  test("doc field order matches the diff field order", () => {
    const fields = fieldsFromSrc();
    expect(fields).toHaveLength(10);
    const positions = fields.map((name) => ({ name, pos: sec.indexOf(`\`${name}\``) }));
    for (const [index, entry] of positions.entries()) {
      expect(entry.pos, entry.name).toBeGreaterThanOrEqual(0);
      const prev = positions[index - 1];
      if (prev !== undefined) {
        expect(entry.pos, entry.name).toBeGreaterThan(prev.pos);
      }
    }
  });

  // Kills: doc strings that drift from the code strings.
  test("contract needles", () => {
    for (const needle of [
      "`| Provenance | Baseline | Candidate | Verdict |`",
      "`same`",
      "`differs`",
      "`unavailable`",
      "`not recorded`",
      "`(none)`",
      "`diffPerfProvenance`",
      "`PERF_PROVENANCE_DIFF_FIELDS`",
    ]) {
      expect(sec, needle).toContain(needle);
      expect(diffSrc, needle).toContain(needle.slice(1, -1));
    }
    for (const needle of ["never changes the exit code", "exits 0"]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: a doc string that drifts from the code string.
  test("every backticked token resolves to code, a field, or a real file", () => {
    expect(sec.length).toBeGreaterThan(0);
    const fields = fieldsFromSrc();
    for (const match of sec.matchAll(/`([^`]+)`/g)) {
      const token = match[1] ?? "";
      const resolves =
        fields.includes(token) ||
        diffSrc.includes(token) ||
        typesSrc.includes(token) ||
        (token.startsWith("packages/") && token.endsWith(".ts") && existsSync(join(REPO, token)));
      expect(resolves, token).toBe(true);
    }
    expect(/\.ts:\d/.test(sec)).toBe(false);
  });
});
