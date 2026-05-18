import type { WorkloadEval } from '../types.js';

interface Candidate {
  id: string;
  text: string;
}

interface CorpusRow {
  query: string;
  context?: string;
  candidates: Candidate[];
  gold_ids: string[];
}

const SYSTEM_PROMPT = `You re-rank memory candidates by relevance to a query.

You will be given a query, optional context, and a numbered list of 10 candidate memories with IDs. Your job is to return the candidate IDs in descending order of relevance to the query.

Output ONLY a JSON object with this exact shape (no preamble, no markdown):
{"ranking": ["<id1>", "<id2>", ..., "<id10>"]}

The "ranking" array MUST include every candidate ID exactly once. Most relevant first.`;

function buildUserMessage(row: CorpusRow): string {
  const ctx = row.context ? `Context: ${row.context}\n\n` : '';
  const cands = row.candidates
    .map((c, i) => `${i + 1}. [${c.id}] ${c.text}`)
    .join('\n');
  return `${ctx}Query: ${row.query}\n\nCandidates:\n${cands}\n\nReturn the ranked IDs as JSON.`;
}

function parseRanking(text: string): string[] | null {
  let s = text.trim();
  if (s.includes('@@metadata')) {
    const parts = s.split('@@metadata', 2);
    if (parts.length > 1 && parts[1] !== undefined) s = parts[1];
    if (s.includes('@@end')) {
      const head = s.split('@@end', 1)[0];
      if (head !== undefined) s = head;
    }
  }
  const fenceMatch = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch && fenceMatch[1] !== undefined) s = fenceMatch[1];
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
    const r = obj.ranking;
    if (!Array.isArray(r)) return null;
    if (!r.every((v) => typeof v === 'string')) return null;
    return r as string[];
  } catch {
    return null;
  }
}

export function ndcgAtK(ranking: string[], goldIds: string[], k = 5): number {
  if (goldIds.length === 0) return 0;
  const goldSet = new Set(goldIds);
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranking.length); i++) {
    const id = ranking[i];
    const rel = id !== undefined && goldSet.has(id) ? 1 : 0;
    dcg += rel / Math.log2(i + 2);
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(k, goldIds.length); i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg > 0 ? dcg / idcg : 0;
}

export const memoryRecallWorkload: WorkloadEval = {
  name: 'memory-recall',
  corpus_path: 'packages/eval/corpora/memory-recall/v0/seed.jsonl',
  primary_metric_name: 'mean_ndcg5',
  prompt_builder: (row) => {
    const r = row as CorpusRow;
    return {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(r) },
      ],
    };
  },
  scorer: (row, completion) => {
    const r = row as CorpusRow;
    const parsed = parseRanking(completion);
    if (!parsed) {
      return {
        prediction: '__parse_error__',
        gold: r.gold_ids.join(','),
        metrics: { ndcg5: 0, parse_error: 1 },
      };
    }
    const score = ndcgAtK(parsed, r.gold_ids, 5);
    return {
      prediction: parsed.slice(0, 5).join(','),
      gold: r.gold_ids.join(','),
      metrics: { ndcg5: score, parse_error: 0 },
    };
  },
};
