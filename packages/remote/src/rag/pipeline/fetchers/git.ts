/**
 * Git source fetcher. Shallow-clones the declared repo into a tmpdir,
 * walks the resulting tree (reusing the filesystem fetcher's scanner
 * + binary heuristic), and removes the checkout when the source
 * completes or aborts. No persistent state — every run is a fresh
 * clone, so the runtime's journal-based dedupe is the only source of
 * "have I seen this before" truth.
 *
 * Shell out to `git` directly via Bun.spawn — no new dependency.
 * Auth uses the same env:/keychain:/file: token-ref grammar as the
 * http source, injected as a `https://x-access-token:<token>@host/
 * path` URL rewrite. That works for GitHub, GitLab, and Gitea; SSH
 * URLs (`git@host:org/repo.git`) bypass the injection because their
 * auth is per-user SSH config, not a token.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';

import type { Fetcher, FetcherContext } from '../types.js';
import { GitSourceSpecSchema } from '../schema.js';
import { looksBinary } from './filesystem.js';
import { resolveSecret } from '../../../config/secret.js';

export const gitFetcher: Fetcher = {
  kind: 'git',
  async *fetch(ctx) {
    const spec = GitSourceSpecSchema.parse(ctx.spec);
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-rag-git-'));
    try {
      const cloneUrl = resolveCloneUrl(spec, ctx);
      const cloneArgs = ['clone', '--depth=1', '--quiet'];
      if (spec.ref) cloneArgs.push('--branch', spec.ref);
      cloneArgs.push(cloneUrl, tmp);
      const cloneResult = await runGit(cloneArgs, { cwd: process.cwd() });
      if (!cloneResult.ok) {
        ctx.log({
          level: 'error',
          msg: `git clone failed: ${cloneResult.stderr.trim()}`,
          data: { repo: spec.repo, ref: spec.ref },
        });
        return;
      }

      const root = spec.subpath ? resolve(tmp, spec.subpath) : tmp;
      for await (const absPath of scanFiles(root, spec.glob)) {
        if (ctx.signal.aborted) return;
        let content: string;
        try {
          const buf = await readFile(absPath);
          if (looksBinary(buf)) {
            ctx.log({ level: 'warn', msg: `skipping binary file: ${absPath}` });
            continue;
          }
          content = buf.toString('utf8');
        } catch (err) {
          ctx.log({
            level: 'warn',
            msg: `unreadable file: ${absPath}`,
            data: { error: (err as Error).message },
          });
          continue;
        }
        const rel = relative(root, absPath);
        yield {
          id: rel || absPath,
          content,
          metadata: {
            source_kind: 'git',
            repo: spec.repo,
            path: rel || absPath,
            ...(spec.ref !== undefined ? { ref: spec.ref } : {}),
            ...(spec.subpath !== undefined ? { subpath: spec.subpath } : {}),
            ...(spec.tag ?? {}),
          },
        };
      }
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // Tmpdir cleanup failure is non-fatal — OS will GC /tmp
        // eventually. We prefer to keep the run successful.
      }
    }
  },
};

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

async function runGit(args: string[], opts: { cwd: string }): Promise<GitResult> {
  // Prefer Bun.spawn; fall back to node:child_process for non-Bun
  // test runs. Most llamactl test runs use Bun, but keep both paths
  // compiling for portability.
  const BunGlobal = (
    globalThis as { Bun?: { spawn: typeof Bun.spawn } }
  ).Bun;
  if (BunGlobal?.spawn) {
    const proc = BunGlobal.spawn(['git', ...args], {
      cwd: opts.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, stdout, stderr, code };
  }
  // Fallback for plain Node.
  const { spawn } = await import('node:child_process');
  return new Promise<GitResult>((resolvePromise) => {
    const child = spawn('git', args, { cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    child.on('close', (code) => {
      resolvePromise({ ok: code === 0, stdout, stderr, code: code ?? 1 });
    });
  });
}

/**
 * When `auth.tokenRef` is set and the clone URL is https://, rewrite
 * the URL to embed the token as `x-access-token` basic-auth. SSH URLs
 * and local paths are returned unchanged — their auth is elsewhere.
 */
function resolveCloneUrl(
  spec: { repo: string; auth?: { tokenRef: string } },
  ctx: FetcherContext,
): string {
  if (!spec.auth?.tokenRef) return spec.repo;
  if (!spec.repo.startsWith('https://')) return spec.repo;
  let token: string;
  try {
    token = resolveSecret(spec.auth.tokenRef, ctx.env);
  } catch (err) {
    ctx.log({
      level: 'warn',
      msg: 'git source: unable to resolve tokenRef, falling back to unauth clone',
      data: { error: (err as Error).message },
    });
    return spec.repo;
  }
  const url = new URL(spec.repo);
  url.username = 'x-access-token';
  url.password = token;
  return url.toString();
}

/**
 * Local scanner — duplicated from filesystem.ts to avoid cross-
 * fetcher imports that would muddy the contract surface. Kept in
 * sync with the filesystem version; if one grows a bug, check the
 * other.
 */
async function* scanFiles(root: string, pattern: string): AsyncIterable<string> {
  const BunGlobal = (
    globalThis as { Bun?: { Glob: new (p: string) => { scan: (opts: { cwd: string; absolute?: boolean }) => AsyncIterable<string> } } }
  ).Bun;
  if (BunGlobal?.Glob) {
    const g = new BunGlobal.Glob(pattern);
    for await (const entry of g.scan({ cwd: root, absolute: true })) {
      yield entry;
    }
    return;
  }
  const { readdir } = await import('node:fs/promises');
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

function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$+{}()|[].'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
