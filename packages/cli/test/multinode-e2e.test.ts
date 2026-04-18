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
 * Phase E.3 end-to-end: a two-agent cluster where one acts as
 * "coordinator" and the other as "worker1", with fake llama-server +
 * fake rpc-server binaries on their shared PATH. Apply a ModelRun
 * spec that lists workers and assert both binaries end up running
 * with the right args; delete the workload and assert both come
 * down.
 *
 * Two agents share one process.env here (Bun test runs them in the
 * same process). The coordinator's llama-server and the worker's
 * rpc-server write to distinct PID/state files (llama-server.pid
 * vs. rpc-server.pid) so they coexist fine on the one runtimeDir.
 * Binding ports are distinct by design (spec.rpcPort differs from
 * \$LLAMA_CPP_PORT).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'src', 'bin.ts');

interface CliResult { code: number; stdout: string; stderr: string; }

function runCliAsync(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<CliResult> {
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
# Record the full args so the test can inspect what was launched with.
echo "$@" > "$LLAMA_CPP_LOGS/fake-llama-last-args.txt" 2>/dev/null || true
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

const FAKE_RPC_SERVER = `#!/bin/bash
HOST=0.0.0.0
PORT=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
export FAKE_HOST="$HOST"
export FAKE_PORT="$PORT"
exec bun -e "const s=Bun.listen({hostname:process.env.FAKE_HOST,port:Number(process.env.FAKE_PORT),socket:{data(){},open(){},close(){},error(){}}});process.on('SIGTERM',()=>{s.stop();process.exit(0);});process.on('SIGINT',()=>{s.stop();process.exit(0);});await new Promise(()=>{});"
`;

let tmp = '';
let coordinatorAgent: RunningAgent | null = null;
let workerAgent: RunningAgent | null = null;
let kubeconfigPath = '';
let workloadsDir = '';
let manifestPath = '';
let runtimeDir = '';
let logsDir = '';
let coordPort = 0;
let rpcPort = 0;
const originalEnv: NodeJS.ProcessEnv = { ...process.env };

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-multi-'));
  const devStorage = join(tmp, 'devstorage');
  runtimeDir = join(devStorage, 'ai-models', 'local-ai');
  const modelsDir = join(devStorage, 'ai-models', 'llama.cpp', 'models');
  const binDir = join(tmp, 'bin');
  logsDir = join(devStorage, 'logs', 'llama.cpp');
  kubeconfigPath = join(tmp, 'kubeconfig');
  workloadsDir = join(tmp, 'workloads');
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(workloadsDir, { recursive: true });

  coordPort = 19200 + Math.floor(Math.random() * 99);
  rpcPort = 19300 + Math.floor(Math.random() * 99);

  process.env.DEV_STORAGE = devStorage;
  process.env.LOCAL_AI_RUNTIME_DIR = runtimeDir;
  process.env.LLAMA_CPP_MODELS = modelsDir;
  process.env.LLAMA_CPP_BIN = binDir;
  process.env.LLAMA_CPP_LOGS = logsDir;
  process.env.LLAMA_CPP_HOST = '127.0.0.1';
  process.env.LLAMA_CPP_PORT = String(coordPort);
  process.env.LLAMA_CPP_USE_TUNED_ARGS = 'false';

  writeFileSync(join(binDir, 'llama-server'), FAKE_LLAMA_SERVER, { mode: 0o755 });
  writeFileSync(join(binDir, 'rpc-server'), FAKE_RPC_SERVER, { mode: 0o755 });

  const rel = 'fake-org/fake-model.gguf';
  mkdirSync(join(modelsDir, 'fake-org'), { recursive: true });
  writeFileSync(join(modelsDir, rel), 'GGUF-fake', 'utf8');

  const cCert = await tls.generateSelfSignedCert({
    dir: join(tmp, 'coord-tls'), commonName: '127.0.0.1', hostnames: ['127.0.0.1'],
  });
  const cTok = auth.generateToken();
  coordinatorAgent = startAgentServer({
    bindHost: '127.0.0.1', port: 0, tokenHash: cTok.hash,
    tls: { certPath: cCert.certPath, keyPath: cCert.keyPath },
  });

  const wCert = await tls.generateSelfSignedCert({
    dir: join(tmp, 'worker-tls'), commonName: '127.0.0.1', hostnames: ['127.0.0.1'],
  });
  const wTok = auth.generateToken();
  workerAgent = startAgentServer({
    bindHost: '127.0.0.1', port: 0, tokenHash: wTok.hash,
    tls: { certPath: wCert.certPath, keyPath: wCert.keyPath },
  });

  let cfg = configSchema.freshConfig();
  cfg = kubecfg.upsertNode(cfg, 'home', {
    name: 'coordinator',
    endpoint: coordinatorAgent.url,
    certificateFingerprint: cCert.fingerprint,
    certificate: cCert.certPem,
  });
  cfg = kubecfg.upsertNode(cfg, 'home', {
    name: 'worker1',
    endpoint: workerAgent.url,
    certificateFingerprint: wCert.fingerprint,
    certificate: wCert.certPem,
  });
  cfg = {
    ...cfg,
    users: cfg.users.map((u) =>
      u.name === 'me'
        // Both agents share the "me" bearer token — same user/tenant.
        // Each agent's tokenHash was derived from *its* own token, but
        // for the purposes of this test we just re-issue one shared
        // token and re-init each agent's tokenHash from it.
        ? { ...u, token: cTok.token }
        : u,
    ),
  };
  // Simpler: re-create worker agent with the coordinator's token so
  // both accept the same bearer. Tear down the old worker first.
  await workerAgent.stop();
  workerAgent = startAgentServer({
    bindHost: '127.0.0.1', port: 0, tokenHash: cTok.hash,
    tls: { certPath: wCert.certPath, keyPath: wCert.keyPath },
  });
  cfg = kubecfg.upsertNode(cfg, 'home', {
    name: 'worker1',
    endpoint: workerAgent.url,
    certificateFingerprint: wCert.fingerprint,
    certificate: wCert.certPem,
  });
  // (cTok is the shared token; wTok is discarded.)
  void wTok;
  kubecfg.saveConfig(cfg, kubeconfigPath);

  manifestPath = join(tmp, 'split.yaml');
  writeFileSync(
    manifestPath,
    [
      'apiVersion: llamactl/v1',
      'kind: ModelRun',
      'metadata:',
      '  name: split-qa',
      'spec:',
      '  node: coordinator',
      '  target:',
      '    kind: rel',
      '    value: fake-org/fake-model.gguf',
      '  workers:',
      '    - node: worker1',
      '      rpcHost: 127.0.0.1',
      `      rpcPort: ${rpcPort}`,
      '  timeoutSeconds: 10',
      '',
    ].join('\n'),
    'utf8',
  );
});

