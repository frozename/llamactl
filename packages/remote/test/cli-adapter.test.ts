import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UnifiedAiRequest } from '@nova/contracts';

import {
  createCliSubprocessProvider,
  messagesToPrompt,
  type SpawnFn,
  type SpawnResult,
} from '../src/cli/adapter.js';
import type { CliBinding } from '../src/config/schema.js';

function makeBinding(overrides: Partial<CliBinding> = {}): CliBinding {
  return {
    name: 'claude-pro',
    preset: 'claude',
    format: 'text',
    timeoutMs: 5_000,
    advertisedModels: [],
    capabilities: ['reasoning'],
    ...overrides,
  };
}

function fakeSpawn(result: Partial<SpawnResult> & { stdout?: string }): SpawnFn {
  return async () => ({
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode ?? 0,
    aborted: result.aborted ?? false,
  });
}

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-cli-adapter-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const minimalReq: UnifiedAiRequest = {
  model: 'claude-sonnet-4-5',
  messages: [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ],
};

describe('messagesToPrompt', () => {
  test('joins role: content lines with newline', () => {
    const out = messagesToPrompt([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
      { role: 'assistant', content: 'prev' },
    ]);
    expect(out).toBe('system: sys\nuser: user\nassistant: prev');
  });

  test('skips empty-content messages', () => {
    const out = messagesToPrompt([
      { role: 'system', content: '' },
      { role: 'user', content: 'hi' },
    ]);
    expect(out).toBe('user: hi');
  });
});

describe('createCliSubprocessProvider — createResponse happy path', () => {
  test('returns UnifiedAiResponse with assistant content, model, usage, latencyMs', async () => {
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: makeBinding({ defaultModel: 'claude-sonnet-4-5' }),
      spawn: fakeSpawn({ stdout: 'hello\n' }),
      journalWrite: async () => {},
    });
    const res = await provider.createResponse(minimalReq);
    expect(res.object).toBe('chat.completion');
    expect(res.model).toBe('claude-sonnet-4-5');
    expect(res.choices[0]!.message.content).toBe('hello');
    expect(res.choices[0]!.finish_reason).toBe('stop');
    expect(res.provider).toBe('mac-mini.claude-pro');
    expect(typeof res.latencyMs).toBe('number');
    expect(res.usage?.total_tokens).toBeGreaterThan(0);
  });

  test('JSON format extracts response field', async () => {
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: makeBinding({ format: 'json' }),
      spawn: fakeSpawn({ stdout: '{"response":"json extracted"}' }),
      journalWrite: async () => {},
    });
    const res = await provider.createResponse(minimalReq);
    expect(res.choices[0]!.message.content).toBe('json extracted');
  });

  test('JSON format with choices[0].message.content shape', async () => {
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: makeBinding({ format: 'json' }),
      spawn: fakeSpawn({
        stdout: JSON.stringify({
          choices: [{ message: { content: 'nested content' } }],
        }),
      }),
      journalWrite: async () => {},
    });
    const res = await provider.createResponse(minimalReq);
    expect(res.choices[0]!.message.content).toBe('nested content');
  });

  test('non-zero exit throws with non-zero-exit code', async () => {
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: makeBinding(),
      spawn: fakeSpawn({ stdout: '', stderr: 'boom', exitCode: 2 }),
      journalWrite: async () => {},
    });
    try {
      await provider.createResponse(minimalReq);
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as Error).message).toContain('non-zero-exit');
      expect((err as Error & { code?: string }).code).toBe('non-zero-exit');
    }
  });

  test('aborted spawn throws with timeout code', async () => {
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: makeBinding(),
      spawn: fakeSpawn({
        stdout: '',
        stderr: 'still running',
        exitCode: -1,
        aborted: true,
      }),
      journalWrite: async () => {},
    });
    try {
      await provider.createResponse(minimalReq);
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe('timeout');
    }
  });

  test('writes a journal entry on success', async () => {
    const entries: unknown[] = [];
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: makeBinding({ subscription: 'pro-alex' }),
      spawn: fakeSpawn({ stdout: 'ok' }),
      journalWrite: async (e) => {
        entries.push(e);
      },
    });
    await provider.createResponse(minimalReq);
    expect(entries).toHaveLength(1);
    const e = entries[0] as Record<string, unknown>;
    expect(e.ok).toBe(true);
    expect(e.exit_code).toBe(0);
    expect(e.agent).toBe('mac-mini');
    expect(e.subscription).toBe('pro-alex');
    expect(typeof e.prompt_bytes).toBe('number');
    expect((e.prompt_bytes as number) > 0).toBe(true);
    // Body is never logged.
    expect(e).not.toHaveProperty('prompt');
    expect(e).not.toHaveProperty('response');
  });

  test('writes a journal entry with error_code on non-zero-exit', async () => {
    const entries: unknown[] = [];
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: makeBinding(),
      spawn: fakeSpawn({ stdout: '', stderr: 'err', exitCode: 1 }),
      journalWrite: async (e) => {
        entries.push(e);
      },
    });
    try {
      await provider.createResponse(minimalReq);
    } catch {
      /* expected */
    }
    expect(entries).toHaveLength(1);
    const e = entries[0] as Record<string, unknown>;
    expect(e.ok).toBe(false);
    expect(e.error_code).toBe('non-zero-exit');
  });
});

describe('createCliSubprocessProvider — healthCheck', () => {
  test('reports healthy when version probe exits 0', async () => {
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: makeBinding(),
      spawn: fakeSpawn({ stdout: 'claude v1.0.0\n' }),
      journalWrite: async () => {},
    });
    const h = await provider.healthCheck!();
    expect(h.state).toBe('healthy');
    expect(typeof h.latencyMs).toBe('number');
  });

  test('reports unhealthy + error text on non-zero exit', async () => {
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: makeBinding(),
      spawn: fakeSpawn({
        stdout: '',
        stderr: 'command not found',
        exitCode: 127,
      }),
      journalWrite: async () => {},
    });
    const h = await provider.healthCheck!();
    expect(h.state).toBe('unhealthy');
    expect(h.error).toContain('exited 127');
  });

  test('reports unhealthy on spawn-throws', async () => {
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: makeBinding(),
      spawn: async () => {
        throw new Error('ENOENT: claude not in PATH');
      },
      journalWrite: async () => {},
    });
    const h = await provider.healthCheck!();
    expect(h.state).toBe('unhealthy');
    expect(h.error).toContain('ENOENT');
  });
});

describe('adapter journal file integration', () => {
  test('when no journalWrite seam is passed, entries land in LLAMACTL_CLI_JOURNAL_DIR/<day>.jsonl', async () => {
    const env = { ...process.env, LLAMACTL_CLI_JOURNAL_DIR: tmp };
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: makeBinding(),
      spawn: fakeSpawn({ stdout: 'hi' }),
      env,
    });
    await provider.createResponse(minimalReq);
    const day = new Date().toISOString().slice(0, 10);
    const raw = readFileSync(join(tmp, `${day}.jsonl`), 'utf8').trim();
    const parsed = JSON.parse(raw);
    expect(parsed.agent).toBe('mac-mini');
    expect(parsed.ok).toBe(true);
  });
});
