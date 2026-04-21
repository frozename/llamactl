import { describe, expect, test } from 'bun:test';

import {
  chunkMarkdown,
  markdownChunkTransform,
} from '../src/rag/pipeline/transforms/markdown-chunk.js';
import type { RawDoc } from '../src/rag/pipeline/types.js';

async function collect(
  inputs: RawDoc[],
  spec: unknown,
): Promise<RawDoc[]> {
  async function* source() {
    for (const d of inputs) yield d;
  }
  const out: RawDoc[] = [];
  for await (const d of markdownChunkTransform.transform(source(), spec)) {
    out.push(d);
  }
  return out;
}

const sampleDoc: RawDoc = {
  id: 'docs/api.md',
  content: [
    '# API Reference',
    '',
    'Intro paragraph one describing the API surface in enough detail to matter.',
    '',
    '## Authentication',
    '',
    'Auth paragraph explaining tokens, headers, and scopes.',
    '',
    '### Bearer Tokens',
    '',
    'The Bearer scheme uses the Authorization header with a Bearer prefix.',
    '',
    'A second paragraph about token lifetime and rotation for Bearer tokens.',
    '',
    '## Rate Limits',
    '',
    'Rate limit paragraph describing the buckets and how they work.',
  ].join('\n'),
  metadata: { source_kind: 'filesystem', path: 'docs/api.md' },
};

describe('markdownChunkTransform', () => {
  test('emits chunks with heading_path metadata', async () => {
    const chunks = await collect([sampleDoc], {
      kind: 'markdown-chunk',
      chunk_size: 200,
      overlap: 40,
      preserve_headings: true,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(Array.isArray(c.metadata.heading_path)).toBe(true);
      expect(typeof c.metadata.chunk_n).toBe('number');
      expect(typeof c.metadata.total_chunks).toBe('number');
    }
    // The Bearer section's chunks should carry its full heading chain.
    const bearer = chunks.find((c) =>
      (c.metadata.heading_path as string[]).some((h) => h === 'Bearer Tokens'),
    );
    expect(bearer).toBeDefined();
    expect(bearer!.metadata.heading_path).toEqual([
      'API Reference',
      'Authentication',
      'Bearer Tokens',
    ]);
  });

  test('ids are suffixed with #<chunkN>', async () => {
    const chunks = await collect([sampleDoc], {
      kind: 'markdown-chunk',
      chunk_size: 200,
      overlap: 40,
      preserve_headings: true,
    });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.id).toContain(`#${i}`);
    }
  });

  test('preserve_headings: false omits the heading prefix line', async () => {
    const chunks = await collect([sampleDoc], {
      kind: 'markdown-chunk',
      chunk_size: 200,
      overlap: 40,
      preserve_headings: false,
    });
    // No chunk should start with the `#` prefix construction.
    const hasPrefix = chunks.some((c) => /^#\s/.test(c.content));
    expect(hasPrefix).toBe(false);
  });

  test('chunks respect chunk_size within one paragraph-rounding window', async () => {
    const chunks = chunkMarkdown(sampleDoc, {
      chunk_size: 150,
      overlap: 30,
      preserve_headings: false,
    });
    // Each paragraph is < 150 chars, so each chunk's length must be
    // <= chunk_size + longest-paragraph-boundary rounding. We use
    // 2x the chunk_size as a generous bound — the intent is to
    // reject unbounded growth, not to pin the boundary precisely.
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(150 * 2);
    }
  });

  test('overlap carries tail characters across chunks', async () => {
    const doc: RawDoc = {
      id: 'overlap.md',
      content: [
        'Paragraph A describes topic alpha with enough words to fill one chunk by itself.',
        '',
        'Paragraph B continues with topic beta and gives the overlap logic something to test.',
        '',
        'Paragraph C closes the section with topic gamma.',
      ].join('\n'),
      metadata: {},
    };
    const chunks = chunkMarkdown(doc, {
      chunk_size: 90,
      overlap: 30,
      preserve_headings: false,
    });
    expect(chunks.length).toBeGreaterThan(1);
    // Second chunk should contain a slice of the first chunk's tail.
    const first = chunks[0]!.content;
    const second = chunks[1]!.content;
    const tail = first.slice(first.length - 30);
    expect(second.includes(tail.slice(0, 10))).toBe(true);
  });

  test('chunkMarkdown on an empty doc returns zero chunks', async () => {
    const chunks = chunkMarkdown(
      { id: 'empty.md', content: '', metadata: {} },
      { chunk_size: 100, overlap: 10, preserve_headings: true },
    );
    expect(chunks).toEqual([]);
  });
});
