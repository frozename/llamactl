#!/usr/bin/env bun
// Run the memory-efficacy bench against an OpenAI-compatible chat endpoint.
//
// Usage:
//   bun tools/memory-efficacy-bench/run-bench.ts \
//     --url http://127.0.0.1:8090 \
//     --model granite41-8b \
//     --findings ./tools/memory-efficacy-bench/corpus/findings.json \
//     --gold     ./tools/memory-efficacy-bench/corpus/gold-labels.json \
//     --out      ./bench-results/baseline-prod.json \
//     [--max-findings 100] [--batch-size 10]
//
// The prompt format MIRRORS the production classifier at
// /Volumes/WorkSSD/repos/personal/penumbra/packages/core/src/services/memory-efficacy-classifier.ts
// using REAL findingIds (the 32-hex hashes) so this measures Granite under
// production conditions. Gold labels use simpler integer indices internally
// then map back; that's a labeler-only concession.

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

const VALID = ['missed_registration', 'recall_miss', 'memory_ignored', 'not_memory_related'] as const;
type Bucket = (typeof VALID)[number];

interface CorpusRow {
  findingId: string;
  sourceReview: string;
  ts: string;
  index: number;
  severity: string | null;
  text: string;
}

interface GoldLabel {
  findingId: string;
  classification: Bucket;
  reason: string;
}

interface PredictionEntry {
  findingId: string;
  classification: string;
  reason: string;
  raw_batch_response: string;
  batch_index: number;
}

function arg(flag: string, fallback?: string): string {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required flag: ${flag}`);
}
function optionalNumber(flag: string, fallback: number): number {
  const v = process.argv.indexOf(flag);
  if (v !== -1 && process.argv[v + 1]) return Number(process.argv[v + 1]);
  return fallback;
}
function optionalArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return undefined;
}

export function loadGrammarFile(grammarFile?: string): {
  grammar?: string;
  grammar_file?: string;
  grammar_sha256?: string;
} {
  if (!grammarFile) return {};
  const grammar = readFileSync(grammarFile, 'utf8');
  if (grammar.trim().length === 0) {
    throw new Error(`empty grammar file: ${grammarFile}`);
  }
  return {
    grammar,
    grammar_file: grammarFile,
    grammar_sha256: createHash('sha256').update(grammar).digest('hex'),
  };
}

function buildPrompt(batch: CorpusRow[]): string {
  const lines = batch.map(
    (f) => `${f.findingId}. ${f.severity ? `[${f.severity}] ` : ''}${f.text}`,
  );
  return `Classify each finding below into one of these memory-failure buckets:

- missed_registration: the issue would have been prevented if a memory had been written but never was (no prior memory addressed this).
- recall_miss: a relevant memory existed but was not recalled at dispatch time (autoRecallForDispatch returned 0 hits, but a t2 row covers the same concept).
- memory_ignored: a relevant memory was recalled AND injected into the dispatch prompt, but the implementer disregarded it.
- not_memory_related: the finding is not related to memory efficacy.

Return JSON only — no markdown, no preamble. Schema: [{"findingId": "<string>", "classification": "<one of the four>", "reason": "<short>"}]

Findings:
${lines.join('\n')}`;
}

function extractJsonArray(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('[') && t.endsWith(']')) return t;
  const s = t.indexOf('['), e = t.lastIndexOf(']');
  if (s !== -1 && e !== -1 && e > s) return t.slice(s, e + 1);
  return t;
}

export function buildChatRequestBody(model: string, prompt: string, grammar?: string): {
  model: string;
  messages: Array<{ role: 'user'; content: string }>;
  temperature: number;
  max_tokens: number;
  grammar?: string;
} {
  return {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: 2048,
    ...(grammar ? { grammar } : {}),
  };
}

export async function callChat(
  url: string,
  model: string,
  prompt: string,
  grammar?: string,
): Promise<{ text: string; wall_ms: number }> {
  const start = Date.now();
  const resp = await fetch(`${url.replace(/\/+$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildChatRequestBody(model, prompt, grammar)),
  });
  const wall_ms = Date.now() - start;
  if (!resp.ok) {
    const detail = await resp.text();
    if (resp.status === 400 && grammar && /grammar[^a-zA-Z0-9]*not supported|unsupported grammar/i.test(detail)) {
      throw new Error(
        `chat ${resp.status}: grammar not supported by server while --grammar-file is set (${detail})`,
      );
    }
    throw new Error(`chat ${resp.status}: ${detail}`);
  }
  const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  const text = data.choices?.[0]?.message?.content ?? '';
  return { text, wall_ms };
}

