// packages/remote/test/search-rag-node.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDefaultRagNode } from '../src/search/rag-node.js';

describe('resolveDefaultRagNode', () => {
  let tmp: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rag-node-'));
    prev = process.env.DEV_STORAGE;
    process.env.DEV_STORAGE = tmp;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DEV_STORAGE;
    else process.env.DEV_STORAGE = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('returns null when no RAG node configured', async () => {
    writeFileSync(
      join(tmp, 'config'),
      [
        'apiVersion: llamactl/v1',
        'kind: Config',
        'currentContext: local',
        'contexts:',
        '  - name: local',
        '    cluster: local',
        '    user: local',
        'clusters:',
        '  - name: local',
        '    nodes:',
        '      - name: local',
        '        kind: agent',
        '        endpoint: inproc://local',
      ].join('\n'),
      'utf8',
    );
    const out = await resolveDefaultRagNode();
    expect(out).toBeNull();
  });

  test('returns first node with kind=rag', async () => {
    writeFileSync(
      join(tmp, 'config'),
      [
        'apiVersion: llamactl/v1',
        'kind: Config',
        'currentContext: local',
        'contexts:',
        '  - name: local',
        '    cluster: local',
        '    user: local',
        'clusters:',
        '  - name: local',
        '    nodes:',
        '      - name: local',
        '        kind: agent',
        '        endpoint: inproc://local',
        '      - name: chroma-1',
        '        kind: rag',
        '        rag:',
        '          provider: chroma',
        '          endpoint: http://localhost:8000',
        '      - name: chroma-2',
        '        kind: rag',
        '        rag:',
        '          provider: chroma',
        '          endpoint: http://localhost:8001',
      ].join('\n'),
      'utf8',
    );
    const out = await resolveDefaultRagNode();
    expect(out).toBe('chroma-1');
  });
});