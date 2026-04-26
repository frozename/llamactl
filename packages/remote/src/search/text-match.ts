// packages/remote/src/search/text-match.ts
export interface TextMatchOptions {
  needle: string;
  text: string;
  caseSensitive?: boolean;
  wordBoundary?: boolean;
  snippetChars?: number;
}

export interface TextMatch {
  snippet: string;
  spans: { start: number; end: number }[];
  score: number;
}

const DEFAULT_SNIPPET = 120;

function isWordBoundary(text: string, idx: number, len: number): boolean {
  const before = idx === 0 ? ' ' : text[idx - 1] ?? ' ';
  const after = idx + len >= text.length ? ' ' : text[idx + len] ?? ' ';
  return !/\w/.test(before) && !/\w/.test(after);
}

export function findTextMatches(opts: TextMatchOptions): TextMatch[] {
  const { needle, text } = opts;
  if (!needle || !text) return [];
  const cs = opts.caseSensitive ?? false;
  const wb = opts.wordBoundary ?? false;
  const snippetChars = opts.snippetChars ?? DEFAULT_SNIPPET;

  const haystack = cs ? text : text.toLowerCase();
  const needleSearch = cs ? needle : needle.toLowerCase();
  const len = needleSearch.length;

  const matches: TextMatch[] = [];
  let from = 0;
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needleSearch, from);
    if (idx < 0) break;
    const wbHit = isWordBoundary(haystack, idx, len);
    if (wb && !wbHit) {
      from = idx + 1;
      continue;
    }
    const half = Math.floor(snippetChars / 2);
    const sStart = Math.max(0, idx - half);
    const sEnd = Math.min(text.length, idx + len + half);
    const snippet = text.slice(sStart, sEnd);
    const spanStart = idx - sStart;
    const score = wbHit ? 1.0 : 0.6;
    matches.push({
      snippet,
      spans: [{ start: spanStart, end: spanStart + len }],
      score,
    });
    from = idx + len;
  }
  return matches;
}
