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
 * End-to-end test for `llamactl expose <target>`: the one-shot
 * wrapper that builds a ModelRun manifest, applies it, and prints
 * the URL external OpenAI clients should use.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'src', 'bin.ts');

interface CliResult { code: number; stdout: string; stderr: string; }

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
HOST=127.0.0.1
PORT=8080
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
export FAKE_HOST="$HOST"
export FAKE_PORT="$PORT"
exec bun -e "const s=Bun.serve({port:Number(process.env.FAKE_PORT),hostname:process.env.FAKE_HOST,fetch(){return new Response('ok',{status:200});}});process.on('SIGTERM',()=>{s.stop(true);process.exit(0);});process.on('SIGINT',()=>{s.stop(true);process.exit(0);});await new Promise(()=>{});"
`;

let tmp: string;
let agent: RunningAgent | null = null;
let kubeconfigPath = '';
let workloadsDir = '';
let runtimeDir = '';
let fakePort = 0;
const originalEnv: NodeJS.ProcessEnv = { ...process.env };

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-expose-'));
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

  fakePort = 19500 + Math.floor(Math.random() * 99);

  process.env.DEV_STORAGE = devStorage;
  process.env.LOCAL_AI_RUNTIME_DIR = runtimeDir;
  process.env.LLAMA_CPP_MODELS = modelsDir;
  process.env.LLAMA_CPP_BIN = binDir;
  process.env.LLAMA_CPP_LOGS = logsDir;
  process.env.LLAMA_CPP_HOST = '0.0.0.0';
  process.env.LLAMA_CPP_PORT = String(fakePort);
  process.env.LLAMA_CPP_ADVERTISED_HOST = 'test-mini.local';
  process.env.LLAMA_CPP_USE_TUNED_ARGS = 'false';

  writeFileSync(join(binDir, 'llama-server'), FAKE_LLAMA_SERVER, { mode: 0o755 });

  const rel = 'fake-org/fake-model.gguf';
  mkdirSync(join(modelsDir, 'fake-org'), { recursive: true });
  writeFileSync(join(modelsDir, rel), 'GGUF-fake', 'utf8');

  const cert = await tls.generateSelfSignedCert({
    dir: tmp, commonName: '127.0.0.1', hostnames: ['127.0.0.1', 'localhost'],
  });
  const tok = auth.generateToken();
  agent = startAgentServer({
    bindHost: '127.0.0.1', port: 0, tokenHash: tok.hash,
    tls: { certPath: cert.certPath, keyPath: cert.keyPath },
  });

  let cfg = configSchema.freshConfig();
  cfg = kubecfg.upsertNode(cfg, 'home', {
    name: 'mini',
    endpoint: agent.url,
    certificateFingerprint: cert.fingerprint,
    certificate: cert.certPem,
  });
  cfg = {
    ...cfg,
    users: cfg.users.map((u) => (u.name === 'me' ? { ...u, token: tok.token } : u)),
  };
  kubecfg.saveConfig(cfg, kubeconfigPath);
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

describe('llamactl expose', () => {
  test('deploys a rel + prints the advertised OpenAI URL', async () => {
    const r = await runCliAsync(
      ['expose', 'fake-org/fake-model.gguf', '--node', 'mini', '--name', 'exposed-test'],
      testEnv(),
      40_000,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('started modelrun/exposed-test on node mini');
    expect(r.stdout).toContain(`http://test-mini.local:${fakePort}`);
    expect(r.stdout).toContain(`http://test-mini.local:${fakePort}/v1`);
    expect(existsSync(join(workloadsDir, 'exposed-test.yaml'))).toBe(true);

    await runCliAsync(['delete', 'workload', 'exposed-test'], testEnv());
  }, 60_000);

  test('--json output includes openaiBaseUrl', async () => {
    const r = await runCliAsync(
      ['expose', 'fake-org/fake-model.gguf', '--node', 'mini', '--name', 'exposed-json', '--json'],
      testEnv(),
      40_000,
    );
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.node).toBe('mini');
    expect(parsed.workload).toBe('exposed-json');
    expect(parsed.action).toBe('started');
    expect(parsed.openaiBaseUrl).toBe(`http://test-mini.local:${fakePort}/v1`);
    expect(parsed.advertisedEndpoint).toBe(`http://test-mini.local:${fakePort}`);

    await runCliAsync(['delete', 'workload', 'exposed-json'], testEnv());
  }, 60_000);

  test('derives a workload name from the rel when --name is omitted', async () => {
    const r = await runCliAsync(
      ['expose', 'fake-org/fake-model.gguf', '--node', 'mini'],
      testEnv(),
      40_000,
    );
    expect(r.code).toBe(0);
    // Slug of "fake-org/fake-model.gguf" → "fake-org-fake-model-gguf"
    expect(r.stdout).toContain('modelrun/fake-org-fake-model-gguf');
    expect(existsSync(join(workloadsDir, 'fake-org-fake-model-gguf.yaml'))).toBe(true);
    await runCliAsync(['delete', 'workload', 'fake-org-fake-model-gguf'], testEnv());
  }, 60_000);
});