afterEach(async () => {
  if (coordinatorAgent) { await coordinatorAgent.stop(); coordinatorAgent = null; }
  if (workerAgent) { await workerAgent.stop(); workerAgent = null; }
  // Reap both kinds of fake subprocesses.
  for (const pidFile of [
    join(runtimeDir, 'llama-server.pid'),
    join(runtimeDir, 'rpc-server.pid'),
  ]) {
    if (existsSync(pidFile)) {
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
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

describe('multi-node workload: coordinator + rpc worker', () => {
  test('apply brings up worker rpc-server + coordinator llama-server, delete tears both down', async () => {
    const apply = await runCliAsync(['apply', '-f', manifestPath], testEnv(), 40_000);
    expect(apply.code).toBe(0);
    expect(apply.stdout).toContain('started modelrun/split-qa on node coordinator');

    // Coordinator's llama-server must have been launched with --rpc.
    const argsPath = join(logsDir, 'fake-llama-last-args.txt');
    expect(existsSync(argsPath)).toBe(true);
    const coordArgs = readFileSync(argsPath, 'utf8');
    expect(coordArgs).toContain(`--rpc 127.0.0.1:${rpcPort}`);

    // Both server + rpc-server tracked on their respective pid files.
    expect(existsSync(join(runtimeDir, 'llama-server.pid'))).toBe(true);
    expect(existsSync(join(runtimeDir, 'rpc-server.pid'))).toBe(true);

    const coordStatus = await runCliAsync(
      ['--node', 'coordinator', 'server', 'status', '--json'], testEnv(), 10_000,
    );
    expect(coordStatus.stdout).toContain('"state": "up"');

    const del = await runCliAsync(['delete', 'workload', 'split-qa'], testEnv(), 30_000);
    expect(del.code).toBe(0);
    expect(del.stdout).toContain('stopped server on node coordinator');
    expect(del.stdout).toContain('stopped rpc-server on worker worker1');

    expect(existsSync(join(runtimeDir, 'llama-server.pid'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'rpc-server.pid'))).toBe(false);
  }, 80_000);
});
