import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gitFetcher } from '../src/rag/pipeline/fetchers/git.js';
import type { RawDoc, FetcherContext } from '../src/rag/pipeline/types.js';

/**
 * The git fetcher shells out to the real `git` binary — Bun tests
 * run on dev machines where git is always available, so we build a
 * local bare repository as a fixture and clone it via `file://`.
 * No network, no auth — just proof that clone + walk + cleanup works.
 */

let tmp = '';
let repoDir = '';
let bareRepo = '';

async function run(cmd: string[], opts: { cwd?: string } = {}): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${cmd.join(' ')} exited ${code}: ${err}`);
  }
}

async function buildFixture(): Promise<void> {
  repoDir = join(tmp, 'source-repo');
  bareRepo = join(tmp, 'bare.git');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(join(repoDir, 'docs'), { recursive: true });
  writeFileSync(join(repoDir, 'README.md'), '# Sample\n\nRoot doc.\n');
  writeFileSync(join(repoDir, 'docs', 'intro.md'), '# Intro\n\nSection one.\n');
  writeFileSync(join(repoDir, 'docs', 'guide.md'), '# Guide\n\nSection two.\n');
  writeFileSync(join(repoDir, 'ignored.txt'), 'not markdown\n');
  // Init + commit.
  await run(['git', 'init', '-q', '-b', 'main', repoDir]);
  await run(['git', 'config', 'user.email', 'test@example.com'], { cwd: repoDir });
  await run(['git', 'config', 'user.name', 'test'], { cwd: repoDir });
  await run(['git', 'add', '.'], { cwd: repoDir });
  await run(['git', 'commit', '-q', '-m', 'initial'], { cwd: repoDir });
  // Clone bare so the fetcher sees a real remote-shaped URL (file://<path>).
  await run(['git', 'clone', '-q', '--bare', repoDir, bareRepo]);
}

function makeCtx(spec: unknown): FetcherContext {
  return {
    spec,
    log: () => {},
    signal: new AbortController().signal,
    env: process.env,
  };
}

async function collect(ctx: FetcherContext): Promise<RawDoc[]> {
  const out: RawDoc[] = [];
  for await (const d of gitFetcher.fetch(ctx)) out.push(d);
  return out;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-rag-git-test-'));
  await buildFixture();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('gitFetcher', () => {
  test('clones a file:// repo and yields the markdown files', async () => {
    const ctx = makeCtx({
      kind: 'git',
      repo: `file://${bareRepo}`,
      glob: '**/*.md',
    });
    const docs = await collect(ctx);
    const ids = docs.map((d) => d.id).sort();
    expect(ids).toEqual(['README.md', 'docs/guide.md', 'docs/intro.md']);
  });

  test('subpath restricts the walk', async () => {
    const ctx = makeCtx({
      kind: 'git',
      repo: `file://${bareRepo}`,
      subpath: 'docs',
      glob: '**/*.md',
    });
    const docs = await collect(ctx);
    const ids = docs.map((d) => d.id).sort();
    expect(ids).toEqual(['guide.md', 'intro.md']);
  });

  test('metadata includes source_kind + repo + ref when provided', async () => {
    const ctx = makeCtx({
      kind: 'git',
      repo: `file://${bareRepo}`,
      ref: 'main',
      tag: { team: 'platform' },
    });
    const docs = await collect(ctx);
    const readme = docs.find((d) => d.id === 'README.md')!;
    expect(readme.metadata.source_kind).toBe('git');
    expect(readme.metadata.repo).toBe(`file://${bareRepo}`);
    expect(readme.metadata.ref).toBe('main');
    expect(readme.metadata.team).toBe('platform');
  });

  test('unreachable repo emits an error event and yields nothing', async () => {
    const events: Array<{ level: string; msg: string }> = [];
    const ctx: FetcherContext = {
      spec: {
        kind: 'git',
        repo: 'file:///this/path/definitely/does/not/exist',
        glob: '**/*.md',
      },
      log: (e) => events.push({ level: e.level, msg: e.msg }),
      signal: new AbortController().signal,
      env: process.env,
    };
    const docs = await collect(ctx);
    expect(docs).toEqual([]);
    expect(events.some((e) => e.level === 'error' && /git clone failed/.test(e.msg))).toBe(true);
  });
});
