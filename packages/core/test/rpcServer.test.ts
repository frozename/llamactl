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
import {
  rpcServerStatus,
  startRpcServer,
  stopRpcServer,
} from '../src/rpcServer.js';
import { resolveEnv } from '../src/env.js';

let tmp: string;
let resolved: ReturnType<typeof resolveEnv>;
const origEnv = { ...process.env };

// Fake rpc-server: a bash-wrapped Bun one-liner that binds a TCP
// port and accepts connections until SIGTERM. Matches what the real
// rpc-server does from a probing perspective.
const FAKE_RPC_SCRIPT = `#!/bin/bash
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

function pickPort(): number {
  return 19050 + Math.floor(Math.random() * 99);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-rpc-'));
  const devStorage = join(tmp, 'ds');
  const binDir = join(devStorage, 'bin');
  const runtimeDir = join(devStorage, 'ai-models', 'local-ai');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(join(devStorage, 'logs', 'llama.cpp'), { recursive: true });
  writeFileSync(join(binDir, 'rpc-server'), FAKE_RPC_SCRIPT, { mode: 0o755 });
  process.env.DEV_STORAGE = devStorage;
  process.env.LLAMA_CPP_BIN = binDir;
  process.env.LOCAL_AI_RUNTIME_DIR = runtimeDir;
  process.env.LLAMA_CPP_LOGS = join(devStorage, 'logs', 'llama.cpp');
  resolved = resolveEnv();
});

afterEach(async () => {
  // Best-effort teardown of any fake that's still listening.
  const pidFile = join(resolved.LOCAL_AI_RUNTIME_DIR, 'rpc-server.pid');
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
  }
  process.env = { ...origEnv };
  rmSync(tmp, { recursive: true, force: true });
});

describe('rpcServer', () => {
  test('starts, reports status=up with host+port, stops cleanly', async () => {
    const port = pickPort();
    const result = await startRpcServer({ host: '127.0.0.1', port, timeoutSeconds: 5 });
    expect(result.ok).toBe(true);
    expect(result.endpoint).toBe(`127.0.0.1:${port}`);
    expect(result.pid).not.toBeNull();

    const status = await rpcServerStatus(resolved);
    expect(status.state).toBe('up');
    expect(status.host).toBe('127.0.0.1');
    expect(status.port).toBe(port);
    expect(status.endpoint).toBe(`127.0.0.1:${port}`);
    expect(status.pid).toBe(result.pid);

    const stopped = await stopRpcServer({ resolved });
    expect(stopped.stopped).toBe(true);
    expect(stopped.pid).toBe(result.pid);

    const after = await rpcServerStatus(resolved);
    expect(after.state).toBe('down');
    expect(after.pid).toBeNull();
  });

  test('missing binary returns an ok=false StartResult', async () => {
    rmSync(join(resolved.LLAMA_CPP_BIN, 'rpc-server'));
    const result = await startRpcServer({ host: '127.0.0.1', port: pickPort() });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('rpc-server binary not found');
  });

  test('stopRpcServer on down state is a no-op that returns stopped=true', async () => {
    const r = await stopRpcServer({ resolved });
    expect(r.stopped).toBe(true);
    expect(r.pid).toBeNull();
  });

  test('emits launch → waiting*? → ready events', async () => {
    const events: Array<{ type: string }> = [];
    const port = pickPort();
    const result = await startRpcServer({
      host: '127.0.0.1',
      port,
      timeoutSeconds: 5,
      onEvent: (e) => events.push(e),
    });
    expect(result.ok).toBe(true);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('launch');
    expect(types[types.length - 1]).toBe('ready');
    await stopRpcServer({ resolved });
  });
});
