import { describe, expect, test } from 'bun:test';

import {
  createCliSubprocessProvider,
  type SpawnStreamFn,
  type SpawnStreamResult,
} from '../src/cli/adapter.js';
import { CliBindingSchema, type CliBinding } from '../src/config/schema.js';
import type { UnifiedAiRequest, UnifiedStreamEvent } from '@nova/contracts';

/**
 * Streaming adapter coverage. Every test injects a fake
 * `SpawnStreamFn` that yields canned lines; no real subprocess.
 * Assertions focus on:
 *   - claude preset (stream: true) exposes `streamResponse`
 *   - codex + gemini (stream: false) DO NOT expose it — callers
 *     fall through to `createResponse`
 *   - Chunks carry the role on the first delta + content-only
 *     on subsequent deltas (OpenAI-envelope convention)
 *   - Caller AbortSignal kills the subprocess + yields error +
 *     done
 *   - Non-zero exit yields an error event before done
 *   - Journal entry records response_bytes across all yielded
 *     chunks; prompt/response bodies never appear
 */

function claudeBinding(overrides: Partial<CliBinding> = {}): CliBinding {
  return CliBindingSchema.parse({
    name: 'claude-pro',
    preset: 'claude',
    timeoutMs: 5_000,
    ...overrides,
  });
}

function codexBinding(): CliBinding {
  return CliBindingSchema.parse({
    name: 'codex-plus',
    preset: 'codex',
    timeoutMs: 5_000,
  });
}

function fakeStreamSpawn(
  linesSource: (() => AsyncIterable<string>) | readonly string[],
  result: {
    stderr?: string;
    exitCode?: number;
    aborted?: boolean;
  } = {},
): SpawnStreamFn {
  return async (_argv, opts): Promise<SpawnStreamResult> => {
    const stderr = result.stderr ?? '';
    let observedAbort = false;
    let resolveExited: (v: { exitCode: number; aborted: boolean }) => void =
      () => {
        /* replaced below */
      };
    const exitedPromise = new Promise<{ exitCode: number; aborted: boolean }>(
      (resolve) => {
        resolveExited = resolve;
      },
    );

    async function* inner(): AsyncIterable<string> {
      try {
        if (typeof linesSource === 'function') {
          yield* linesSource();
        } else {
          for (const l of linesSource) {
            if (opts.signal.aborted) {
              observedAbort = true;
              return;
            }
            yield l;
          }
        }
      } finally {
        // Stdout has drained (or was abandoned). Resolve the exit
        // state now so the adapter's `await exitedPromise` sees the
        // freshest `observedAbort`. Mirrors how Bun's own
        // `proc.exited` fires after stdout closes.
        const aborted = result.aborted ?? observedAbort;
        resolveExited({
          exitCode: result.exitCode ?? (aborted ? -1 : 0),
          aborted,
        });
      }
    }
    opts.signal.addEventListener(
      'abort',
      () => {
        observedAbort = true;
      },
      { once: true },
    );
    return {
      stdout: inner(),
      stderrPromise: Promise.resolve(stderr),
      exitedPromise,
    };
  };
}

const minimalReq: UnifiedAiRequest = {
  model: 'claude-sonnet-4-5',
  messages: [{ role: 'user', content: 'hi' }],
};

async function collect(
  iter: AsyncIterable<UnifiedStreamEvent>,
): Promise<UnifiedStreamEvent[]> {
  const events: UnifiedStreamEvent[] = [];
  for await (const e of iter) events.push(e);
  return events;
}

describe('streamResponse — preset gating', () => {
  test('claude preset exposes streamResponse', () => {
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: claudeBinding(),
      spawnStream: fakeStreamSpawn([]),
      journalWrite: async () => {},
    });
    expect(typeof provider.streamResponse).toBe('function');
  });
  test('codex preset does not expose streamResponse', () => {
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: codexBinding(),
      spawnStream: fakeStreamSpawn([]),
      journalWrite: async () => {},
    });
    expect(provider.streamResponse).toBeUndefined();
  });
});

