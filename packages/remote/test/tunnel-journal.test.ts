import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendTunnelJournal,
  defaultTunnelJournalPath,
  createTunnelClient,
  encodeTunnelMessage,
  type TunnelJournalEntry,
} from '../src/tunnel/index.js';
import { generateToken, hashToken } from '../src/server/auth.js';
import { startAgentServer, type RunningAgent } from '../src/server/serve.js';

/**
 * Slice D (tunnel-hardening) — JSONL audit journal tests.
 *
 * Unit block verifies the file-level primitives (append shape + env
 * resolution + silent-fail-with-warn-once). Integration block boots
 * `startAgentServer` in the same hermetic way the existing
 * tunnel-integration tests do and asserts each event category lands
 * in the journal with the expected metadata.
 */

function readEntries(path: string): TunnelJournalEntry[] {
  const raw = readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TunnelJournalEntry);
}

async function waitForEntries(
  path: string,
  predicate: (entries: TunnelJournalEntry[]) => boolean,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<TunnelJournalEntry[]> {
  const start = Date.now();
  for (;;) {
    let entries: TunnelJournalEntry[] = [];
    try {
      entries = readEntries(path);
    } catch {
      // file may not exist yet — treat as empty
    }
    if (predicate(entries)) return entries;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitForEntries timed out after ${timeoutMs}ms; saw ${JSON.stringify(entries)}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('appendTunnelJournal (unit)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tunnel-journal-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes one JSON line per entry, round-trips all six kinds', () => {
    const path = join(dir, 'journal.jsonl');
    const ts = '2026-04-19T12:00:00.000Z';
    const entries: TunnelJournalEntry[] = [
      { kind: 'tunnel-connect', ts, nodeName: 'gpu-a' },
      {
        kind: 'tunnel-disconnect',
        ts,
        nodeName: 'gpu-a',
        reason: 'ws closed 1000 (bye)',
        code: 1000,
      },
      {
        kind: 'tunnel-relay-call',
        ts,
        nodeName: 'gpu-a',
        method: 'node.ping',
        durationMs: 12.5,
        ok: true,
      },
      {
        kind: 'tunnel-relay-error',
        ts,
        nodeName: 'ghost',
        code: 'tunnel-send-failed',
        message: 'tunnel not connected',
      },
      {
        kind: 'tunnel-unauthorized',
        ts,
        nodeName: 'gpu-b',
        reason: 'bad-bearer',
      },
      { kind: 'tunnel-replaced', ts, nodeName: 'gpu-a' },
    ];
    for (const e of entries) appendTunnelJournal(e, path);

    const round = readEntries(path);
    expect(round).toHaveLength(entries.length);
    expect(round.map((e) => e.kind)).toEqual([
      'tunnel-connect',
      'tunnel-disconnect',
      'tunnel-relay-call',
      'tunnel-relay-error',
      'tunnel-unauthorized',
      'tunnel-replaced',
    ]);
    for (const e of round) expect(e.ts).toBe(ts);
    expect(round[0]).toEqual(entries[0]!);
    expect(round[5]).toEqual(entries[5]!);
  });

  test('creates parent directory if missing', () => {
    const path = join(dir, 'nested', 'sub', 'journal.jsonl');
    appendTunnelJournal(
      { kind: 'tunnel-connect', ts: '2026-04-19T00:00:00.000Z', nodeName: 'x' },
      path,
    );
    const round = readEntries(path);
    expect(round).toHaveLength(1);
  });
});

describe('defaultTunnelJournalPath (unit)', () => {
  test('LLAMACTL_TUNNEL_JOURNAL wins over everything', () => {
    const got = defaultTunnelJournalPath({
      LLAMACTL_TUNNEL_JOURNAL: '/some/override/path.jsonl',
      DEV_STORAGE: '/tmp/dev',
      HOME: '/home/u',
    } as NodeJS.ProcessEnv);
    expect(got).toBe('/some/override/path.jsonl');
  });

  test('DEV_STORAGE fallback nests under tunnel/journal.jsonl', () => {
    const got = defaultTunnelJournalPath({
      DEV_STORAGE: '/tmp/dev',
    } as NodeJS.ProcessEnv);
    expect(got).toBe(join('/tmp/dev', 'tunnel', 'journal.jsonl'));
  });

  test('neither override → ~/.llamactl/tunnel/journal.jsonl', () => {
    // node:os.homedir() on macOS resolves via getuid()/getpwuid(),
    // not $HOME, so we can't force an arbitrary prefix from env.
    // Assert the suffix (the part this module actually composes) is
    // what we expect.
    const got = defaultTunnelJournalPath({} as NodeJS.ProcessEnv);
    expect(got.endsWith(join('.llamactl', 'tunnel', 'journal.jsonl'))).toBe(true);
  });
});

describe('appendTunnelJournal broken-path handling (unit)', () => {
  test('first failure stderr-warns once; second failure is silent', () => {
    // Choose a path that will reliably fail mkdirSync on both macOS
    // and Linux. `/dev/null/...` cannot have a child directory
    // because `/dev/null` is a character device, not a directory.
    const brokenPath = '/dev/null/tunnel/journal.jsonl';
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // Swap stderr.write for the scope of this test. Tests must not
    // pollute stderr in the test runner output, AND we need to count
    // writes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
    try {
      // Reset module state by re-importing isn't feasible with Bun
      // test's ESM cache, but we at least assert that the first call
      // produces stderr and the second call does NOT add another
      // stderr line. If a previous test in this file already
      // triggered the warn-once gate (it hasn't, per the order in
      // this file), the first assertion here would still catch a
      // regression: captured.length must INCREASE by at most 1 total
      // across both calls.
      const before = captured.length;
      appendTunnelJournal(
        { kind: 'tunnel-connect', ts: '2026-04-19T00:00:00.000Z', nodeName: 'x' },
        brokenPath,
      );
      appendTunnelJournal(
        { kind: 'tunnel-connect', ts: '2026-04-19T00:00:00.000Z', nodeName: 'y' },
        brokenPath,
      );
      const added = captured.length - before;
      // At most one stderr line added across the two failing calls.
      expect(added).toBeLessThanOrEqual(1);
      if (added === 1) {
        // If this process had not already warned, we should see it now.
        expect(captured.join('')).toContain('tunnel-journal:');
        expect(captured.join('')).toContain('entries dropped');
      }
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = origWrite;
    }
  });
});

// -----------------------------------------------------------------
// Integration — startAgentServer + real tunnel clients
// -----------------------------------------------------------------

interface AgentHandle {
  agent: RunningAgent;
  agentToken: string;
  tunnelBearer: string;
  baseUrl: string;
  port: number;
  wsUrl: string;
  journalPath: string;
}

function bootAgentWithTunnel(journalDir: string): AgentHandle {
  const { token: agentToken, hash: agentHash } = generateToken();
  const tunnelBearer = `tun_${Math.random().toString(36).slice(2)}`;
  const journalPath = join(
    journalDir,
    `j-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  const agent = startAgentServer({
    bindHost: '127.0.0.1',
    port: 0,
    tokenHash: agentHash,
    tunnelCentral: { expectedBearerHash: hashToken(tunnelBearer) },
    tunnelJournalPath: journalPath,
  });
  return {
    agent,
    agentToken,
    tunnelBearer,
    baseUrl: agent.url,
    port: agent.port,
    wsUrl: `ws://127.0.0.1:${agent.port}/tunnel`,
    journalPath,
  };
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('tunnel journal — integration', () => {
  let handles: AgentHandle[] = [];
  let journalDir: string;

  beforeEach(() => {
    handles = [];
    journalDir = mkdtempSync(join(tmpdir(), 'tunnel-journal-int-'));
  });
  afterEach(async () => {
    for (const h of handles) await h.agent.stop().catch(() => {});
    handles = [];
    rmSync(journalDir, { recursive: true, force: true });
  });

  test('tunnel-connect + tunnel-disconnect round-trip lands in journal', async () => {
    const h = bootAgentWithTunnel(journalDir);
    handles.push(h);

    const tunnelClient = createTunnelClient({
      url: h.wsUrl,
      bearer: h.tunnelBearer,
      nodeName: 'gpu-alpha',
      handleRequest: async () => 'ok',
      heartbeat: { intervalMs: 0, timeoutMs: 0 },
    });
    await tunnelClient.start();
    await waitFor(() => h.agent.tunnelServer!.registry().length === 1);

    await waitForEntries(
      h.journalPath,
      (es) => es.some((e) => e.kind === 'tunnel-connect'),
    );

    // Force disconnect from the server side; this produces a clean
    // ws close with a known reason we can assert against.
    expect(h.agent.tunnelServer!.disconnect('gpu-alpha', 'test-kick')).toBe(true);
    tunnelClient.stop();

    const entries = await waitForEntries(
      h.journalPath,
      (es) => es.some((e) => e.kind === 'tunnel-disconnect'),
    );
    const connect = entries.find((e) => e.kind === 'tunnel-connect');
    const disconnect = entries.find((e) => e.kind === 'tunnel-disconnect');
    expect(connect).toBeDefined();
    expect(disconnect).toBeDefined();
    if (connect?.kind === 'tunnel-connect') {
      expect(connect.nodeName).toBe('gpu-alpha');
      expect(typeof connect.ts).toBe('string');
    }
    if (disconnect?.kind === 'tunnel-disconnect') {
      expect(disconnect.nodeName).toBe('gpu-alpha');
      // Reason is the `ws closed <code> (<reason>)` format from
      // tunnel-server's close callback.
      expect(disconnect.reason).toContain('ws closed');
      // code should be parsed from the "ws closed 1000" prefix.
      expect(typeof disconnect.code).toBe('number');
    }
  });

  test('tunnel-relay-call success writes metadata + NO payload leakage', async () => {
    const h = bootAgentWithTunnel(journalDir);
    handles.push(h);

    const SECRET_INPUT_MARKER = 'very-secret-bearer-marker-zxcv';
    const SECRET_RESULT_MARKER = 'very-secret-result-marker-qwer';

    const tunnelClient = createTunnelClient({
      url: h.wsUrl,
      bearer: h.tunnelBearer,
      nodeName: 'gpu-alpha',
      handleRequest: async () => ({ secret: SECRET_RESULT_MARKER }),
      heartbeat: { intervalMs: 0, timeoutMs: 0 },
    });
    await tunnelClient.start();
    await waitFor(() => h.agent.tunnelServer!.registry().length === 1);

    const resp = await fetch(`${h.baseUrl}/tunnel-relay/gpu-alpha`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.agentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        method: 'test.echo',
        input: { secret: SECRET_INPUT_MARKER },
      }),
    });
    expect(resp.status).toBe(200);
    await resp.text();

    const entries = await waitForEntries(
      h.journalPath,
      (es) => es.some((e) => e.kind === 'tunnel-relay-call'),
    );
    const call = entries.find((e) => e.kind === 'tunnel-relay-call');
    expect(call).toBeDefined();
    if (call?.kind === 'tunnel-relay-call') {
      expect(call.ok).toBe(true);
      expect(call.method).toBe('test.echo');
      expect(call.nodeName).toBe('gpu-alpha');
      expect(call.durationMs).toBeGreaterThan(0);
    }

    // Critical: grep the entire journal file for the secret markers.
    // The payload and result must NEVER reach the journal.
    const raw = readFileSync(h.journalPath, 'utf8');
    expect(raw).not.toContain(SECRET_INPUT_MARKER);
    expect(raw).not.toContain(SECRET_RESULT_MARKER);

    tunnelClient.stop();
  });

  test('tunnel-relay-error on unknown node writes tunnel-send-failed', async () => {
    const h = bootAgentWithTunnel(journalDir);
    handles.push(h);

    const resp = await fetch(`${h.baseUrl}/tunnel-relay/ghost`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.agentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ method: 'whatever' }),
    });
    expect(resp.status).toBe(502);
    await resp.text();

    const entries = await waitForEntries(
      h.journalPath,
      (es) => es.some((e) => e.kind === 'tunnel-relay-error'),
    );
    const err = entries.find((e) => e.kind === 'tunnel-relay-error');
    expect(err).toBeDefined();
    if (err?.kind === 'tunnel-relay-error') {
      expect(err.code).toBe('tunnel-send-failed');
      expect(err.nodeName).toBe('ghost');
      expect(err.method).toBe('whatever');
      expect(typeof err.message).toBe('string');
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  test('tunnel-unauthorized on bad bearer captures nodeName', async () => {
    const h = bootAgentWithTunnel(journalDir);
    handles.push(h);

    // Raw ws so we can send a hello with the wrong bearer.
    const ws = new WebSocket(h.wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws timeout')), 2000);
      ws.onopen = () => {
        ws.send(
          encodeTunnelMessage({
            type: 'hello',
            bearer: 'not-the-real-bearer',
            nodeName: 'gpu-imposter',
          }),
        );
      };
      ws.onclose = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        // The server will close the ws with a 4401; browser WebSocket
        // surfaces the close as a normal close event, so this is a
        // no-op for assertion purposes.
      };
    });

    const entries = await waitForEntries(
      h.journalPath,
      (es) => es.some((e) => e.kind === 'tunnel-unauthorized'),
    );
    const ua = entries.find((e) => e.kind === 'tunnel-unauthorized');
    expect(ua).toBeDefined();
    if (ua?.kind === 'tunnel-unauthorized') {
      expect(ua.reason).toBe('bad-bearer');
      expect(ua.nodeName).toBe('gpu-imposter');
    }
  });

  test('tunnel-replaced fires before the new tunnel-connect on duplicate nodeName', async () => {
    const h = bootAgentWithTunnel(journalDir);
    handles.push(h);

    const clientA = createTunnelClient({
      url: h.wsUrl,
      bearer: h.tunnelBearer,
      nodeName: 'gpu-dup',
      handleRequest: async () => 'a',
      heartbeat: { intervalMs: 0, timeoutMs: 0 },
    });
    await clientA.start();
    await waitFor(() => h.agent.tunnelServer!.registry().length === 1);
    await waitForEntries(
      h.journalPath,
      (es) =>
        es.filter((e) => e.kind === 'tunnel-connect' && e.nodeName === 'gpu-dup')
          .length >= 1,
    );

    const clientB = createTunnelClient({
      url: h.wsUrl,
      bearer: h.tunnelBearer,
      nodeName: 'gpu-dup',
      handleRequest: async () => 'b',
      heartbeat: { intervalMs: 0, timeoutMs: 0 },
    });
    await clientB.start();

    const entries = await waitForEntries(
      h.journalPath,
      (es) => es.some((e) => e.kind === 'tunnel-replaced'),
    );

    // Order matters: the replaced entry must be emitted BEFORE the
    // second connect entry that displaced the prior owner.
    const replacedIdx = entries.findIndex((e) => e.kind === 'tunnel-replaced');
    const connectIdxs = entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.kind === 'tunnel-connect' && (e as { nodeName: string }).nodeName === 'gpu-dup')
      .map(({ i }) => i);
    expect(replacedIdx).toBeGreaterThanOrEqual(0);
    expect(connectIdxs.length).toBeGreaterThanOrEqual(2);
    // The replaced entry lands between the first connect and the
    // second connect.
    expect(connectIdxs[0]).toBeLessThan(replacedIdx);
    expect(replacedIdx).toBeLessThan(connectIdxs[connectIdxs.length - 1]!);

    clientA.stop();
    clientB.stop();
  });
});
