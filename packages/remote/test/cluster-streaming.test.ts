import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteNodeClient } from '../src/client/node-client.js';
import { generateToken } from '../src/server/auth.js';
import { startAgentServer, type RunningAgent } from '../src/server/serve.js';
import { generateSelfSignedCert } from '../src/server/tls.js';

/**
 * End-to-end test for Phase B.2.x streaming: runs the production
 * router's pullFile subscription procedure against a real agent over
 * HTTPS + SSE, with a stubbed `hf` binary on the agent's PATH so the
 * test is hermetic.
 *
 * The agent shares process.env with the test (they're the same process),
 * so we set the env once per test and restore it after. Only one agent
 * runs per test — multi-node streaming with divergent PATHs would need
 * a process-per-node setup, which belongs to a later integration suite.
 */

// Fake hf matching the real args layout after 'download':
//   <repo> <file> [<mmproj>] --local-dir <target>
// Writes a placeholder blob for <file> at <target>/<file>. mmproj is
// skipped since tests set LOCAL_AI_HF_MMPROJ_FETCH=off. We keep bash
// simple (no arrays) so the script sits comfortably inside a JS
// template literal without $[@...] interpretation landmines.
const FAKE_HF_SCRIPT = [
  '#!/bin/bash',
  'shift  # drop "download"',
  'REPO="$1"',
  'FILE="$2"',
  'shift 2',
  'TARGET=""',
  'while [ "$#" -gt 0 ]; do',
  '  if [ "$1" = "--local-dir" ]; then TARGET="$2"; shift 2;',
  '  else shift; fi',
  'done',
  '[ -z "$TARGET" ] && TARGET="."',
  'echo "fake-hf repo=$REPO file=$FILE target=$TARGET" >&2',
  'echo "|--------| 0%" >&2',
  'sleep 0.03',
  'echo "|####----| 50%" >&2',
  'sleep 0.03',
  'echo "|########| 100%" >&2',
  'mkdir -p "$TARGET"',
  'printf "GGUF-fake" > "$TARGET/$FILE"',
  'echo "wrote $TARGET/$FILE" >&2',
  'exit 0',
  '',
].join('\n');

let tmp: string;
let agent: RunningAgent | null = null;
let certPem = '';
let agentToken = '';
let fingerprint = '';
const originalEnv: NodeJS.ProcessEnv = { ...process.env };

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-stream-'));
  const devStorage = join(tmp, 'devstorage');
  const runtimeDir = join(devStorage, 'ai-models', 'local-ai');
  const modelsDir = join(devStorage, 'ai-models', 'llama.cpp', 'models');
  const fakeBinDir = join(tmp, 'fakebin');
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  mkdirSync(fakeBinDir, { recursive: true });
  writeFileSync(join(fakeBinDir, 'hf'), FAKE_HF_SCRIPT, { mode: 0o755 });

  // Point the in-process agent at the hermetic paths. The router reads
  // from process.env live, so setting here takes effect for all router
  // calls until we restore in afterEach.
  process.env.DEV_STORAGE = devStorage;
  process.env.LOCAL_AI_RUNTIME_DIR = runtimeDir;
  process.env.LLAMA_CPP_MODELS = modelsDir;
  process.env.PATH = `${fakeBinDir}:${originalEnv.PATH}`;
  // The pull procedure may call HF for mmproj resolution. Disable the
  // network fetch so this test runs offline.
  process.env.LOCAL_AI_HF_MMPROJ_FETCH = 'off';
  process.env.LOCAL_AI_HF_CACHE_TTL_SECONDS = '0';

  const cert = await generateSelfSignedCert({
    dir: tmp,
    commonName: '127.0.0.1',
    hostnames: ['127.0.0.1', 'localhost'],
  });
  certPem = cert.certPem;
  fingerprint = cert.fingerprint;
  const tok = generateToken();
  agentToken = tok.token;
  agent = startAgentServer({
    bindHost: '127.0.0.1',
    port: 0,
    tokenHash: tok.hash,
    tls: { certPath: cert.certPath, keyPath: cert.keyPath },
    advertiseMdns: false,
  });
});

