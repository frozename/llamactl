/**
 * Heading-aware markdown chunker. Splits an input doc into sections
 * at `#`/`##`/`###…` headings, then packs paragraphs inside each
 * section until `chunk_size` chars are reached. Character-level
 * overlap carries the tail of one chunk into the next so retrieval
 * across boundaries keeps enough context.
 *
 * When `preserve_headings: true` (the default), each emitted chunk
 * gets a one-line prefix showing the enclosing heading chain —
 * e.g. `# API > ## Auth > ### Tokens` — so retrieval surfaces the
 * anchor without relying on the body text naming itself.
 */
import type { RawDoc, Transform } from '../types.js';
import { MarkdownChunkTransformSchema } from '../schema.js';

interface Section {
  path: string[];
  body: string;
}

export const markdownChunkTransform: Transform = {
  kind: 'markdown-chunk',
  async *transform(docs, specRaw) {
    const spec = MarkdownChunkTransformSchema.parse(specRaw);
    for await (const doc of docs) {
      const chunks = chunkMarkdown(doc, spec);
      const total = chunks.length;
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        yield {
          id: `${doc.id}#${i}`,
          content: c.content,
          metadata: {
            ...doc.metadata,
            chunk_n: i,
            total_chunks: total,
            heading_path: c.headingPath,
          },
        };
      }
    }
  },
};

export function chunkMarkdown(
  doc: RawDoc,
  spec: {
    chunk_size: number;
    overlap: number;
    preserve_headings: boolean;
  },
): Array<{ content: string; headingPath: string[] }> {
  const sections = splitByHeadings(doc.content);
  const out: Array<{ content: string; headingPath: string[] }> = [];

  for (const sec of sections) {
    const prefix = spec.preserve_headings && sec.path.length > 0
      ? formatHeadingPrefix(sec.path) + '\n\n'
      : '';
    const budget = Math.max(1, spec.chunk_size - prefix.length);
    const paragraphs = sec.body
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    // Empty sections still emit the heading anchor so short pages
    // with nothing but a title aren't silently dropped.
    if (paragraphs.length === 0) {
      if (prefix.length > 0) {
        out.push({
          content: prefix.trimEnd(),
          headingPath: sec.path,
        });
      }
      continue;
    }

    let current = '';
    for (const p of paragraphs) {
      const candidate = current.length === 0 ? p : `${current}\n\n${p}`;
      if (candidate.length <= budget || current.length === 0) {
        current = candidate;
        continue;
      }
      out.push({
        content: prefix + current,
        headingPath: sec.path,
      });
      const tail = spec.overlap > 0 && current.length > spec.overlap
        ? current.slice(current.length - spec.overlap)
        : '';
      current = tail.length > 0 ? `${tail}\n\n${p}` : p;
    }
    if (current.length > 0) {
      out.push({
        content: prefix + current,
        headingPath: sec.path,
      });
    }
  }

  // Empty doc → single empty chunk would be useless; drop to zero.
  return out;
}

/**
 * Walk the doc line-by-line. Heading lines open a new section and
 * update the active heading path (level N pops anything at ≥N).
 * Non-heading lines accrete into the current section's body.
 */
function splitByHeadings(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let pathStack: Array<{ level: number; title: string }> = [];
  let bodyLines: string[] = [];

  const flush = () => {
    const body = bodyLines.join('\n').trim();
    const path = pathStack.map((p) => p.title);
    if (body.length > 0 || path.length > 0) {
      sections.push({ path, body });
    }
    bodyLines = [];
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const level = m[1]!.length;
      const title = m[2]!.trim();
      // Emit whatever body accumulated under the previous heading
      // context before we mutate the stack.
      flush();
      while (pathStack.length > 0 && pathStack[pathStack.length - 1]!.level >= level) {
        pathStack.pop();
      }
      pathStack.push({ level, title });
      continue;
    }
    bodyLines.push(line);
  }
  flush();
  // Drop the initial empty-stack/empty-body "section" some docs open
  // with (no preface, first line is a heading).
  return sections.filter((s) => s.body.length > 0 || s.path.length > 0);
}

function formatHeadingPrefix(path: string[]): string {
  return path
    .map((title, i) => `${'#'.repeat(i + 1)} ${title}`)
    .join(' > ');
}
