import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRPCError } from '@trpc/server';

import {
  buildRagSystemMessage,
  handleRagChatCompletions,
  lastUserMessageContent,
  type ChatCompleteInput,
  type RagSearchInput,
  type RagSearchResponse,
} from '../src/server/rag-chat-endpoint.js';
import { generateToken } from '../src/server/auth.js';
import { startAgentServer, type RunningAgent } from '../src/server/serve.js';

/**
 * Tests for R1.5 — the thin server-side RAG chat endpoint. Two
 * layers of coverage:
 *
 *  1. Unit tests drive `handleRagChatCompletions` directly with a
 *     fake caller that captures ragSearch + chatComplete invocations.
 *     This is where the extension-field semantics live (topK,
 *     system_prompt_prefix, error shapes, etc.).
 *  2. A thin integration test spins up `startAgentServer` and verifies
 *     auth + header wiring end-to-end (the bearer check must fire
 *     before any JSON parsing).
 *
 * The tests avoid touching the real `appRouter.createCaller({})`
 * because that would require seeding a kubeconfig + RAG adapters,
 * which is covered separately by `router-rag.test.ts` and
 * `rag-e2e.test.ts`.
 */

type RagSearchCall = RagSearchInput;
type ChatCompleteCall = ChatCompleteInput;

interface StubOpts {
  searchResults?: Array<{
    id: string;
    content: string;
    score?: number;
    metadata?: Record<string, unknown>;
  }>;
  searchCollection?: string;
  chatResponse?: Record<string, unknown>;
  throwOnSearch?: unknown;
  throwOnChat?: unknown;
}

interface StubCaller {
  ragSearch: (input: RagSearchInput) => Promise<RagSearchResponse>;
  chatComplete: (input: ChatCompleteInput) => Promise<unknown>;
  ragCalls: RagSearchCall[];
  chatCalls: ChatCompleteCall[];
}

function makeStubCaller(opts: StubOpts = {}): StubCaller {
  const ragCalls: RagSearchCall[] = [];
  const chatCalls: ChatCompleteCall[] = [];
  const defaultChat = {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    model: 'm',
    created: 0,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'stub-answer' },
        finish_reason: 'stop',
      },
    ],
  };
  return {
    ragCalls,
    chatCalls,
    ragSearch: async (input) => {
      ragCalls.push(input);
      if (opts.throwOnSearch) throw opts.throwOnSearch;
      return {
        collection: opts.searchCollection ?? input.collection ?? 'default',
        results: (opts.searchResults ?? []).map((r) => ({
          document: {
            id: r.id,
            content: r.content,
            ...(r.metadata ? { metadata: r.metadata } : {}),
          },
          score: r.score ?? 0.5,
        })),
      };
    },
    chatComplete: async (input) => {
      chatCalls.push(input);
      if (opts.throwOnChat) throw opts.throwOnChat;
      return opts.chatResponse ?? defaultChat;
    },
  };
}

/** Helper — build a Request with JSON body + bearer header. */
function makeRequest(body: unknown, init?: { headers?: Record<string, string> }): Request {
  return new Request('https://127.0.0.1:7843/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
      ...(init?.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyRouter = {} as any;

describe('handleRagChatCompletions — rag-less passthrough with via', () => {
  test('rag absent but via present → chatComplete called with original messages, no retrieval', async () => {
    const caller = makeStubCaller();
    const res = await handleRagChatCompletions(
      makeRequest({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        via: 'sirius-gw',
      }),
      { appRouter: anyRouter, caller, log: () => {} },
    );
    expect(res.status).toBe(200);
    expect(caller.ragCalls).toHaveLength(0);
    expect(caller.chatCalls).toHaveLength(1);
    expect(caller.chatCalls[0]!.node).toBe('sirius-gw');
    const req = caller.chatCalls[0]!.request;
    expect(req.model).toBe('gpt-4o-mini');
    expect((req.messages as unknown[]).length).toBe(1);
    // No x-llamactl-rag header when rag is absent.
    expect(res.headers.get('x-llamactl-rag')).toBeNull();
    // Response body mirrors upstream verbatim.
    const body = await res.json();
    expect((body as { choices: unknown[] }).choices).toHaveLength(1);
  });

  test('max_tokens + temperature + providerOptions forwarded intact', async () => {
    const caller = makeStubCaller();
    const res = await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        via: 'gw',
        max_tokens: 128,
        temperature: 0.25,
        providerOptions: { seed: 42 },
      }),
      { appRouter: anyRouter, caller, log: () => {} },
    );
    expect(res.status).toBe(200);
    const req = caller.chatCalls[0]!.request;
    expect(req.max_tokens).toBe(128);
    expect(req.temperature).toBe(0.25);
    expect(req.providerOptions).toEqual({ seed: 42 });
  });
});

