import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRag, __setRagTestSeams, __resetRagTestSeams } from '../src/commands/rag.js';
import { resetGlobals, setGlobals, EMPTY_GLOBALS } from '../src/dispatcher.js';
import { config as kubecfg, configSchema } from '@llamactl/remote';

/**
 * `llamactl rag ask` chains ragSearch + chatComplete. The tests stub
 * a `NodeClient` via `__setRagTestSeams` so no real adapter / provider
 * runs — we only exercise argv parsing, auto-resolution of --kb, the
 * prompt-template shape, and the rendered output paths.
 */

let tmp = '';
let configPath = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-rag-ask-'));
  configPath = join(tmp, 'config');
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: tmp,
    LLAMACTL_CONFIG: configPath,
  });
  setGlobals(EMPTY_GLOBALS);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  resetGlobals();
  __resetRagTestSeams();
});

async function capture(fn: () => Promise<number>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as any) = (chunk: unknown) => {
    stdout += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = (chunk: unknown) => {
    stderr += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

interface StubCalls {
  ragSearch: Array<{ node: string; query: string; topK: number; collection?: string }>;
  chatComplete: Array<{ node: string; request: Record<string, unknown> }>;
}

/**
 * Build a minimal fake NodeClient that captures ragSearch/chatComplete
 * calls and returns the provided canned responses. The shape mirrors
 * the real tRPC proxy (nested `.query` / `.mutate` leaves) well enough
 * for the command's consumption.
 */
function installStubClient(opts: {
  searchResults?: Array<{
    id: string;
    content: string;
    score: number;
    metadata?: Record<string, unknown>;
  }>;
  searchCollection?: string;
  answer?: string;
  throwOnSearch?: Error;
  throwOnChat?: Error;
}): StubCalls {
  const calls: StubCalls = { ragSearch: [], chatComplete: [] };
  const fake = {
    ragSearch: {
      query: async (input: {
        node: string;
        query: string;
        topK: number;
        collection?: string;
      }) => {
        calls.ragSearch.push(input);
        if (opts.throwOnSearch) throw opts.throwOnSearch;
        return {
          collection: opts.searchCollection ?? input.collection ?? 'default',
          results: (opts.searchResults ?? []).map((r) => ({
            document: {
              id: r.id,
              content: r.content,
              ...(r.metadata ? { metadata: r.metadata } : {}),
            },
            score: r.score,
          })),
        };
      },
    },
    chatComplete: {
      mutate: async (input: { node: string; request: Record<string, unknown> }) => {
        calls.chatComplete.push(input);
        if (opts.throwOnChat) throw opts.throwOnChat;
        return {
          id: 'chat-stub',
          object: 'chat.completion',
          model: input.request.model,
          created: 0,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: opts.answer ?? 'stub-answer' },
              finish_reason: 'stop',
            },
          ],
        };
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __setRagTestSeams({ nodeClient: fake as any });
  return calls;
}

/** Seed the on-disk kubeconfig with a set of rag-kind nodes so the
 *  --kb auto-resolve path has something to read. */
function seedKubeconfigWithRagNodes(names: string[]): void {
  let cfg = kubecfg.loadConfig(configPath);
  for (const n of names) {
    cfg = kubecfg.upsertNode(cfg, 'home', {
      name: n,
      endpoint: '',
      kind: 'rag',
      rag: configSchema.RagBindingSchema.parse({
        provider: 'chroma',
        endpoint: 'chroma-mcp run',
        extraArgs: [],
      }),
    });
  }
  kubecfg.saveConfig(cfg, configPath);
}

describe('rag ask — happy path', () => {
  test('retrieved passages are embedded in the user prompt and answer prints', async () => {
    const calls = installStubClient({
      searchResults: [
        { id: 'd1', content: 'The magic number is 4823.', score: 0.9 },
        { id: 'd2', content: 'Another fact about llamactl.', score: 0.5 },
      ],
      answer: '4823',
    });

    const { code, stdout, stderr } = await capture(() =>
      runRag([
        'ask',
        'What',
        'is',
        'the',
        'magic',
        'number?',
        '--kb',
        'kb-chroma',
        '--via',
        'sirius-gw',
        '--model',
        'gpt-4o-mini',
      ]),
    );
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('4823');

    // ragSearch received the question + default topK=3.
    expect(calls.ragSearch).toHaveLength(1);
    expect(calls.ragSearch[0]!.node).toBe('kb-chroma');
    expect(calls.ragSearch[0]!.query).toBe('What is the magic number?');
    expect(calls.ragSearch[0]!.topK).toBe(3);

    // chatComplete routed to --via with the --model as-is.
    expect(calls.chatComplete).toHaveLength(1);
    const chatReq = calls.chatComplete[0]!;
    expect(chatReq.node).toBe('sirius-gw');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const request = chatReq.request as any;
    expect(request.model).toBe('gpt-4o-mini');
    expect(request.max_tokens).toBe(2048);
    expect(request.temperature).toBe(0);
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0].role).toBe('system');
    expect(request.messages[1].role).toBe('user');
    // User prompt must quote the retrieved docs.
    expect(request.messages[1].content).toContain('[1] The magic number is 4823.');
    expect(request.messages[1].content).toContain('[2] Another fact about llamactl.');
    expect(request.messages[1].content).toContain('Question: What is the magic number?');
  });

  test('--top-k, --max-tokens, --temperature, --collection all pass through', async () => {
    const calls = installStubClient({ answer: 'ok' });
    const { code } = await capture(() =>
      runRag([
        'ask',
        'hello',
        '--kb',
        'kb',
        '--via',
        'gw',
        '--model',
        'm',
        '--top-k',
        '7',
        '--collection',
        'my-coll',
        '--max-tokens',
        '512',
        '--temperature',
        '0.25',
      ]),
    );
    expect(code).toBe(0);
    expect(calls.ragSearch[0]!.topK).toBe(7);
    expect(calls.ragSearch[0]!.collection).toBe('my-coll');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = calls.chatComplete[0]!.request as any;
    expect(req.max_tokens).toBe(512);
    expect(req.temperature).toBe(0.25);
  });

  test('--system-prompt overrides the default system message', async () => {
    const calls = installStubClient({ answer: 'ok' });
    const { code } = await capture(() =>
      runRag([
        'ask',
        'q',
        '--kb',
        'kb',
        '--via',
        'gw',
        '--model',
        'm',
        '--system-prompt',
        'be terse',
      ]),
    );
    expect(code).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs = (calls.chatComplete[0]!.request as any).messages;
    expect(msgs[0].content).toBe('be terse');
  });
});

