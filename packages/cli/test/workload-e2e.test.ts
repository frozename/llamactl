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
 * End-to-end workload lifecycle test. One hermetic agent acts as
 * "gpu1", its LLAMA_CPP_BIN points at a bash-wrapped Bun one-liner
 * that stands in for llama-server.
 *
 * Note: we use child_process.spawn (async) rather than spawnSync so
 * the test process's event loop stays live while the CLI subprocess
 * runs. The in-process agent serves HTTPS requests from that loop; a
 * synchronous wait here would deadlock on the first round-trip.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'src', 'bin.ts');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCliAsync(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<CliResult> {
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
const originalEnv: NodeJS.ProcessEnv = { ...process.env };

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-wl-e2e-'));
  const devStorage = join(tmp, 'devstorage');
  const runtimeDir = join(devStorage, 'ai-models', 'local-ai');
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

  const fakePort = 18800 + Math.floor(Math.random() * 99);

  process.env.DEV_STORAGE = devStorage;
  process.env.LOCAL_AI_RUNTIME_DIR = runtimeDir;
  process.env.LLAMA_CPP_MODELS = modelsDir;
  process.env.LLAMA_CPP_BIN = binDir;
  process.env.LLAMA_CPP_LOGS = logsDir;
  process.env.LLAMA_CPP_HOST = '127.0.0.1';
  process.env.LLAMA_CPP_PORT = String(fakePort);
  process.env.LLAMA_CPP_USE_TUNED_ARGS = 'false';

  writeFileSync(join(binDir, 'llama-server'), FAKE_LLAMA_SERVER, { mode: 0o755 });

  const rel = 'fake-org/fake-model.gguf';
  mkdirSync(join(modelsDir, 'fake-org'), { recursive: true });
  writeFileSync(join(modelsDir, rel), 'GGUF-fake', 'utf8');

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

  manifestPath = join(tmp, 'gemma-qa.yaml');
  writeFileSync(
    manifestPath,
    [
      'apiVersion: llamactl/v1',
      'kind: ModelRun',
      'metadata:',
      '  name: gemma-qa',
      'spec:',
      '  node: gpu1',
      '  target:',
      '    kind: rel',
      '    value: fake-org/fake-model.gguf',
      '  restartPolicy: Always',
      '  timeoutSeconds: 8',
      '',
    ].join('\n'),
    'utf8',
  );
});

afterEach(async () => {
  if (agent) {
    await agent.stop();
    agent = null;
  }
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

function testEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LLAMACTL_CONFIG: kubeconfigPath,
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
  };
}

describe('workload E2E: apply / get / describe / delete', () => {
  test('apply starts, get reports Running, delete stops + removes', async () => {
    const apply = await runCliAsync(['apply', '-f', manifestPath], testEnv());
    expect(apply.code).toBe(0);
    expect(apply.stdout).toContain('started modelrun/gemma-qa on node gpu1');
    expect(existsSync(join(workloadsDir, 'gemma-qa.yaml'))).toBe(true);

    const get = await runCliAsync(['get', 'workloads'], testEnv());
    expect(get.code).toBe(0);
    expect(get.stdout).toContain('gemma-qa');
    expect(get.stdout).toContain('gpu1');
    expect(get.stdout).toContain('Running');

    const describe = await runCliAsync(['describe', 'workload', 'gemma-qa'], testEnv());
    expect(describe.code).toBe(0);
    expect(describe.stdout).toContain('Node:       gpu1');
    expect(describe.stdout).toContain('fake-org/fake-model.gguf');

    const del = await runCliAsync(['delete', 'workload', 'gemma-qa'], testEnv());
    expect(del.code).toBe(0);
    expect(del.stdout).toContain('stopped server on node gpu1');
    expect(del.stdout).toContain('deleted modelrun/gemma-qa');
    expect(existsSync(join(workloadsDir, 'gemma-qa.yaml'))).toBe(false);

    const describeAfter = await runCliAsync(['describe', 'workload', 'gemma-qa'], testEnv());
    expect(describeAfter.code).toBe(1);
    expect(describeAfter.stderr).toContain('not found');
  }, 30_000);

  test('re-applying an unchanged manifest is a no-op', async () => {
    const first = await runCliAsync(['apply', '-f', manifestPath], testEnv());
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('started');

    const second = await runCliAsync(['apply', '-f', manifestPath], testEnv());
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('unchanged modelrun/gemma-qa');

    await runCliAsync(['delete', 'workload', 'gemma-qa'], testEnv());
  }, 30_000);
});