describe('handleRagChatCompletions — rag injected', () => {
  test('rag present → ragSearch called; context prepended as first system message', async () => {
    const caller = makeStubCaller({
      searchResults: [
        { id: 'd1', content: 'The magic number is 4823.' },
        { id: 'd2', content: 'Second fact about llamactl.' },
      ],
    });
    const res = await handleRagChatCompletions(
      makeRequest({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'What is the magic number?' }],
        via: 'sirius-gw',
        rag: { node: 'kb-pg' },
      }),
      { appRouter: anyRouter, caller, log: () => {} },
    );
    expect(res.status).toBe(200);
    expect(caller.ragCalls).toHaveLength(1);
    expect(caller.ragCalls[0]!.node).toBe('kb-pg');
    expect(caller.ragCalls[0]!.query).toBe('What is the magic number?');
    // Default topK = 3 when omitted.
    expect(caller.ragCalls[0]!.topK).toBe(3);

    expect(caller.chatCalls).toHaveLength(1);
    const msgs = caller.chatCalls[0]!.request.messages as Array<{ role: string; content: string }>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('[1] The magic number is 4823.');
    expect(msgs[0]!.content).toContain('[2] Second fact about llamactl.');
    expect(msgs[1]!.role).toBe('user');
    expect(msgs[1]!.content).toBe('What is the magic number?');

    // rag header surfaces the count.
    expect(res.headers.get('x-llamactl-rag')).toBe('retrieved=2');
  });

  test('rag.topK respected in ragSearch call', async () => {
    const caller = makeStubCaller({
      searchResults: [{ id: 'd1', content: 'hi' }],
    });
    await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        via: 'gw',
        rag: { node: 'kb', topK: 7 },
      }),
      { appRouter: anyRouter, caller, log: () => {} },
    );
    expect(caller.ragCalls[0]!.topK).toBe(7);
  });

  test('rag.collection forwarded to ragSearch', async () => {
    const caller = makeStubCaller({
      searchResults: [{ id: 'd1', content: 'x' }],
    });
    await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        via: 'gw',
        rag: { node: 'kb', collection: 'alt-coll' },
      }),
      { appRouter: anyRouter, caller, log: () => {} },
    );
    expect(caller.ragCalls[0]!.collection).toBe('alt-coll');
  });

  test('rag.system_prompt_prefix overrides the default', async () => {
    const caller = makeStubCaller({
      searchResults: [{ id: 'd1', content: 'context body' }],
    });
    await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        via: 'gw',
        rag: {
          node: 'kb',
          system_prompt_prefix: 'Use only the provided snippets.',
        },
      }),
      { appRouter: anyRouter, caller, log: () => {} },
    );
    const sys = (caller.chatCalls[0]!.request.messages as Array<{ content: string }>)[0]!.content;
    expect(sys.startsWith('Use only the provided snippets.')).toBe(true);
    expect(sys).toContain('Context:');
    expect(sys).toContain('[1] context body');
  });

  test('caller-supplied system message is preserved after the injected one', async () => {
    const caller = makeStubCaller({
      searchResults: [{ id: 'd1', content: 'doc text' }],
    });
    await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello' },
        ],
        via: 'gw',
        rag: { node: 'kb' },
      }),
      { appRouter: anyRouter, caller, log: () => {} },
    );
    const msgs = caller.chatCalls[0]!.request.messages as Array<{ role: string; content: string }>;
    expect(msgs).toHaveLength(3);
    // Our injected system message is first.
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('Context:');
    // Caller's system message preserved.
    expect(msgs[1]!.role).toBe('system');
    expect(msgs[1]!.content).toBe('You are a helpful assistant.');
    expect(msgs[2]!.role).toBe('user');
  });

  test('multipart user content collapses to joined text when building the retrieval query', async () => {
    const caller = makeStubCaller({
      searchResults: [{ id: 'd1', content: 'hit' }],
    });
    await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'line one' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,XYZ' } },
              { type: 'text', text: 'line two' },
            ],
          },
        ],
        via: 'gw',
        rag: { node: 'kb' },
      }),
      { appRouter: anyRouter, caller, log: () => {} },
    );
    expect(caller.ragCalls[0]!.query).toBe('line one\nline two');
  });
});

