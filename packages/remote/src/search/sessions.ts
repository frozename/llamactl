import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { defaultSessionsDir } from '../ops-chat/paths.js';
import { readJournal } from '../ops-chat/sessions/journal.js';
import { getSessionSummary } from '../ops-chat/sessions/list.js';
import { findTextMatches } from './text-match.js';
import type { SessionHit, MatchExcerpt } from './types.js';

export interface SearchSessionsOpts {
  query: string;
  limit: number;
  perSessionCap?: number;
  signal?: AbortSignal;
}

export async function searchSessions(opts: SearchSessionsOpts): Promise<SessionHit[]> {
  const root = defaultSessionsDir();
  if (!existsSync(root)) return [];
  if (opts.signal?.aborted) throw new Error('aborted');
  const ids = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const perCap = opts.perSessionCap ?? 5;
  const hits: SessionHit[] = [];
  for (const id of ids) {
    if (opts.signal?.aborted) throw new Error('aborted');
    let summary;
    try {
      summary = await getSessionSummary(id);
    } catch {
      continue;
    }
    const events = await readJournal(id);
    const matches: MatchExcerpt[] = [];
    let bestScore = 0;
    const goalMatches = findTextMatches({ needle: opts.query, text: summary.goal });
    for (const m of goalMatches.slice(0, perCap)) {
      matches.push({ where: 'goal', snippet: m.snippet, spans: m.spans });
      bestScore = Math.max(bestScore, m.score);
    }
    for (const e of events) {
      if (matches.length >= perCap) break;
      if (e.type === 'plan_proposed') {
        const r = findTextMatches({ needle: opts.query, text: e.reasoning });
        for (const m of r) {
          if (matches.length >= perCap) break;
          matches.push({
            where: `iteration #${e.iteration + 1} reasoning`,
            snippet: m.snippet,
            spans: m.spans,
          });
          bestScore = Math.max(bestScore, m.score);
        }
        const argsText = JSON.stringify((e.step as any).args ?? {});
        const ar = findTextMatches({ needle: opts.query, text: argsText });
        for (const m of ar) {
          if (matches.length >= perCap) break;
          matches.push({
            where: `iteration #${e.iteration + 1} args`,
            snippet: m.snippet,
            spans: m.spans,
          });
          bestScore = Math.max(bestScore, m.score);
        }
      }
    }
    if (matches.length > 0) {
      hits.push({
        sessionId: id,
        goal: summary.goal,
        status: summary.status,
        startedAt: summary.startedAt,
        matches,
        score: bestScore,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || (a.startedAt < b.startedAt ? 1 : -1));
  return hits.slice(0, opts.limit);
}
