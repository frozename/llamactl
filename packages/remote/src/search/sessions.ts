import type { JournalEvent } from "../ops-chat/sessions/journal-schema.js";
import type { TextMatch } from "./text-match.js";
import type { MatchExcerpt, SessionHit } from "./types.js";

import { defaultSessionsDir } from "../ops-chat/paths.js";
import { readJournal } from "../ops-chat/sessions/journal.js";
import { getSessionSummary } from "../ops-chat/sessions/list.js";
import { readdir } from "../safe-fs-promises.js";
import { existsSync } from "../safe-fs.js";
import { findTextMatches } from "./text-match.js";

export interface SearchSessionsOpts {
  query: string;
  limit: number;
  perSessionCap?: number;
  signal?: AbortSignal;
}

interface MatchAccumulator {
  matches: MatchExcerpt[];
  bestScore: number;
}

export async function searchSessions(opts: SearchSessionsOpts): Promise<SessionHit[]> {
  const root = defaultSessionsDir();
  if (!existsSync(root)) return [];
  if (opts.signal?.aborted) throw new Error("aborted");
  const ids = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const perCap = opts.perSessionCap ?? 5;
  const hits: SessionHit[] = [];
  for (const id of ids) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const hit = await matchSession(opts.query, id, perCap);
    if (hit) hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score || (a.startedAt < b.startedAt ? 1 : -1));
  return hits.slice(0, opts.limit);
}

/**
 * Score one session against the query: goal text first, then each
 * `plan_proposed` event's reasoning + step args, all under the
 * per-session excerpt cap. Returns null when nothing matched (or the
 * summary is unreadable — skipped, same as before).
 */
async function matchSession(query: string, id: string, perCap: number): Promise<SessionHit | null> {
  let summary;
  try {
    summary = await getSessionSummary(id);
  } catch {
    return null;
  }
  const events = await readJournal(id);
  const acc: MatchAccumulator = { matches: [], bestScore: 0 };
  const goalMatches = findTextMatches({ needle: query, text: summary.goal });
  pushMatches(acc, goalMatches.slice(0, perCap), "goal", perCap);
  for (const e of events) {
    if (acc.matches.length >= perCap) break;
    if (e.type === "plan_proposed") {
      collectPlanProposedMatches(query, e, perCap, acc);
    }
  }
  if (acc.matches.length === 0) return null;
  return {
    sessionId: id,
    goal: summary.goal,
    status: summary.status,
    startedAt: summary.startedAt,
    matches: acc.matches,
    score: acc.bestScore,
  };
}

function collectPlanProposedMatches(
  query: string,
  e: Extract<JournalEvent, { type: "plan_proposed" }>,
  perCap: number,
  acc: MatchAccumulator,
): void {
  const reasoningMatches = findTextMatches({ needle: query, text: e.reasoning });
  pushMatches(acc, reasoningMatches, `iteration #${String(e.iteration + 1)} reasoning`, perCap);
  const argsText = JSON.stringify(readStepArgs(e.step));
  const argsMatches = findTextMatches({ needle: query, text: argsText });
  pushMatches(acc, argsMatches, `iteration #${String(e.iteration + 1)} args`, perCap);
}

/** Append matches until the per-session cap, tracking the best score. */
function pushMatches(
  acc: MatchAccumulator,
  found: TextMatch[],
  where: string,
  perCap: number,
): void {
  for (const m of found) {
    if (acc.matches.length >= perCap) break;
    acc.matches.push({ where, snippet: m.snippet, spans: m.spans });
    acc.bestScore = Math.max(acc.bestScore, m.score);
  }
}

function readStepArgs(step: unknown): Record<string, unknown> {
  if (!step || typeof step !== "object") return {};
  const maybe = step as { args?: unknown };
  return maybe.args && typeof maybe.args === "object"
    ? (maybe.args as Record<string, unknown>)
    : {};
}
