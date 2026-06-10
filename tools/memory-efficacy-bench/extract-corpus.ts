#!/usr/bin/env bun
// Extract findings from penumbra adversarial-review synthesis files.
//
// Mirrors `parseFindings` + `hashFinding` from
// /Volumes/WorkSSD/repos/personal/penumbra/packages/core/src/readers/memory-efficacy.ts
// so this corpus matches what the memory-efficacy job runner would see.

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const REVIEWS_DIR =
  process.env.REVIEWS_DIR ?? "/Volumes/WorkSSD/repos/personal/penumbra/.penumbra/reviews";

const OUT_PATH = process.argv[2] ?? "./tools/memory-efficacy-bench/corpus/findings.json";

interface ParsedFinding {
  text: string;
  severity: string | null;
  index: number;
}

interface CorpusRow {
  findingId: string;
  sourceReview: string;
  ts: string;
  index: number;
  severity: string | null;
  text: string;
}

function hashFinding(synthesisPath: string, index: number, text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${synthesisPath}|${index}|${text}`);
  return hasher.digest("hex").slice(0, 32);
}

// Permissive parser. The penumbra parser at packages/core/src/readers/
// memory-efficacy.ts expects "[High] " bracketed severity, but the actual
// adversarial-review synthesis format uses `**High — Title**` (em dash
// inside bold) or `**High** — Title` (em dash outside bold). That's why
// the classifier has 0 rows in the penumbra cache — parser never matched
// production output. This bench parser handles both real formats.
function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function parseSynthesis(synthesisPath: string): { ts: string; findings: ParsedFinding[] } | null {
  let content: string;
  try {
    content = readFileSync(synthesisPath, "utf8");
  } catch {
    return null;
  }

  const tsMatch = synthesisPath.match(/\/(\d{4}-\d{2}-\d{2}T\d{2}[-:]\d{2}[-:]\d{2})/);
  const ts = tsMatch
    ? tsMatch[1]!.replace(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2})[-:](\d{2})[-:](\d{2})$/,
        "$1-$2-$3T$4:$5:$6Z",
      )
    : new Date().toISOString();

  // Allow optional `**` around the heading and don't require newline immediately
  // after — many real syntheses have `**Severity-ranked findings**\n`.
  const section = content.match(
    /(?:\*\*)?severity[- ]ranked\s+findings?(?:\*\*)?\s*\n([\s\S]*?)(?=\n#{1,6}\s|\n\*\*[A-Z]|$)/i,
  );
  if (!section) return null;

  const findings: ParsedFinding[] = [];
  let index = 0;
  for (const rawLine of section[1]!.split("\n")) {
    const line = rawLine.trim();
    // Match: "1. ..." possibly followed by `**`. Capture rest as raw payload.
    const m = line.match(/^(\d+)[.)\]]\s+(.+)$/);
    if (!m) continue;

    // Extract severity if present in any of:
    //   "**High — Title**"  (em dash inside bold)
    //   "**High** — Title"  (em dash outside bold)
    //   "[High] Title"      (bracketed, penumbra's original assumption)
    const payload = m[2]!;
    let severity: string | null = null;
    let textRaw = payload;
    const sevInBold = payload.match(/^\*\*(High|Medium|Low)\s*[—–-]\s*(.+?)\*\*(.*)$/i);
    const sevAfterBold = payload.match(/^\*\*(High|Medium|Low)\*\*\s*[—–-]\s*(.+)$/i);
    const sevBracket = payload.match(/^\[(High|Medium|Low)\]\s*(.+)$/i);
    if (sevInBold) {
      severity = sevInBold[1]!;
      // Concatenate the title with any trailing text (e.g., persona attribution).
      textRaw = `${sevInBold[2]!} ${sevInBold[3] ?? ""}`.trim();
    } else if (sevAfterBold) {
      severity = sevAfterBold[1]!;
      textRaw = sevAfterBold[2]!;
    } else if (sevBracket) {
      severity = sevBracket[1]!;
      textRaw = sevBracket[2]!;
    }

    const text = stripMarkdown(textRaw).slice(0, 200);
    if (text.length === 0) continue;
    index += 1;
    findings.push({ text, severity, index });
  }
  return findings.length > 0 ? { ts, findings } : null;
}

function main() {
  const entries = readdirSync(REVIEWS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const corpus: CorpusRow[] = [];
  let dirsParsed = 0;
  let dirsSkipped = 0;
  const sevHistogram: Record<string, number> = { High: 0, Medium: 0, Low: 0, null: 0 };

  for (const entry of entries) {
    const synthesisPath = join(REVIEWS_DIR, entry, "synthesis.md");
    const parsed = parseSynthesis(synthesisPath);
    if (!parsed) {
      dirsSkipped += 1;
      continue;
    }
    dirsParsed += 1;
    for (const f of parsed.findings) {
      corpus.push({
        findingId: hashFinding(synthesisPath, f.index, f.text),
        sourceReview: entry,
        ts: parsed.ts,
        index: f.index,
        severity: f.severity,
        text: f.text,
      });
      sevHistogram[f.severity ?? "null"]! += 1;
    }
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(corpus, null, 2));

  console.log(`reviews dir: ${REVIEWS_DIR}`);
  console.log(`directories scanned: ${entries.length}`);
  console.log(`directories parsed:  ${dirsParsed}`);
  console.log(`directories skipped: ${dirsSkipped}`);
  console.log(`total findings:      ${corpus.length}`);
  console.log(`severity histogram:`);
  for (const [k, v] of Object.entries(sevHistogram)) {
    console.log(`  ${k.padEnd(8)} ${v}`);
  }
  console.log(`wrote ${OUT_PATH}`);
}

main();