describe('handleRagChatCompletions — validation', () => {
  test('missing via (but rag present) → 400', async () => {
    const caller = makeStubCaller();
    const res = await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        rag: { node: 'kb' },
      }),
      { appRouter: anyRouter, caller, log: () => {} },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('via');
    expect(caller.ragCalls).toHaveLength(0);
    expect(caller.chatCalls).toHaveLength(0);
  });

  test('neither rag nor via → fallback invoked', async () => {
    const caller = makeStubCaller();
    let fallbackReq: Request | null = null;
    const res = await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
      }),
      {
        appRouter: anyRouter,
        caller,
        log: () => {},
        fallback: async (r) => {
          fallbackReq = r;
          return new Response(JSON.stringify({ delegated: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { delegated: boolean }).toEqual({ delegated: true });
    expect(fallbackReq).not.toBeNull();
    // The fallback received a reconstructed Request with the body intact.
    const replayed = await fallbackReq!.json();
    expect(replayed).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
    });
    expect(caller.ragCalls).toHaveLength(0);
    expect(caller.chatCalls).toHaveLength(0);
  });

  test('neither rag nor via AND no fallback configured → 400', async () => {
    const res = await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
      }),
      { appRouter: anyRouter, log: () => {} },
    );
    expect(res.status).toBe(400);
  });

  test('no user message in messages → 400', async () => {
    const caller = makeStubCaller();
    const res = await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [{ role: 'system', content: 'no user turn' }],
        via: 'gw',
        rag: { node: 'kb' },
      }),
      { appRouter: anyRouter, caller, log: () => {} },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('user');
    expect(caller.ragCalls).toHaveLength(0);
    expect(caller.chatCalls).toHaveLength(0);
  });

  test('empty messages array → 400', async () => {
    const caller = makeStubCaller();
    const res = await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [],
        via: 'gw',
      }),
      { appRouter: anyRouter, caller, log: () => {} },
    );
    expect(res.status).toBe(400);
  });

  test('malformed JSON body → 400', async () => {
    const badReq = new Request('https://127.0.0.1/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await handleRagChatCompletions(badReq, {
      appRouter: anyRouter,
      log: () => {},
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('invalid JSON');
  });

  test('rag.node missing → 400', async () => {
    const caller = makeStubCaller();
    const res = await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        via: 'gw',
        rag: { topK: 5 },
      }),
      { appRouter: anyRouter, caller, log: () => {} },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('rag.node');
  });

  test('rag.topK=0 → 400', async () => {
    const caller = makeStubCaller();
    const res = await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        via: 'gw',
        rag: { node: 'kb', topK: 0 },
      }),
      { appRouter: anyRouter, caller, log: () => {} },
    );
    expect(res.status).toBe(400);
  });

  test('missing model → 400', async () => {
    const caller = makeStubCaller();
    const res = await handleRagChatCompletions(
      makeRequest({
        messages: [{ role: 'user', content: 'q' }],
        via: 'gw',
      }),
      { appRouter: anyRouter, caller, log: () => {} },
    );
    expect(res.status).toBe(400);
  });
});

describe('handleRagChatCompletions — error propagation', () => {
  test('ragSearch throws → 502 with rag_error type', async () => {
    const caller = makeStubCaller({ throwOnSearch: new Error('adapter down') });
    const res = await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        via: 'gw',
        rag: { node: 'kb' },
      }),
      { appRouter: anyRouter, caller, log: () => {} },
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe('rag_error');
    expect(body.error.message).toContain('retrieval failed');
    expect(body.error.message).toContain('adapter down');
    // chatComplete must NOT have been called — retrieval is a hard gate.
    expect(caller.chatCalls).toHaveLength(0);
  });

  test('chatComplete throws a TRPCError → status derives from TRPC code + body preserved', async () => {
    const caller = makeStubCaller({
      searchResults: [{ id: 'd1', content: 'x' }],
      throwOnChat: new TRPCError({ code: 'BAD_REQUEST', message: 'bad model' }),
    });
    const res = await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        via: 'gw',
        rag: { node: 'kb' },
      }),
      { appRouter: anyRouter, caller, log: () => {} },
    );
    // BAD_REQUEST → 400.
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; type: string; code?: string };
    };
    expect(body.error.message).toContain('bad model');
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  test('chatComplete throws an ordinary Error → 502 upstream_error', async () => {
    const caller = makeStubCaller({
      throwOnChat: new Error('socket hang up'),
    });
    const res = await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        via: 'gw',
      }),
      { appRouter: anyRouter, caller, log: () => {} },
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('upstream_error');
    expect(body.error.message).toContain('socket hang up');
  });
});

