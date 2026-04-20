import { describe, expect, test } from 'bun:test';

import { tierOf } from '../src/index.js';

/**
 * Phase 5 of rag-nodes.md — severity classifier entries for the four
 * RAG MCP tools. Tier drives the healer's `--auto` gate; getting this
 * wrong means either (a) tier-3 deletes slip into auto-execution or
 * (b) tier-1 reads are blocked unnecessarily.
 *
 * Classification is suffix-based in `severity.ts`:
 *   `.search`           → tier 1 (read)
 *   `.list`             → tier 1 (read) — matches `listCollections`
 *   `.store`            → tier 2 (mutation-dry-run-safe)
 *   `.delete`           → tier 3 (destructive)
 */

describe('RAG severity tiers', () => {
  test('llamactl.rag.search classifies as tier 1 (read)', () => {
    expect(tierOf('llamactl.rag.search')).toBe(1);
  });

  test('llamactl.rag.listCollections classifies as tier 1 (read)', () => {
    expect(tierOf('llamactl.rag.listCollections')).toBe(1);
  });

  test('llamactl.rag.store classifies as tier 2 (mutation-dry-run-safe)', () => {
    expect(tierOf('llamactl.rag.store')).toBe(2);
  });

  test('llamactl.rag.delete classifies as tier 3 (destructive)', () => {
    expect(tierOf('llamactl.rag.delete')).toBe(3);
  });

  test('generic *.search suffix remains tier 1 for any namespace', () => {
    // Adding `.search` to TIER_1_SUFFIXES is a generic win — any future
    // `*.search` tool classifies as read-only.
    expect(tierOf('nova.kb.search')).toBe(1);
    expect(tierOf('custom.foo.search')).toBe(1);
  });
});