describe('streamResponse — chunk sequencing', () => {
  test('emits one chunk per line + terminal done', async () => {
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: claudeBinding(),
      spawnStream: fakeStreamSpawn(['hello', 'world', 'bye']),
      journalWrite: async () => {},
    });
    const events = await collect(provider.streamResponse!(minimalReq));
    const chunks = events.filter(
      (e): e is Extract<UnifiedStreamEvent, { type: 'chunk' }> =>
        e.type === 'chunk',
    );
    const done = events.filter(
      (e): e is Extract<UnifiedStreamEvent, { type: 'done' }> =>
        e.type === 'done',
    );
    expect(chunks).toHaveLength(3);
    expect(done).toHaveLength(1);
    expect(done[0]!.finish_reason).toBe('stop');
  });
  test('first chunk carries role: assistant, subsequent chunks content-only', async () => {
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: claudeBinding(),
      spawnStream: fakeStreamSpawn(['a', 'b']),
      journalWrite: async () => {},
    });
    const events = await collect(provider.streamResponse!(minimalReq));
    const chunks = events.filter(
      (e): e is Extract<UnifiedStreamEvent, { type: 'chunk' }> =>
        e.type === 'chunk',
    );
    expect(chunks[0]!.chunk.choices[0]!.delta.role).toBe('assistant');
    expect(chunks[0]!.chunk.choices[0]!.delta.content).toBe('a\n');
    expect(chunks[1]!.chunk.choices[0]!.delta.role).toBeUndefined();
    expect(chunks[1]!.chunk.choices[0]!.delta.content).toBe('b\n');
  });
  test('every chunk shares the same id + model', async () => {
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: claudeBinding({ defaultModel: 'claude-sonnet-4-5' }),
      spawnStream: fakeStreamSpawn(['one', 'two']),
      journalWrite: async () => {},
    });
    const events = await collect(provider.streamResponse!(minimalReq));
    const chunks = events.filter(
      (e): e is Extract<UnifiedStreamEvent, { type: 'chunk' }> =>
        e.type === 'chunk',
    );
    expect(chunks[0]!.chunk.id).toBe(chunks[1]!.chunk.id);
    expect(chunks[0]!.chunk.model).toBe('claude-sonnet-4-5');
  });
});

describe('streamResponse — journal write', () => {
  test('writes a single journal entry at run end; response_bytes sums the deltas', async () => {
    const entries: unknown[] = [];
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: claudeBinding(),
      spawnStream: fakeStreamSpawn(['hello', 'there']),
      journalWrite: async (e) => {
        entries.push(e);
      },
    });
    await collect(provider.streamResponse!(minimalReq));
    expect(entries).toHaveLength(1);
    const e = entries[0] as Record<string, unknown>;
    expect(e.ok).toBe(true);
    // Each line re-attaches a trailing newline; two 5-char + one
    // newline each = 12 bytes.
    expect(e.response_bytes).toBe(12);
    // Body content never landed.
    expect(e).not.toHaveProperty('response');
    expect(e).not.toHaveProperty('prompt');
  });
  test('non-zero exit → error event + done + error_code journal', async () => {
    const entries: unknown[] = [];
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: claudeBinding(),
      spawnStream: fakeStreamSpawn(['partial'], {
        stderr: 'crashed',
        exitCode: 2,
      }),
      journalWrite: async (e) => {
        entries.push(e);
      },
    });
    const events = await collect(provider.streamResponse!(minimalReq));
    const errors = events.filter(
      (e): e is Extract<UnifiedStreamEvent, { type: 'error' }> =>
        e.type === 'error',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error.code).toBe('non-zero-exit');
    expect(events[events.length - 1]!.type).toBe('done');
    const e = entries[0] as Record<string, unknown>;
    expect(e.ok).toBe(false);
    expect(e.error_code).toBe('non-zero-exit');
  });
});

describe('streamResponse — cancellation', () => {
  test('caller AbortSignal aborts mid-stream + yields timeout error + done', async () => {
    // Drive a "hung" stream: emit one line, then hang until the
    // signal fires. Caller aborts after the first chunk.
    let resolveHang: () => void = () => {
      /* replaced below */
    };
    const hangPromise = new Promise<void>((r) => {
      resolveHang = r;
    });
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: claudeBinding({ timeoutMs: 60_000 }),
      spawnStream: fakeStreamSpawn(async function* () {
        yield 'first';
        await hangPromise;
        // After the caller aborts the fake releases hangPromise
        // from the test; the generator then returns naturally.
      }),
      journalWrite: async () => {},
    });
    const caller = new AbortController();
    // Consume via for-await so we stay within the AsyncIterable
    // contract (AiProvider.streamResponse is declared that way).
    const events: UnifiedStreamEvent[] = [];
    let firedAbort = false;
    for await (const e of provider.streamResponse!(minimalReq, caller.signal)) {
      events.push(e);
      if (!firedAbort && e.type === 'chunk') {
        firedAbort = true;
        caller.abort();
        resolveHang();
      }
    }
    const errors = events.filter(
      (e): e is Extract<UnifiedStreamEvent, { type: 'error' }> =>
        e.type === 'error',
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]!.error.code).toBe('timeout');
    expect(events[events.length - 1]!.type).toBe('done');
  });
});

describe('streamResponse — spawn failure', () => {
  test('spawn throws → error event (code spawn-failed) + no done', async () => {
    const provider = createCliSubprocessProvider({
      agentName: 'mac-mini',
      binding: claudeBinding(),
      spawnStream: async () => {
        throw new Error('ENOENT: claude not in PATH');
      },
      journalWrite: async () => {},
    });
    const events = await collect(provider.streamResponse!(minimalReq));
    const errors = events.filter(
      (e): e is Extract<UnifiedStreamEvent, { type: 'error' }> =>
        e.type === 'error',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error.code).toBe('spawn-failed');
    // Spawn failure short-circuits without a done — the orchestrator
    // treats an absent done after an error as an aborted stream.
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });
});