describe('handleRagChatCompletions — logging hygiene', () => {
  test('retrieval-ok log carries node/topK/received/elapsed_ms but NOT the retrieved text', async () => {
    const caller = makeStubCaller({
      searchResults: [
        { id: 'd1', content: 'SECRET-PII-MARKER-9001' },
      ],
    });
    const lines: string[] = [];
    await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        via: 'gw',
        rag: { node: 'kb', topK: 1 },
      }),
      { appRouter: anyRouter, caller, log: (l) => lines.push(l) },
    );
    const joined = lines.join('\n');
    expect(joined).toContain('rag_chat_retrieval_ok');
    expect(joined).toContain('"node":"kb"');
    expect(joined).toContain('"topK":1');
    expect(joined).toContain('"received":1');
    expect(joined).toMatch(/"elapsed_ms":\d+/);
    // Never log the retrieved content.
    expect(joined).not.toContain('SECRET-PII-MARKER-9001');
  });

  test('retrieval-error log also omits retrieved text (there is none) but captures the error', async () => {
    const caller = makeStubCaller({ throwOnSearch: new Error('boom') });
    const lines: string[] = [];
    await handleRagChatCompletions(
      makeRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        via: 'gw',
        rag: { node: 'kb' },
      }),
      { appRouter: anyRouter, caller, log: (l) => lines.push(l) },
    );
    expect(lines.some((l) => l.includes('rag_chat_retrieval_error'))).toBe(true);
  });
});

// ---- helper unit tests ------------------------------------------------

describe('lastUserMessageContent', () => {
  test('returns content of the last user message (string)', () => {
    expect(
      lastUserMessageContent([
        { role: 'system', content: 's' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'last' },
      ]),
    ).toBe('last');
  });
  test('collapses multipart text parts joined with newline', () => {
    expect(
      lastUserMessageContent([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'image_url', image_url: { url: 'x' } },
            { type: 'text', text: 'b' },
          ],
        },
      ]),
    ).toBe('a\nb');
  });
  test('returns null when no user message', () => {
    expect(
      lastUserMessageContent([
        { role: 'system', content: 's' },
        { role: 'assistant', content: 'a' },
      ]),
    ).toBeNull();
  });
});

describe('buildRagSystemMessage', () => {
  test('joins indexed blocks under Context: heading', () => {
    const m = buildRagSystemMessage(
      [
        { document: { id: 'a', content: 'foo' }, score: 1 },
        { document: { id: 'b', content: 'bar' }, score: 0.5 },
      ],
      'Answer from context.',
    );
    expect(m).toBe('Answer from context.\n\nContext:\n[1] foo\n[2] bar');
  });
});

// ---- integration test via startAgentServer ---------------------------

describe('startAgentServer — /v1/chat/completions route wiring', () => {
  let dir: string;
  let server: RunningAgent | null = null;
  const { token, hash } = generateToken();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'llamactl-rag-chat-serve-'));
    server = startAgentServer({ tokenHash: hash });
  });
  afterEach(async () => {
    await server?.stop();
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  test('missing bearer → 401 (auth check fires before body parse)', async () => {
    const res = await fetch(`${server!.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        via: 'gw',
      }),
    });
    expect(res.status).toBe(401);
  });

  test('bad bearer → 401', async () => {
    const res = await fetch(`${server!.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong',
      },
      body: JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        via: 'gw',
      }),
    });
    expect(res.status).toBe(401);
  });

  test('good bearer + malformed body → 400', async () => {
    const res = await fetch(`${server!.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  test('good bearer + rag body but missing via → 400', async () => {
    const res = await fetch(`${server!.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        rag: { node: 'kb' },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message.toLowerCase()).toContain('via');
  });
});