describe('rag ask — --kb auto-resolution', () => {
  test('exactly one rag node → --kb is inferred', async () => {
    seedKubeconfigWithRagNodes(['kb-solo']);
    const calls = installStubClient({
      searchResults: [{ id: 'd1', content: 'solo', score: 1 }],
      answer: 'yes',
    });
    const { code, stderr } = await capture(() =>
      runRag(['ask', 'hi', '--via', 'gw', '--model', 'm']),
    );
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(calls.ragSearch[0]!.node).toBe('kb-solo');
  });

  test('zero rag nodes + no --kb → error', async () => {
    // Seed a non-rag node so the cluster exists but has no rag kind.
    let cfg = kubecfg.loadConfig(configPath);
    cfg = kubecfg.upsertNode(cfg, 'home', {
      name: 'agent-only',
      endpoint: 'https://agent.local:7843',
      certificateFingerprint: 'sha256:abcd',
    });
    kubecfg.saveConfig(cfg, configPath);
    installStubClient({});
    const { code, stderr } = await capture(() =>
      runRag(['ask', 'q', '--via', 'gw', '--model', 'm']),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('--kb is required');
    expect(stderr).toContain('no rag nodes');
  });

  test('multiple rag nodes + no --kb → error lists candidates', async () => {
    seedKubeconfigWithRagNodes(['kb-a', 'kb-b']);
    installStubClient({});
    const { code, stderr } = await capture(() =>
      runRag(['ask', 'q', '--via', 'gw', '--model', 'm']),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('multiple rag nodes');
    expect(stderr).toContain('kb-a');
    expect(stderr).toContain('kb-b');
  });
});

describe('rag ask — --cite rendering', () => {
  test('prints retrieved passages before the answer', async () => {
    installStubClient({
      searchResults: [
        { id: 'd1', content: 'First passage about llamactl.', score: 0.95 },
        { id: 'd2', content: 'Second passage about gateways.', score: 0.80 },
      ],
      searchCollection: 'docs',
      answer: 'Derived answer.',
    });
    const { code, stdout } = await capture(() =>
      runRag([
        'ask',
        'q',
        '--kb',
        'kb',
        '--via',
        'gw',
        '--model',
        'm',
        '--cite',
      ]),
    );
    expect(code).toBe(0);
    expect(stdout).toContain('Retrieved 2 passage(s) from kb:');
    expect(stdout).toContain('[1] First passage about llamactl.');
    expect(stdout).toContain('[2] Second passage about gateways.');
    // The answer lives after the citation block.
    const idxCite = stdout.indexOf('[1] First');
    const idxAnswer = stdout.indexOf('Derived answer.');
    expect(idxCite).toBeGreaterThan(-1);
    expect(idxAnswer).toBeGreaterThan(idxCite);
  });
});

describe('rag ask — --json rendering', () => {
  test('output parses, contains retrieval + answer + model + via', async () => {
    installStubClient({
      searchResults: [
        { id: 'd1', content: 'Document content.', score: 0.88 },
      ],
      searchCollection: 'docs',
      answer: 'JSON-ready answer.',
    });
    const { code, stdout } = await capture(() =>
      runRag([
        'ask',
        'q',
        '--kb',
        'kb-json',
        '--via',
        'gw',
        '--model',
        'gpt-x',
        '--json',
      ]),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.retrieval.node).toBe('kb-json');
    expect(parsed.retrieval.collection).toBe('docs');
    expect(parsed.retrieval.results).toHaveLength(1);
    expect(parsed.retrieval.results[0].document.content).toBe('Document content.');
    expect(parsed.answer).toBe('JSON-ready answer.');
    expect(parsed.model).toBe('gpt-x');
    expect(parsed.via).toBe('gw');
  });

  test('--json takes precedence over --cite', async () => {
    installStubClient({
      searchResults: [{ id: 'd1', content: 'x', score: 1 }],
      answer: 'a',
    });
    const { code, stdout } = await capture(() =>
      runRag([
        'ask',
        'q',
        '--kb',
        'kb',
        '--via',
        'gw',
        '--model',
        'm',
        '--cite',
        '--json',
      ]),
    );
    expect(code).toBe(0);
    // No human-readable "Retrieved N passage(s)" header.
    expect(stdout).not.toContain('Retrieved');
    // Pure JSON on stdout.
    JSON.parse(stdout.trim());
  });
});

describe('rag ask — validation', () => {
  test('missing --via → exit 1', async () => {
    installStubClient({});
    const { code, stderr } = await capture(() =>
      runRag(['ask', 'q', '--kb', 'kb', '--model', 'm']),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('--via is required');
  });

  test('missing --model → exit 1', async () => {
    installStubClient({});
    const { code, stderr } = await capture(() =>
      runRag(['ask', 'q', '--kb', 'kb', '--via', 'gw']),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('--model is required');
  });

  test('missing <question> → exit 1', async () => {
    installStubClient({});
    const { code, stderr } = await capture(() =>
      runRag(['ask', '--kb', 'kb', '--via', 'gw', '--model', 'm']),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('<question> is required');
  });

  test('--top-k=0 rejects before any network call', async () => {
    const calls = installStubClient({});
    const { code, stderr } = await capture(() =>
      runRag([
        'ask',
        'q',
        '--kb',
        'kb',
        '--via',
        'gw',
        '--model',
        'm',
        '--top-k',
        '0',
      ]),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('--top-k must be a positive integer');
    expect(calls.ragSearch).toHaveLength(0);
    expect(calls.chatComplete).toHaveLength(0);
  });

  test('--top-k=-3 rejects', async () => {
    installStubClient({});
    const { code, stderr } = await capture(() =>
      runRag([
        'ask',
        'q',
        '--kb',
        'kb',
        '--via',
        'gw',
        '--model',
        'm',
        '--top-k',
        '-3',
      ]),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('--top-k must be a positive integer');
  });

  test('unknown flag rejects', async () => {
    installStubClient({});
    const { code, stderr } = await capture(() =>
      runRag([
        'ask',
        'q',
        '--kb',
        'kb',
        '--via',
        'gw',
        '--model',
        'm',
        '--fortune-cookie',
      ]),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('unknown flag --fortune-cookie');
  });

  test('unknown subcommand prints usage and exits 1', async () => {
    const { code, stderr } = await capture(() => runRag(['store']));
    expect(code).toBe(1);
    expect(stderr).toContain('Unknown rag subcommand: store');
  });

  test('no args → prints usage and exits 0', async () => {
    const { code, stdout } = await capture(() => runRag([]));
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: llamactl rag');
    expect(stdout).toContain('ask <question>');
  });
});

describe('rag ask — error propagation', () => {
  test('ragSearch failure → exit 1 with node name in message', async () => {
    installStubClient({ throwOnSearch: new Error('adapter exploded') });
    const { code, stderr } = await capture(() =>
      runRag([
        'ask',
        'q',
        '--kb',
        'kb-broken',
        '--via',
        'gw',
        '--model',
        'm',
      ]),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('retrieval failed');
    expect(stderr).toContain('kb-broken');
    expect(stderr).toContain('adapter exploded');
  });

  test('chatComplete failure → exit 1 with via name in message', async () => {
    installStubClient({
      searchResults: [{ id: 'd1', content: 'x', score: 1 }],
      throwOnChat: new Error('upstream 502'),
    });
    const { code, stderr } = await capture(() =>
      runRag([
        'ask',
        'q',
        '--kb',
        'kb',
        '--via',
        'gw-broken',
        '--model',
        'm',
      ]),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('chat completion failed');
    expect(stderr).toContain('gw-broken');
    expect(stderr).toContain('upstream 502');
  });

  test('zero-result retrieval still calls chatComplete (context just empty)', async () => {
    const calls = installStubClient({
      searchResults: [],
      answer: "I don't know.",
    });
    const { code, stdout } = await capture(() =>
      runRag([
        'ask',
        'q',
        '--kb',
        'kb',
        '--via',
        'gw',
        '--model',
        'm',
      ]),
    );
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("I don't know.");
    expect(calls.chatComplete).toHaveLength(1);
  });
});

describe('rag ask — inline = separator', () => {
  test('--kb=name / --top-k=5 parse identically to space form', async () => {
    const calls = installStubClient({ answer: 'ok' });
    const { code } = await capture(() =>
      runRag([
        'ask',
        'q',
        '--kb=kb-inline',
        '--via=gw',
        '--model=m',
        '--top-k=5',
      ]),
    );
    expect(code).toBe(0);
    expect(calls.ragSearch[0]!.node).toBe('kb-inline');
    expect(calls.ragSearch[0]!.topK).toBe(5);
  });
});