async function main() {
  const URL = arg('--url');
  const MODEL = arg('--model');
  const FINDINGS = arg('--findings', './tools/memory-efficacy-bench/corpus/findings.json');
  const GOLD = arg('--gold', './tools/memory-efficacy-bench/corpus/gold-labels.json');
  const OUT = arg('--out');
  const GRAMMAR_FILE = optionalArg('--grammar-file');
  const MAX = optionalNumber('--max-findings', Infinity);
  const BATCH = optionalNumber('--batch-size', 10);
  const CONCURRENCY = optionalNumber('--concurrency', 1);
  const { grammar, grammar_file, grammar_sha256 } = loadGrammarFile(GRAMMAR_FILE);

  const corpusAll: CorpusRow[] = JSON.parse(readFileSync(FINDINGS, 'utf8'));
  const goldAll: GoldLabel[] = existsSync(GOLD) ? JSON.parse(readFileSync(GOLD, 'utf8')) : [];
  const goldMap = new Map<string, GoldLabel>(goldAll.map((g) => [g.findingId, g]));

  // Only bench findings that have gold labels (you can't grade ungraded ones).
  const corpus = corpusAll.filter((c) => goldMap.has(c.findingId)).slice(0, Number.isFinite(MAX) ? MAX : undefined);

  console.log(`url=${URL} model=${MODEL}`);
  console.log(`findings (with gold): ${corpus.length} / corpus_total=${corpusAll.length} gold_total=${goldAll.length}`);
  console.log(`batch_size=${BATCH} concurrency=${CONCURRENCY}`);
  if (grammar_file) {
    console.log(`grammar_file=${grammar_file} grammar_sha256=${grammar_sha256}`);
  }

  const predictions: PredictionEntry[] = [];
  const batchWalls: number[] = [];
  let jsonOkBatches = 0;
  let schemaOkEntries = 0;
  let totalBatches = 0;
  let totalParseEntries = 0;

  // Pre-compute all batches up front. With concurrency > 1 we send WINDOW
  // batches in parallel via Promise.all, then walk them in submission order
  // for stable progress logging. The server's parallel-slot count (-np N)
  // determines whether the concurrent calls actually overlap on-device.
  const allBatches: CorpusRow[][] = [];
  for (let i = 0; i < corpus.length; i += BATCH) {
    allBatches.push(corpus.slice(i, i + BATCH));
  }

  async function dispatchOne(batch: CorpusRow[], batchIdx: number): Promise<void> {
    const prompt = buildPrompt(batch);
    let raw = '';
    let wall_ms = 0;
    try {
      const r = await callChat(URL, MODEL, prompt, grammar);
      raw = r.text;
      wall_ms = r.wall_ms;
    } catch (err) {
      console.warn(`batch ${batchIdx + 1} dispatch failed:`, err instanceof Error ? err.message : err);
      return;
    }
    batchWalls.push(wall_ms);

    let parsed: Array<{ findingId: string; classification: string; reason: string }> = [];
    let jsonOk = false;
    try {
      parsed = JSON.parse(extractJsonArray(raw));
      jsonOk = Array.isArray(parsed);
    } catch {
      jsonOk = false;
    }
    if (jsonOk) jsonOkBatches += 1;
    totalParseEntries += parsed.length;

    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const fid = String(entry.findingId ?? '');
      // Production format uses real hash findingIds, so match by hash.
      // Some models may strip/mangle hashes — fall back to position-in-batch.
      let target = batch.find((b) => b.findingId === fid);
      if (!target) {
        const idx = Number(entry.findingId);
        if (Number.isFinite(idx) && idx >= 1 && idx <= batch.length) {
          target = batch[idx - 1];
        }
      }
      if (!target) continue;
      const classification = String(entry.classification ?? '');
      if (VALID.includes(classification as Bucket)) schemaOkEntries += 1;
      predictions.push({
        findingId: target.findingId,
        classification,
        reason: String(entry.reason ?? ''),
        raw_batch_response: raw,
        batch_index: batchIdx + 1,
      });
    }
    totalBatches += 1;
  }

  const runStart = Date.now();
  for (let w = 0; w < allBatches.length; w += CONCURRENCY) {
    const window = allBatches.slice(w, w + CONCURRENCY);
    await Promise.all(window.map((b, k) => dispatchOne(b, w + k)));
    if (totalBatches % 5 === 0 || w + CONCURRENCY >= allBatches.length) {
      console.log(`progress: batches ${totalBatches}/${allBatches.length} jsonOk=${jsonOkBatches} schemaOk=${schemaOkEntries}/${predictions.length}`);
    }
  }
  const totalWall_s = (Date.now() - runStart) / 1000;

  // Score against gold.
  const predMap = new Map<string, PredictionEntry>(predictions.map((p) => [p.findingId, p]));
  let correct = 0;
  let graded = 0;
  const confusion: Record<string, Record<string, number>> = {};
  for (const b of VALID) confusion[b] = { ...Object.fromEntries(VALID.map((bb) => [bb, 0])), unknown: 0 };

  for (const g of goldAll) {
    const p = predMap.get(g.findingId);
    if (!p) continue;
    if (!VALID.includes(p.classification as Bucket)) {
      confusion[g.classification]!.unknown! += 1;
      graded += 1;
      continue;
    }
    confusion[g.classification]![p.classification]! += 1;
    graded += 1;
    if (p.classification === g.classification) correct += 1;
  }

  const perBucket: Record<string, { precision: number; recall: number; f1: number; gold_count: number; pred_count: number }> = {};
  for (const bk of VALID) {
    const tp = confusion[bk]![bk]!;
    const fn = Object.entries(confusion[bk]!).filter(([k]) => k !== bk).reduce((s, [, v]) => s + (v as number), 0);
    const fp = Object.entries(confusion).reduce((s, [gk, row]) => s + (gk !== bk ? (row[bk] ?? 0) : 0), 0);
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    perBucket[bk] = { precision, recall, f1, gold_count: tp + fn, pred_count: tp + fp };
  }

  batchWalls.sort((a, b) => a - b);
  const p50 = batchWalls[Math.floor(batchWalls.length * 0.5)] ?? 0;
  const p95 = batchWalls[Math.floor(batchWalls.length * 0.95)] ?? 0;
  const totalFindings = predictions.length;

  const result = {
    url: URL,
    model: MODEL,
    started_at: new Date(runStart).toISOString(),
    metadata: {
      grammar_file: grammar_file ?? null,
      grammar_sha256: grammar_sha256 ?? null,
    },
    total_wall_s: totalWall_s,
    batches: totalBatches,
    findings_attempted: corpus.length,
    findings_in_predictions: totalFindings,
    findings_graded: graded,
    metrics: {
      json_valid_rate: totalBatches > 0 ? jsonOkBatches / totalBatches : 0,
      schema_valid_rate: totalParseEntries > 0 ? schemaOkEntries / totalParseEntries : 0,
      bucket_accuracy: graded > 0 ? correct / graded : 0,
      findings_per_sec: totalFindings > 0 ? totalFindings / totalWall_s : 0,
      batch_p50_ms: p50,
      batch_p95_ms: p95,
    },
    per_bucket: perBucket,
    confusion,
    predictions,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(result, null, 2));

  console.log('--- summary ---');
  console.log(`total wall:       ${totalWall_s.toFixed(1)}s`);
  console.log(`batches:          ${totalBatches}`);
  console.log(`json_valid_rate:  ${(result.metrics.json_valid_rate * 100).toFixed(1)}%`);
  console.log(`schema_valid:     ${schemaOkEntries}/${totalParseEntries} (${(result.metrics.schema_valid_rate * 100).toFixed(1)}%)`);
  console.log(`bucket_accuracy:  ${correct}/${graded} (${(result.metrics.bucket_accuracy * 100).toFixed(1)}%)`);
  console.log(`findings/sec:     ${result.metrics.findings_per_sec.toFixed(2)}`);
  console.log(`batch p50/p95 ms: ${p50.toFixed(0)} / ${p95.toFixed(0)}`);
  console.log('per-bucket:');
  for (const [bk, m] of Object.entries(perBucket)) {
    console.log(`  ${bk.padEnd(22)} P=${(m.precision * 100).toFixed(0)}% R=${(m.recall * 100).toFixed(0)}% F1=${(m.f1 * 100).toFixed(0)}% (gold=${m.gold_count}, pred=${m.pred_count})`);
  }
  console.log(`wrote ${OUT}`);
}

if (import.meta.main) {
  await main();
}
