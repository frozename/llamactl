import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  probeFleet,
  probeFleetViaNova,
  stateTransitions,
  startHealerLoop,
  type JournalEntry,
  type RunbookToolClient,
  type ToolCallInput,
} from '../src/index.js';

/**
 * Healer tests. Fetch + clock are injected so nothing leaves the
 * process or depends on wall-clock latency; the journal writer is
 * injected so the tests collect entries in memory and assert on them
 * directly.
 */

let runtimeDir = '';

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-healer-'));
});
afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});

function seedYamls(overrides?: {
  gateways?: Array<{ name: string; provider: string; baseUrl: string }>;
  providers?: Array<{ name: string; kind: string; baseUrl: string }>;
}): { kubeconfigPath: string; siriusProvidersPath: string } {
  const gateways = overrides?.gateways ?? [
    { name: 'sirius-primary', provider: 'sirius', baseUrl: 'http://g1/v1' },
  ];
  const providers = overrides?.providers ?? [
    { name: 'openai', kind: 'openai', baseUrl: 'http://p1/v1' },
  ];
  const kubeconfigPath = join(runtimeDir, 'config');
  writeFileSync(
    kubeconfigPath,
    stringifyYaml({
      apiVersion: 'llamactl/v1',
      kind: 'Config',
      currentContext: 'default',
      contexts: [{ name: 'default', cluster: 'home', user: 'me', defaultNode: 'local' }],
      clusters: [
        {
          name: 'home',
          nodes: [
            { name: 'local', endpoint: 'inproc://local' },
            ...gateways.map((g) => ({
              name: g.name,
              endpoint: '',
              kind: 'gateway',
              cloud: { provider: g.provider, baseUrl: g.baseUrl },
            })),
          ],
        },
      ],
      users: [{ name: 'me', token: 't' }],
    }),
  );
  const siriusProvidersPath = join(runtimeDir, 'sirius-providers.yaml');
  writeFileSync(siriusProvidersPath, stringifyYaml({ providers }));
  return { kubeconfigPath, siriusProvidersPath };
}

describe('probeFleet', () => {
  test('classifies probes as healthy / unhealthy based on response.ok', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls();
    const fakeFetch = async (url: string | URL): Promise<Response> => {
      if (String(url).includes('g1')) return new Response('ok', { status: 200 });
      return new Response('boom', { status: 500 });
    };
    const report = await probeFleet({
      kubeconfigPath,
      siriusProvidersPath,
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
      now: () => 1_700_000_000_000,
    });
    expect(report.probes).toHaveLength(2);
    expect(report.unhealthy).toBe(1);
    const gw = report.probes.find((p) => p.kind === 'gateway')!;
    const pr = report.probes.find((p) => p.kind === 'provider')!;
    expect(gw.state).toBe('healthy');
    expect(pr.state).toBe('unhealthy');
    expect(pr.status).toBe(500);
  });

  test('thrown fetch surfaces as unhealthy with error message', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls({ providers: [] });
    const fakeFetch = async (): Promise<Response> => {
      throw new Error('ECONNREFUSED');
    };
    const report = await probeFleet({
      kubeconfigPath,
      siriusProvidersPath,
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    });
    const gw = report.probes[0]!;
    expect(gw.state).toBe('unhealthy');
    expect(gw.status).toBe(0);
    expect(gw.error).toMatch(/ECONNREFUSED/);
  });

  test('missing YAMLs yield empty report rather than throwing', async () => {
    const report = await probeFleet({
      kubeconfigPath: join(runtimeDir, 'does-not-exist.yaml'),
      siriusProvidersPath: join(runtimeDir, 'also-missing.yaml'),
    });
    expect(report.probes).toEqual([]);
    expect(report.unhealthy).toBe(0);
  });
});

