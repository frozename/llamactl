/**
 * Filesystem source fetcher. Walks a root directory with a glob
 * pattern, yields one RawDoc per text file, and skips binary files
 * via a cheap printable-char heuristic on the first 512 bytes.
 *
 * Uses `Bun.Glob` when available; falls back to a recursive walk +
 * minimal glob matcher when running under plain Node (dev-time test
 * runs on CI that haven't switched to Bun yet).
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { Fetcher } from "../types.js";

import { FilesystemSourceSpecSchema } from "../schema.js";

export const filesystemFetcher: Fetcher = {
  kind: "filesystem",
  async *fetch(ctx) {
    const spec = FilesystemSourceSpecSchema.parse(ctx.spec);
    for await (const absPath of scanFiles(spec.root, spec.glob)) {
      if (ctx.signal.aborted) return;
      let content: string;
      try {
        const buf = await readFile(absPath);
        if (looksBinary(buf)) {
          ctx.log({
            level: "warn",
            msg: `skipping binary file: ${absPath}`,
          });
          continue;
        }
        content = buf.toString("utf8");
      } catch (err) {
        ctx.log({
          level: "warn",
          msg: `unreadable file: ${absPath}`,
          data: { error: (err as Error).message },
        });
        continue;
      }
      const rel = relative(spec.root, absPath);
      yield {
        id: rel || absPath,
        content,
        metadata: {
          source_kind: "filesystem",
          path: absPath,
          ...(spec.tag ?? {}),
        },
      };
    }
  },
};

/**
 * Yield absolute paths under `root` matching `pattern`. Prefers
 * `Bun.Glob` (single-glob, fast walker). Falls back to a naive
 * recursive walk for non-Bun runtimes.
 */
async function* scanFiles(root: string, pattern: string): AsyncIterable<string> {
  const BunGlobal = (
    globalThis as {
      Bun?: {
        Glob: new (p: string) => {
          scan: (opts: { cwd: string; absolute?: boolean }) => AsyncIterable<string>;
        };
      };
    }
  ).Bun;
  if (BunGlobal?.Glob) {
    const g = new BunGlobal.Glob(pattern);
    for await (const entry of g.scan({ cwd: root, absolute: true })) {
      yield entry;
    }
    return;
  }
  yield* walkAndMatch(root, pattern);
}

async function* walkAndMatch(root: string, pattern: string): AsyncIterable<string> {
  const regex = globToRegex(pattern);
  async function* walk(dir: string): AsyncIterable<string> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        yield* walk(abs);
      } else if (e.isFile()) {
        const rel = relative(root, abs);
        if (regex.test(rel)) yield abs;
      }
    }
  }
  yield* walk(root);
}

/**
 * Tiny glob-to-regex translator covering `**`, `*`, and `?`. Kept
 * intentionally minimal — the Bun code path is the production one;
 * this fallback exists so tests that run under plain Node without
 * the Bun runtime don't fail outright.
 */
function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const { fragment, nextIndex } = translateGlobChar(glob, i);
    re += fragment;
    i = nextIndex;
  }
  // eslint-disable-next-line security/detect-non-literal-regexp -- Pattern is built by this translator from the trusted pipeline-manifest glob; every regex metacharacter is escaped.
  return new RegExp(`^${re}$`);
}

/** Translate one glob character into its regex fragment, returning
 *  the index the scan should resume from (multi-char `**` tokens
 *  consume extra input). */
function translateGlobChar(glob: string, i: number): { fragment: string; nextIndex: number } {
  const c = glob.charAt(i);
  if (c === "*") return translateStar(glob, i);
  if (c === "?") return { fragment: "[^/]", nextIndex: i };
  if ("\\^$+{}()|[].".includes(c)) return { fragment: `\\${c}`, nextIndex: i };
  return { fragment: c, nextIndex: i };
}

/** `**` (with an optional trailing `/`) swallows path separators;
 *  a single `*` stays within one segment. */
function translateStar(glob: string, i: number): { fragment: string; nextIndex: number } {
  if (glob[i + 1] !== "*") {
    return { fragment: "[^/]*", nextIndex: i };
  }
  let next = i + 1;
  if (glob[next + 1] === "/") next++;
  return { fragment: ".*", nextIndex: next };
}

/**
 * Heuristic: a buffer is "binary" if ≥10% of the first 512 bytes
 * fall outside printable ASCII + common whitespace (0x09 tab, 0x0a
 * LF, 0x0d CR). UTF-8 text with a few control bytes passes; a PNG
 * or compiled binary fails.
 */
export function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 512);
  if (limit === 0) return false;
  let nonPrintable = 0;
  for (let i = 0; i < limit; i++) {
    const b = buf[i];
    if (b === undefined) continue;
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b === 0x7f) {
      nonPrintable++;
      continue;
    }
    // 0x80-0xff — allow (UTF-8 multi-byte sequences). The loop only
    // penalizes low-ASCII control bytes.
  }
  return nonPrintable * 10 >= limit;
}
