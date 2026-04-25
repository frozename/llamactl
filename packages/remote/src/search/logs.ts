import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { findTextMatches } from './text-match.js';
import type { LogHit, MatchExcerpt } from './types.js';

const DEFAULT_WINDOW = 5 * 1024 * 1024;

export interface LogFileSpec {
  label: string;
  path: string;
}

export interface SearchLogsOpts {
  query: string;
  files: LogFileSpec[];
  limit: number;
  windowBytes?: number;
  perFileCap?: number;
}

function tailFile(path: string, windowBytes: number): { text: string; lineOffset: number } {
  const size = statSync(path).size;
  const start = Math.max(0, size - windowBytes);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    if (start === 0) return { text, lineOffset: 0 };
    const firstNl = text.indexOf('\n');
    if (firstNl < 0) return { text, lineOffset: 0 };
    return { text: text.slice(firstNl + 1), lineOffset: 0 };
  } finally {
    closeSync(fd);
  }
}

export async function searchLogs(opts: SearchLogsOpts): Promise<LogHit[]> {
  const window = opts.windowBytes ?? DEFAULT_WINDOW;
  const cap = opts.perFileCap ?? 10;
  const hits: LogHit[] = [];
  for (const f of opts.files) {
    if (!existsSync(f.path)) continue;
    const { text } = tailFile(f.path, window);
    const lines = text.split('\n');
    const matches: (MatchExcerpt & { lineNumber: number })[] = [];
    let score = 0;
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= cap) break;
      const lineMatches = findTextMatches({ needle: opts.query, text: lines[i]! });
      for (const m of lineMatches) {
        if (matches.length >= cap) break;
        matches.push({
          lineNumber: i + 1,
          where: `${f.label}:${i + 1}`,
          snippet: m.snippet,
          spans: m.spans,
        });
        score = Math.max(score, m.score);
      }
    }
    if (matches.length > 0) {
      hits.push({
        fileLabel: f.label,
        filePath: f.path,
        matches,
        score,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.fileLabel.localeCompare(b.fileLabel));
  return hits.slice(0, opts.limit);
}