describe('stateTransitions', () => {
  test('emits entries only for state flips between consecutive reports', () => {
    const ts = new Date().toISOString();
    const prev = {
      ts,
      unhealthy: 1,
      probes: [
        { name: 'a', kind: 'gateway' as const, baseUrl: '', state: 'healthy' as const, status: 200, latencyMs: 1 },
        { name: 'b', kind: 'provider' as const, baseUrl: '', state: 'unhealthy' as const, status: 500, latencyMs: 1 },
      ],
    };
    const next = {
      ts,
      unhealthy: 1,
      probes: [
        { name: 'a', kind: 'gateway' as const, baseUrl: '', state: 'unhealthy' as const, status: 500, latencyMs: 1 },
        { name: 'b', kind: 'provider' as const, baseUrl: '', state: 'unhealthy' as const, status: 500, latencyMs: 1 },
      ],
    };
    const trans = stateTransitions(prev, next);
    expect(trans).toEqual([{ name: 'a', kind: 'gateway', from: 'healthy', to: 'unhealthy' }]);
  });

  test('first pass treats every probe as a transition from "unknown"', () => {
    const report = {
      ts: '',
      unhealthy: 0,
      probes: [
        { name: 'a', kind: 'gateway' as const, baseUrl: '', state: 'healthy' as const, status: 200, latencyMs: 1 },
      ],
    };
    expect(stateTransitions(null, report)).toEqual([
      { name: 'a', kind: 'gateway', from: 'unknown', to: 'healthy' },
    ]);
  });
});

describe('startHealerLoop (--once)', () => {
  test('one tick emits one tick entry + one transition per probe on first pass', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls();
    const fakeFetch = async (): Promise<Response> => new Response('ok', { status: 200 });
    const journaled: JournalEntry[] = [];
    const handle = startHealerLoop({
      kubeconfigPath,
      siriusProvidersPath,
      once: true,
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
      writeJournal: (entry) => journaled.push(entry),
    });
    await handle.done;
    // Two probes (1 gateway + 1 provider), first pass = 2 transitions + 1 tick.
    const transitions = journaled.filter((e) => e.kind === 'transition');
    const ticks = journaled.filter((e) => e.kind === 'tick');
    expect(transitions).toHaveLength(2);
    expect(ticks).toHaveLength(1);
    const first = ticks[0];
    if (first && first.kind === 'tick') {
      expect(first.report.unhealthy).toBe(0);
    }
  });

  test('onTick surfaces summary + transitions inline', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls({ providers: [] });
    const fakeFetch = async (): Promise<Response> => new Response('err', { status: 500 });
    let ticks = 0;
    const handle = startHealerLoop({
      kubeconfigPath,
      siriusProvidersPath,
      once: true,
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
      writeJournal: () => {},
      onTick: (report) => {
        ticks++;
        expect(report.unhealthy).toBe(1);
      },
    });
    await handle.done;
    expect(ticks).toBe(1);
  });
});

/**
 * Helpers for the facade-path tests. `envelope(payload)` wraps JSON
 * into the same `{ content: [{ type: 'text', text }] }` shape
 * `nova.ops.healthcheck` emits (via `toTextContent`). A `mockClient`
 * implements the minimal `RunbookToolClient` surface the facade path
 * consumes.
 */
