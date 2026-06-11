import type { KnowledgeHit, MatchExcerpt } from "./types.js";

// packages/remote/src/search/knowledge.ts
import { findTextMatches } from "./text-match.js";

export interface KnowledgeEntity {
  id: string;
  title: string;
  body?: string;
}

export interface SearchKnowledgeOpts {
  query: string;
  entities: KnowledgeEntity[];
  limit: number;
  perEntityCap?: number;
}

const TITLE_BOOST = 0.4;

export function searchKnowledge(opts: SearchKnowledgeOpts): KnowledgeHit[] {
  const cap = opts.perEntityCap ?? 5;
  const hits: KnowledgeHit[] = [];
  for (const e of opts.entities) {
    const { matches, score } = matchEntity(opts.query, e, cap);
    if (matches.length > 0) {
      hits.push({ entityId: e.id, title: e.title, matches, score });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return hits.slice(0, opts.limit);
}

/**
 * Score one entity against the query: title matches first (boosted),
 * then body matches up to the per-entity cap.
 */
function matchEntity(
  query: string,
  e: KnowledgeEntity,
  cap: number,
): { matches: MatchExcerpt[]; score: number } {
  const matches: MatchExcerpt[] = [];
  let score = 0;
  const titleM = findTextMatches({ needle: query, text: e.title });
  for (const m of titleM.slice(0, cap)) {
    matches.push({ where: "title", snippet: m.snippet, spans: m.spans });
    score = Math.max(score, m.score + TITLE_BOOST);
  }
  if (e.body && matches.length < cap) {
    const bodyM = findTextMatches({ needle: query, text: e.body });
    for (const m of bodyM) {
      if (matches.length >= cap) break;
      matches.push({ where: "body", snippet: m.snippet, spans: m.spans });
      score = Math.max(score, m.score);
    }
  }
  return { matches, score };
}
