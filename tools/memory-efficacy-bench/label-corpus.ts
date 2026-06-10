#!/usr/bin/env bun
// Generate gold labels for the memory-efficacy bench corpus.
//
// Dispatches each batch through penumbra's chain_start route to a strong
// agent (default: codex-acp-spark) using the exact classifier rubric from
// /Volumes/WorkSSD/repos/personal/penumbra/packages/core/src/services/
// memory-efficacy-classifier.ts. Within each batch we use simple integer
// indices (1..N) instead of the 32-hex findingIds because LLMs reliably
// drop or mangle long opaque IDs; the script maps integers back to real
// findingIds in the output JSON. The production classifier still tests
// Granite with the real findingId format.

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const CORPUS = process.argv[2] ?? "./tools/memory-efficacy-bench/corpus/findings.json";
const OUT = process.argv[3] ?? "./tools/memory-efficacy-bench/corpus/gold-labels.json";
const AGENT = process.env.LABELER_AGENT ?? "codex-acp-spark";
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 10);
const RESUME = process.env.RESUME === "1";

const VALID = ["missed_registration", "recall_miss", "memory_ignored", "not_memory_related"];

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
  classification: string;
  reason: string;
  labelerAgent: string;
  batchNum: number;
  raw_response: string;
}

function buildPrompt(batch: CorpusRow[]): string {
  const lines = batch.map((f, i) => `${i + 1}. ${f.severity ? `[${f.severity}] ` : ""}${f.text}`);
  return `Classify each finding below into one of these memory-failure buckets:

- missed_registration: the issue would have been prevented if a memory had been written but never was (no prior memory addressed this).
- recall_miss: a relevant memory existed but was not recalled at dispatch time (autoRecallForDispatch returned 0 hits, but a t2 row covers the same concept).
- memory_ignored: a relevant memory was recalled AND injected into the dispatch prompt, but the implementer disregarded it.
- not_memory_related: the finding is not related to memory efficacy.

Return JSON only — no markdown, no preamble. The findingId field MUST equal the integer index (1, 2, ...) of the finding in the list below. Include every finding; do not skip any. Schema: [{"findingId": "<integer-as-string>", "classification": "<one of the four>", "reason": "<short>"}]

Findings:
${lines.join("\n")}`;
}

function extractJsonArray(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

async function dispatchBatch(prompt: string): Promise<string> {
  const port = readFileSync("/Users/acordeiro/.penumbra/port", "utf8").trim();
  const token = readFileSync("/Users/acordeiro/.penumbra/token", "utf8").trim();
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };

  const startResp = await fetch(`${base}/chains/start`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      initial_agent: AGENT,
      message: prompt,
      task_type: "unknown",
      use_worktree: false,
      trust_mode: "all",
    }),
  });
  if (!startResp.ok) {
    throw new Error(`chain_start failed: ${startResp.status} ${await startResp.text()}`);
  }
  const startBody = (await startResp.json()) as { conversation_id: string };
  const cid = startBody.conversation_id;

  // Poll /chains/responses?conversation_id=cid&which=final until we get text
  // or the timeout fires. Spark batches typically complete in 5–15s.
  const deadline = Date.now() + 180_000;
  let last = "";
  while (Date.now() < deadline) {
    const respResp = await fetch(
      `${base}/chains/responses?conversation_id=${encodeURIComponent(cid)}&which=final`,
      { headers },
    );
    if (respResp.ok) {
      const data = (await respResp.json()) as { responses?: Array<{ text: string }> };
      const text = data.responses?.[0]?.text ?? "";
      if (text.length > 0) return text;
      last = `responses ok, no text yet`;
    } else {
      last = `responses ${respResp.status}`;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`dispatch timeout (cid=${cid}); last=${last}`);
}

async function main() {
  const corpus: CorpusRow[] = JSON.parse(readFileSync(CORPUS, "utf8"));

  const labels: GoldLabel[] = [];
  const labeled = new Set<string>();
  if (RESUME && existsSync(OUT)) {
    const prior: GoldLabel[] = JSON.parse(readFileSync(OUT, "utf8"));
    labels.push(...prior);
    for (const l of prior) labeled.add(l.findingId);
    console.log(`resume: loaded ${prior.length} prior labels`);
  }

  const remaining = corpus.filter((c) => !labeled.has(c.findingId));
  console.log(`corpus: ${corpus.length} findings, remaining: ${remaining.length}`);

  const startTs = Date.now();
  let batchNum = 0;
  for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
    batchNum += 1;
    const batch = remaining.slice(i, i + BATCH_SIZE);
    const prompt = buildPrompt(batch);

    const batchStart = Date.now();
    let raw = "";
    try {
      raw = await dispatchBatch(prompt);
    } catch (err) {
      console.error(`batch ${batchNum} dispatch failed:`, err);
      continue;
    }
    const wall = Date.now() - batchStart;

    let parsed: Array<{ findingId: string; classification: string; reason: string }>;
    try {
      parsed = JSON.parse(extractJsonArray(raw));
    } catch {
      console.warn(`batch ${batchNum} JSON parse failed, raw=${raw.slice(0, 200)}...`);
      continue;
    }

    let okCount = 0;
    for (const entry of parsed) {
      const idx = Number(entry.findingId);
      if (!Number.isFinite(idx) || idx < 1 || idx > batch.length) continue;
      const row = batch[idx - 1]!;
      if (!VALID.includes(entry.classification)) continue;
      labels.push({
        findingId: row.findingId,
        classification: entry.classification,
        reason: entry.reason ?? "",
        labelerAgent: AGENT,
        batchNum,
        raw_response: raw,
      });
      okCount += 1;
    }

    console.log(
      `batch ${batchNum}/${Math.ceil(remaining.length / BATCH_SIZE)} ` +
        `wall=${(wall / 1000).toFixed(1)}s ` +
        `ok=${okCount}/${batch.length}`,
    );

    // Save after each batch — labeling is the bottleneck, don't lose progress.
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(labels, null, 2));
  }

  const totalWall = (Date.now() - startTs) / 1000;
  console.log(`done. labeled=${labels.length} total_wall=${totalWall.toFixed(1)}s`);

  const dist: Record<string, number> = {};
  for (const l of labels) dist[l.classification] = (dist[l.classification] ?? 0) + 1;
  console.log("class distribution:");
  for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(22)} ${v}`);
  }
}

main();