function envelope(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function mockClient(handler: (input: ToolCallInput) => Promise<unknown>): RunbookToolClient {
  return {
    async callTool(input: ToolCallInput) {
      return handler(input);
    },
  };
}

describe('probeFleetViaNova', () => {
  test('normalizes a canned nova.ops.healthcheck envelope into a ProbeReport', async () => {
    const client = mockClient(async (input) => {
      expect(input.name).toBe('nova.ops.healthcheck');
      return envelope({
        timeoutMs: 1500,
        gateways: [
          { name: 'g-a', baseUrl: 'http://a/v1', ok: true, status: 200 },
          { name: 'g-b', baseUrl: 'http://b/v1', ok: false, status: 502, error: 'bad gateway' },
        ],
        siriusProviders: [
          { name: 'openai', kind: 'openai', baseUrl: 'http://p/v1', ok: true, status: 200 },
        ],
      });
    });
    const report = await probeFleetViaNova(client);
    expect(report.probes).toHaveLength(3);
    expect(report.unhealthy).toBe(1);
    const gwA = report.probes.find((p) => p.name === 'g-a')!;
    const gwB = report.probes.find((p) => p.name === 'g-b')!;
    const prov = report.probes.find((p) => p.name === 'openai')!;
    expect(gwA.state).toBe('healthy');
    expect(gwA.kind).toBe('gateway');
    expect(gwB.state).toBe('unhealthy');
    expect(gwB.status).toBe(502);
    expect(gwB.error).toBe('bad gateway');
    expect(prov.state).toBe('healthy');
    expect(prov.kind).toBe('provider');
    // providerKind is the extra field carrying the nova `kind` value.
    expect((prov as { providerKind?: string }).providerKind).toBe('openai');
  });

  test('isError envelope throws with the downstream text content', async () => {
    const client = mockClient(async () => ({
      isError: true,
      content: [{ type: 'text', text: 'nova boot failed: no kubeconfig' }],
    }));
    await expect(probeFleetViaNova(client)).rejects.toThrow(/no kubeconfig/);
  });
});

describe('startHealerLoop (facade path)', () => {
  test('happy case — tick.source==="nova" and report matches envelope', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls();
    const toolClient = mockClient(async () =>
      envelope({
        timeoutMs: 1500,
        gateways: [
          { name: 'g1', baseUrl: 'http://g1/v1', ok: true, status: 200 },
          { name: 'g2', baseUrl: 'http://g2/v1', ok: true, status: 200 },
        ],
        siriusProviders: [
          { name: 'openai', kind: 'openai', baseUrl: 'http://p/v1', ok: false, status: 500 },
        ],
      }),
    );
    const journaled: JournalEntry[] = [];
    const handle = startHealerLoop({
      kubeconfigPath,
      siriusProvidersPath,
      once: true,
      toolClient,
      writeJournal: (entry) => journaled.push(entry),
    });
    await handle.done;
    const tick = journaled.find((e) => e.kind === 'tick');
    expect(tick && tick.kind === 'tick' ? tick.source : null).toBe('nova');
    if (tick && tick.kind === 'tick') {
      expect(tick.report.probes).toHaveLength(3);
      expect(tick.report.unhealthy).toBe(1);
    }
    // Three transitions (first pass, unknown → state for each probe).
    const transitions = journaled.filter((e) => e.kind === 'transition');
    expect(transitions).toHaveLength(3);
  });

  test('fallback — rejected toolClient.callTool falls back to raw probeFleet with stderr line', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls();
    let rawCalled = 0;
    const fakeFetch = async (): Promise<Response> => {
      rawCalled++;
      return new Response('ok', { status: 200 });
    };
    const toolClient = mockClient(async () => {
      throw new Error('boom');
    });
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = ((chunk: unknown): boolean => {
      captured.push(String(chunk));
      return true;
    });
    const journaled: JournalEntry[] = [];
    try {
      const handle = startHealerLoop({
        kubeconfigPath,
        siriusProvidersPath,
        once: true,
        toolClient,
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
        writeJournal: (entry) => journaled.push(entry),
      });
      await handle.done;
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = origWrite;
    }
    expect(rawCalled).toBeGreaterThan(0);
    const fellBackLine = captured.find((s) => s.includes('facade health call failed'));
    expect(fellBackLine).toBeTruthy();
    expect(fellBackLine).toContain('boom');
    expect(fellBackLine).toContain('falling back to direct probe');
    const tick = journaled.find((e) => e.kind === 'tick');
    expect(tick && tick.kind === 'tick' ? tick.source : null).toBe('direct');
  });

  test('fallback — isError: true envelope also falls back and carries the downstream message', async () => {
    const { kubeconfigPath, siriusProvidersPath } = seedYamls({ providers: [] });
    const fakeFetch = async (): Promise<Response> => new Response('ok', { status: 200 });
    const toolClient = mockClient(async () => ({
      isError: true,
      content: [{ type: 'text', text: 'downstream exploded' }],
    }));
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = ((chunk: unknown): boolean => {
      captured.push(String(chunk));
      return true;
    });
    const journaled: JournalEntry[] = [];
    try {
      const handle = startHealerLoop({
        kubeconfigPath,
        siriusProvidersPath,
        once: true,
        toolClient,
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
        writeJournal: (entry) => journaled.push(entry),
      });
      await handle.done;
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = origWrite;
    }
    const fellBackLine = captured.find((s) => s.includes('facade health call failed'));
    expect(fellBackLine).toBeTruthy();
    expect(fellBackLine).toContain('downstream exploded');
    const tick = journaled.find((e) => e.kind === 'tick');
    expect(tick && tick.kind === 'tick' ? tick.source : null).toBe('direct');
  });
});
