import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteNodeClient } from '../src/client/node-client.js';
import { generateToken } from '../src/server/auth.js';
import { startAgentServer, type RunningAgent } from '../src/server/serve.js';
import { generateSelfSignedCert } from '../src/server/tls.js';

/**
 * Phase C.2 end-to-end test: remote serverStart lifecycle via SSE. A
 * bash-wrapped Bun one-liner impersonates llama-server: parses --host
 * / --port out of argv and binds Bun.serve at that address with a 200
 * /health endpoint and a stub /v1/chat responder, then blocks until
 * SIGTERM. The router's serverStart subscription spawns it exactly
 * like the real binary, pollReady() sees /health come back 200, and
 * the `done` event carries { ok: true, pid, endpoint }.
 *
 * We clean up by invoking the serverStop mutation (normal flow) and
 * then process.kill as a safety net.
 */

const FAKE_LLAMA_SERVER = [
  '#!/bin/bash',
  'HOST=127.0.0.1',
  'PORT=8080',
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  '    --host) HOST="$2"; shift 2 ;;',
  '    --port) PORT="$2"; shift 2 ;;',
  '    *) shift ;;',
  '  esac',
  'done',
  'exec bun -e "',
  '  const s = Bun.serve({',
  '    port: Number(process.env.FAKE_PORT),',
  '    hostname: process.env.FAKE_HOST,',
  '    fetch(req) {',
  '      const u = new URL(req.url);',
  '      if (u.pathname === \'/health\') return new Response(\'ok\', {status: 200});',
  '      if (u.pathname === \'/v1/chat/completions\') return Response.json({ ok: true });',
  '      return new Response(\'stub\', {status: 200});',
  '    },',
  '  });',
  '  console.error(\'fake llama-server on\', s.port);',
  '  const stop = () => { s.stop(true); process.exit(0); };',
  '  process.on(\'SIGTERM\', stop);',
  '  process.on(\'SIGINT\', stop);',
  '  await new Promise(() => {});',
  '"',
  '',
].join('\n');

function wrapWithEnv(script: string, vars: Record<string, string>): string {
  const envSetup = Object.entries(vars)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join('\n');
  // Insert the exports before the exec line.
  return script.replace('exec bun', `${envSetup}\nexec bun`);
}

let tmp: string;
let agent: RunningAgent | null = null;
let certPem = '';
let agentToken = '';
let fingerprint = '';
let fakePort = 0;
const originalEnv: NodeJS.ProcessEnv = { ...process.env };

function pickPort(): number {
  // Static-ish ports inside a small range; Bun.serve will throw if
  // taken and the test will report clearly.
  return 17990 + Math.floor(Math.random() * 9);
}

function makeFakeBinary(dir: string, host: string, port: number): void {
  const script = wrapWithEnv(FAKE_LLAMA_SERVER, { FAKE_HOST: host, FAKE_PORT: String(port) });
  writeFileSync(join(dir, 'llama-server'), script, { mode: 0o755 });
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-servsub-'));
  const devStorage = join(tmp, 'devstorage');
  const runtimeDir = join(devStorage, 'ai-models', 'local-ai');
  const modelsDir = join(devStorage, 'ai-models', 'llama.cpp', 'models');
  const binDir = join(tmp, 'bin');
  const logsDir = join(devStorage, 'logs', 'llama.cpp');
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  fakePort = pickPort();

  process.env.DEV_STORAGE = devStorage;
  process.env.LOCAL_AI_RUNTIME_DIR = runtimeDir;
  process.env.LLAMA_CPP_MODELS = modelsDir;
  process.env.LLAMA_CPP_BIN = binDir;
  process.env.LLAMA_CPP_LOGS = logsDir;
  process.env.LLAMA_CPP_HOST = '127.0.0.1';
  process.env.LLAMA_CPP_PORT = String(fakePort);
  // Skip tuned-profile lookup (would require a seeded bench TSV).
  process.env.LLAMA_CPP_USE_TUNED_ARGS = 'false';

  makeFakeBinary(binDir, '127.0.0.1', fakePort);

  // Pre-create the model file so the existence check passes.
  const rel = 'fake-repo/fake-model.gguf';
  mkdirSync(join(modelsDir, 'fake-repo'), { recursive: true });
  writeFileSync(join(modelsDir, rel), 'GGUF-fake', 'utf8');

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
  // Best-effort: kill any PID still tracked in the runtime dir so a
  // failed test doesn't leak the fake server across iterations.
  const pidFile = process.env.LOCAL_AI_RUNTIME_DIR
    ? join(process.env.LOCAL_AI_RUNTIME_DIR, 'llama-server.pid')
    : null;
  if (pidFile && existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
  }
  process.env = { ...originalEnv };
  rmSync(tmp, { recursive: true, force: true });
});

describe('cluster-serverstart: remote serverStart over SSE', () => {
  test('streams launch → ready events and returns endpoint', async () => {
    const client = createRemoteNodeClient({
      url: agent!.url,
      token: agentToken,
      certificate: certPem,
      certificateFingerprint: fingerprint,
    });

    const events: Array<Record<string, unknown>> = [];
    let finalResult: Record<string, unknown> | null = null;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('serverStart timed out')), 15_000);
      const sub = client.serverStart.subscribe(
        { target: 'fake-repo/fake-model.gguf', timeoutSeconds: 8 },
        {
          onData: (e: unknown) => {
            const evt = e as Record<string, unknown>;
            events.push(evt);
            if (evt['type'] === 'done') {
              finalResult = evt['result'] as typeof finalResult;
            }
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
      void sub;
    });

    const types = events.map((e) => e['type']);
    expect(types[0]).toBe('launch');
    expect(types).toContain('ready');
    expect(types[types.length - 1]).toBe('done');

    expect(finalResult).not.toBeNull();
    expect((finalResult as unknown as { ok: boolean }).ok).toBe(true);
    expect((finalResult as unknown as { endpoint: string }).endpoint)
      .toBe(`http://127.0.0.1:${fakePort}`);

    // Bring it down cleanly through the normal mutation path.
    const stop = await client.serverStop.mutate({ graceSeconds: 2 });
    expect(stop).toBeDefined();
  });
});