afterEach(async () => {
  if (agent) { await agent.stop(); agent = null; }
  process.env = { ...originalEnv };
  rmSync(tmp, { recursive: true, force: true });
});

describe('cluster-streaming: pullFile subscription over SSE', () => {
  test('emits start/stderr/exit/done events in order and writes the file', async () => {
    const client = createRemoteNodeClient({
      url: agent!.url,
      token: agentToken,
      certificate: certPem,
      certificateFingerprint: fingerprint,
    });

    const events: Array<Record<string, unknown>> = [];
    let doneResult: Record<string, unknown> | null = null;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pullFile timed out')), 5000);
      const sub = client.pullFile.subscribe(
        { repo: 'fake-org/fake-repo', file: 'model-q4.gguf' },
        {
          onData: (e: unknown) => {
            const evt = e as Record<string, unknown>;
            events.push(evt);
            if (evt['type'] === 'done') doneResult = evt['result'] as typeof doneResult;
          },
          onError: (err: unknown) => {
            clearTimeout(timer);
            reject(err as Error);
          },
          onComplete: () => {
            clearTimeout(timer);
            resolve();
          },
        },
      );
      // Hold the subscription reference so the SSE connection isn't GC'd
      // while the test is waiting.
      void sub;
    });

    // At minimum: one `start`, at least one `stderr`, one `exit`, one
    // `done`. Order is fixed: start precedes stderr precedes exit
    // precedes done.
    const types = events.map((e) => e['type']);
    expect(types[0]).toBe('start');
    expect(types).toContain('stderr');
    expect(types).toContain('exit');
    expect(types[types.length - 1]).toBe('done');
    expect(types.indexOf('start')).toBeLessThan(types.indexOf('exit'));
    expect(types.indexOf('exit')).toBeLessThan(types.indexOf('done'));

    expect(doneResult).not.toBeNull();
    expect((doneResult as unknown as { code: number }).code).toBe(0);
    expect((doneResult as unknown as { rel: string }).rel).toBe('fake-repo/model-q4.gguf');

    const expectedPath = join(process.env.LLAMA_CPP_MODELS!, 'fake-repo', 'model-q4.gguf');
    expect(existsSync(expectedPath)).toBe(true);
  });

  test('client unsubscribe aborts the remote hf subprocess', async () => {
    // Replace the fake hf with a slow one that would run for longer
    // than we're willing to wait. The abort should cut it short.
    const slowHf = `#!/bin/bash
echo "starting slow" >&2
for i in $(seq 1 100); do
  echo "tick $i" >&2
  sleep 0.1
done
exit 0
`;
    const binPath = join(process.env.PATH!.split(':')[0]!, 'hf');
    writeFileSync(binPath, slowHf, { mode: 0o755 });

    const client = createRemoteNodeClient({
      url: agent!.url,
      token: agentToken,
      certificate: certPem,
      certificateFingerprint: fingerprint,
    });

    const seen: string[] = [];
    const settled = { value: false };
    const settlePromise = new Promise<void>((resolve) => {
      const sub = client.pullFile.subscribe(
        { repo: 'fake-org/slow-repo', file: 'big.gguf' },
        {
          onData: (e: unknown) => {
            const t = (e as { type?: string }).type ?? '';
            seen.push(t);
            if (t === 'stderr' && !settled.value && seen.length >= 1) {
              // We've confirmed streaming works; now abort.
              settled.value = true;
              sub.unsubscribe();
              // Give the agent a tick to propagate the abort + resolve.
              setTimeout(() => resolve(), 200);
            }
          },
          onError: () => {
            settled.value = true;
            resolve();
          },
          onComplete: () => {
            settled.value = true;
            resolve();
          },
        },
      );
    });

    await settlePromise;
    // We saw at least a start event, then aborted before the slow
    // subprocess would have naturally finished (10 seconds worth of
    // tick events).
    expect(seen.includes('start')).toBe(true);
    expect(seen.length).toBeLessThan(10); // would be 101 if unaborted
  });
});
