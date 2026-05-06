import promptsRaw from '../fixtures/prompts-context.json' with { type: 'json' };
import haystackBase from '../fixtures/haystack-base.txt' with { type: 'text' };
import { buildCompletionRequest, completeChat } from '../client.js';
import { killServer, spawnServer, waitForHealth } from '../server.js';

// Simpler v1: pin ctx-size to 17408 for the whole sub-bench so all depths use
// the same server and the comparison stays model-to-model instead of config-to-config.

export interface ContextRetrievalFixture {
  name: string;
  depth: number;
  position: number;
  needle: string;
  question: string;
  answer_substring: string;
}

export interface ContextRetrievalRow extends ContextRetrievalFixture {
  found: boolean;
}

export interface ContextRetrievalResult {
  rows: ContextRetrievalRow[];
  context_4096_score: number;
  context_8192_score: number;
  context_16384_score: number;
}

function tokens(text: string): string[] {
  return text.trim().match(/[A-Za-z0-9']+|[^\sA-Za-z0-9']/g) ?? [];
}

function detokenize(parts: string[]): string {
  return parts.join(' ').replace(/\s+([,.;:!?])/g, '$1');
}

function buildHaystack(base: string, needle: string, depth: number, position: number): string {
  const baseTokens = tokens(base);
  const needleTokens = tokens(needle);
  const targetTokens = Math.max(depth, needleTokens.length + 4);
  const insertAt = Math.min(targetTokens - needleTokens.length, Math.max(0, Math.floor(targetTokens * position)));
  const out: string[] = [];
  while (out.length < insertAt) out.push(...baseTokens);
  const prefix = out.slice(0, insertAt);
  const suffix: string[] = [];
  while (prefix.length + needleTokens.length + suffix.length < targetTokens) suffix.push(...baseTokens);
  return detokenize([...prefix, ...needleTokens, ...suffix.slice(0, targetTokens - prefix.length - needleTokens.length)]);
}

export function assembleHaystack(base: string, needle: string, depth: number, position: number): string {
  return buildHaystack(base, needle, depth, position);
}

function scoreRows(rows: ContextRetrievalRow[], depth: number): number {
  const depthRows = rows.filter((row) => row.depth === depth);
  return depthRows.reduce((sum, row) => sum + Number(row.found), 0) / depthRows.length;
}

export async function runContextRetrieval(url: string): Promise<ContextRetrievalResult> {
  const rows: ContextRetrievalRow[] = [];
  for (const prompt of promptsRaw as ContextRetrievalFixture[]) {
    const haystack = assembleHaystack(haystackBase, prompt.needle, prompt.depth, prompt.position);
    const req = buildCompletionRequest({
      messages: [{ role: 'user', content: `${haystack}\n\n${prompt.question}` }],
      maxTokens: 256,
      enableThinking: false,
    });
    const { resp } = await completeChat(url, req);
    const msg = resp.choices[0]?.message;
    const answer = (msg?.content && msg.content.length > 0)
      ? msg.content
      : (msg?.reasoning_content ?? '');
    rows.push({
      ...prompt,
      found: answer.toLowerCase().includes(prompt.answer_substring.toLowerCase()),
    });
  }
  return {
    rows,
    context_4096_score: scoreRows(rows, 4096),
    context_8192_score: scoreRows(rows, 8192),
    context_16384_score: scoreRows(rows, 16384),
  };
}

export async function runContextRetrievalWithServer(binary: string, modelPath: string, port: number): Promise<ContextRetrievalResult> {
  const server = await spawnServer(binary, { modelPath, port, ub: 512, ctxSize: 17408 }, `/tmp/context-retrieval-${port}.log`);
  try {
    await waitForHealth(server.url, server.proc);
    return await runContextRetrieval(server.url);
  } finally {
    await killServer(server);
  }
}
