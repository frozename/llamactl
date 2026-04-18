import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auth,
  config as kubecfg,
  configSchema,
  startAgentServer,
  tls,
  type RunningAgent,
} from '@llamactl/remote';

/**
 * Controller reconcile-loop E2E. Uses the same fake-llama-server
 * pattern as workload-e2e but exercises the loop's ability to:
 *   1. Apply a missing workload on the first pass.
 *   2. Restart a workload whose server was killed out-of-band.
 *   3. Hold the file lock so a second controller refuses to start.
 *
 * spawn (async) is used everywhere for the same reason as workload-
 * e2e.test.ts: synchronous waits on the test process block the
 * in-process agent's event loop and deadlock the round-trip.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'src', 'bin.ts');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCliAsync(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn('bun', [CLI_ENTRY, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const killer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

const FAKE_LLAMA_SERVER = `#!/bin/bash
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) export FAKE_HOST="$2"; shift 2 ;;
    --port) export FAKE_PORT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
exec bun -e "const s=Bun.serve({port:Number(process.env.FAKE_PORT),hostname:process.env.FAKE_HOST,fetch(){return new Response('ok',{status:200});}});process.on('SIGTERM',()=>{s.stop(true);process.exit(0);});process.on('SIGINT',()=>{s.stop(true);process.exit(0);});await new Promise(()=>{});"
`;

let tmp: string;
let agent: RunningAgent | null = null;
let kubeconfigPath = '';
let workloadsDir = '';
let manifestPath = '';
let runtimeDir = '';
const originalEnv: NodeJS.ProcessEnv = { ...process.env };

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-ctl-e2e-'));
  const devStorage = join(tmp, 'devstorage');
  runtimeDir = join(devStorage, 'ai-models', 'local-ai');
  const modelsDir = join(devStorage, 'ai-models', 'llama.cpp', 'models');
  const binDir = join(tmp, 'bin');
  const logsDir = join(devStorage, 'logs', 'llama.cpp');
  kubeconfigPath = join(tmp, 'kubeconfig');
  workloadsDir = join(tmp, 'workloads');
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(workloadsDir, { recursive: true });

  const fakePort = 18900 + Math.floor(Math.random() * 99);
  process.env.DEV_STORAGE = devStorage;
  process.env.LOCAL_AI_RUNTIME_DIR = runtimeDir;
  process.env.LLAMA_CPP_MODELS = modelsDir;
  process.env.LLAMA_CPP_BIN = binDir;
  process.env.LLAMA_CPP_LOGS = logsDir;
  process.env.LLAMA_CPP_HOST = '127.0.0.1';
  process.env.LLAMA_CPP_PORT = String(fakePort);
  process.env.LLAMA_CPP_USE_TUNED_ARGS = 'false';

  writeFileSync(join(binDir, 'llama-server'), FAKE_LLAMA_SERVER, { mode: 0o755 });
  mkdirSync(join(modelsDir, 'fake-org'), { recursive: true });
  writeFileSync(join(modelsDir, 'fake-org', 'fake-model.gguf'), 'GGUF-fake');

  const cert = await tls.generateSelfSignedCert({
    dir: tmp,
    commonName: '127.0.0.1',
    hostnames: ['127.0.0.1', 'localhost'],
  });
  const tok = auth.generateToken();
  agent = startAgentServer({
    bindHost: '127.0.0.1',
    port: 0,
    tokenHash: tok.hash,
    tls: { certPath: cert.certPath, keyPath: cert.keyPath },
  });

  let cfg = configSchema.freshConfig();
  cfg = kubecfg.upsertNode(cfg, 'home', {
    name: 'gpu1',
    endpoint: agent.url,
    certificateFingerprint: cert.fingerprint,
    certificate: cert.certPem,
  });
  cfg = {
    ...cfg,
    users: cfg.users.map((u) =>
      u.name === 'me' ? { ...u, token: tok.token } : u,
    ),
  };
  kubecfg.saveConfig(cfg, kubeconfigPath);

  manifestPath = join(tmp, 'ctl.yaml');
  writeFileSync(
    manifestPath,
    `apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: ctl-test
spec:
  node: gpu1
  target:
    kind: rel
    value: fake-org/fake-model.gguf
  timeoutSeconds: 8
`,
    'utf8',
  );
});

afterEach(async () => {
  if (agent) { await agent.stop(); agent = null; }
  const pidFile = join(runtimeDir, 'llama-server.pid');
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
  }
  process.env = { ...originalEnv };
  rmSync(tmp, { recursive: true, force: true });
});

function testEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LLAMACTL_CONFIG: kubeconfigPath,
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
  };
}

describe('controller reconcile loop', () => {
  test('one-shot reconcile starts a missing workload', async () => {
    await runCliAsync(['apply', '-f', manifestPath], testEnv());
    // Stop the server out-of-band to simulate drift.
    await runCliAsync(['--node', 'gpu1', 'server', 'stop'], testEnv());

    const status = await runCliAsync(['--node', 'gpu1', 'server', 'status', '--json'], testEnv());
    expect(status.stdout).toContain('"state": "down"');

    const ctrl = await runCliAsync(['controller', 'serve', '--once'], testEnv());
    expect(ctrl.code).toBe(0);
    expect(ctrl.stdout).toContain('ctl-test on gpu1: started');

    const after = await runCliAsync(['--node', 'gpu1', 'server', 'status', '--json'], testEnv());
    expect(after.stdout).toContain('"state": "up"');

    // Clean up.
    await runCliAsync(['delete', 'workload', 'ctl-test'], testEnv());
  }, 60_000);

  test('one-shot reconcile is a no-op when observed matches desired', async () => {
    await runCliAsync(['apply', '-f', manifestPath], testEnv());
    const ctrl = await runCliAsync(['controller', 'serve', '--once'], testEnv());
    expect(ctrl.code).toBe(0);
    expect(ctrl.stdout).toContain('ctl-test on gpu1: unchanged');
    await runCliAsync(['delete', 'workload', 'ctl-test'], testEnv());
  }, 60_000);

  test('file lock prevents a second controller from starting', async () => {
    // First controller: background, --interval very high so it effectively
    // idles after its first pass.
    const first = spawn('bun', [CLI_ENTRY, 'controller', 'serve', '--interval=30'], { env: testEnv() });
    let seenStarted = false;
    first.stdout.on('data', (d) => {
      if (d.toString().includes('controller started')) seenStarted = true;
    });
    // Wait for it to acquire the lock + print the start banner.
    for (let i = 0; i < 50; i++) {
      if (seenStarted) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(seenStarted).toBe(true);

    try {
      const second = await runCliAsync(
        ['controller', 'serve', '--once'],
        testEnv(),
        8_000,
      );
      expect(second.code).toBe(1);
      expect(second.stderr).toContain('lock held');
    } finally {
      first.kill('SIGTERM');
      await new Promise<void>((r) => first.on('exit', () => r()));
    }
  }, 30_000);
});
