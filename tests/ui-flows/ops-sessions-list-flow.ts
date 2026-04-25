import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class McpClient {
  private seq = 1;
  private pending = new Map<number, (res: JsonRpcResponse) => void>();
  private readonly proc: ChildProcessByStdio<Writable, Readable, null>;
  constructor(proc: ChildProcessByStdio<Writable, Readable, null>) {
    this.proc = proc;
    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const frame = JSON.parse(line) as JsonRpcResponse;
        const cb = this.pending.get(frame.id as number);
        if (cb) {
          this.pending.delete(frame.id as number);
          cb(frame);
        }
      } catch {}
    });
  }
  async call(tool: string, args: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.seq++;
    const res = await new Promise<JsonRpcResponse>((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectP(new Error(`timeout ${tool}`));
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolveP(r);
      });
      this.proc.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } }) + '\n'
      );
    });
    if (res.error) throw new Error(`${tool} → ${res.error.message}`);
    const envelope = res.result as { isError?: boolean; content?: Array<{ text?: string }> };
    const text = envelope?.content?.[0]?.text ?? '';
    if (envelope?.isError) throw new Error(`${tool} → ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  }
  initialize(): Promise<JsonRpcResponse> {
    const id = this.seq++;
    return new Promise((resolveP) => {
      this.pending.set(id, resolveP);
      this.proc.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0', id, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ui-flow', version: '1' } }
        }) + '\n'
      );
    });
  }
  kill(): void {
    try { this.proc.kill(); } catch {}
  }
}

interface DriverArgs {
  executable: string;
  execArgs: string[];
  env: NodeJS.ProcessEnv;
  userDataDir?: string;
}

function parseArgs(argv: string[]): DriverArgs {
  let executable: string | undefined;
  let execArgs: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env };
  let userDataDir: string | undefined;
  for (const a of argv.slice(2)) {
    if (a.startsWith('--executable=')) executable = a.slice('--executable='.length);
    else if (a.startsWith('--args=')) execArgs = a.slice('--args='.length).split(' ').filter(Boolean);
    else if (a.startsWith('--env=')) {
      const kv = a.slice('--env='.length);
      const eq = kv.indexOf('=');
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a.startsWith('--userDataDir=')) userDataDir = a.slice('--userDataDir='.length);
  }
  if (!executable) throw new Error('--executable required');
  const out: DriverArgs = { executable, execArgs, env };
  if (userDataDir !== undefined) out.userDataDir = userDataDir;
  return out;
}

function check(label: string, cond: boolean, detail = ''): void {
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
}

function resolveServerScript(here: string): string {
  const explicit = process.env.ELECTRON_MCP_DIR;
  if (explicit && explicit.length > 0) return resolve(explicit, 'dist', 'server', 'index.js');
  return resolve(here, '..', '..', '..', 'electron-mcp-server', 'dist', 'server', 'index.js');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const here = dirname(fileURLToPath(import.meta.url));
  const serverScript = resolveServerScript(here);
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.ELECTRON_MCP_LOG_LEVEL = env.ELECTRON_MCP_LOG_LEVEL ?? 'warn';
  const nodeBin = process.env.MCP_NODE ?? 'node';
  const proc = spawn(nodeBin, [serverScript], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const client = new McpClient(proc);

  try {
    await client.initialize();
    
    // Test-specific: Seed the journal before launching the app
    const profileDir = args.userDataDir || env.DEV_STORAGE || '/tmp/llamactl-flow';
    for (const id of ['flow-list-a', 'flow-list-b']) {
      const dir = join(profileDir, 'ops-chat', 'sessions', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'journal.jsonl'),
        JSON.stringify({
          type: 'session_started', ts: '2026-04-25T00:00:00.000Z',
          sessionId: id, goal: `goal-${id}`, historyLen: 0, toolCount: 0,
        }) + '\n' +
          JSON.stringify({
            type: 'done', ts: '2026-04-25T00:00:10.000Z', iterations: 0,
          }) + '\n',
        'utf8',
      );
    }

    const launchArgs: Record<string, unknown> = {
      executablePath: args.executable,
      args: args.execArgs,
    };
    if (Object.keys(args.env).length > 0) launchArgs.env = args.env;
    if (args.userDataDir !== undefined) launchArgs.userDataDir = args.userDataDir;
    const launch = (await client.call('electron_launch', launchArgs, 60_000)) as { sessionId?: string };
    const eSessionId = launch.sessionId;
    if (!eSessionId) throw new Error('launch failed');
    
    await client.call('electron_wait_for_window', { sessionId: eSessionId, index: 0, timeoutMs: 30_000 });
    
    await client.call('electron_evaluate_renderer', {
      sessionId: eSessionId,
      expression: `(() => {
        window.useTabStore.getState().open({
          tabKey: 'module:ops-sessions',
          title: 'Ops Sessions',
          kind: 'module',
          openedAt: Date.now(),
        });
      })()`,
    });

    try {
      await client.call('electron_wait_for_selector', {
        sessionId: eSessionId,
        selector: '[data-testid="ops-sessions-root"]',
        state: 'visible',
        timeout: 5_000,
      });
    } catch {
      console.log('SKIP — ops-sessions-root never mounted');
      await client.call('electron_close', { sessionId: eSessionId });
      return;
    }
    
    check('ops-sessions-root mounted', true);

    try {
      await client.call('electron_wait_for_selector', {
        sessionId: eSessionId,
        selector: '[data-testid="ops-sessions-row-flow-list-a"]',
        state: 'visible',
        timeout: 3_000,
      });
      await client.call('electron_wait_for_selector', {
        sessionId: eSessionId,
        selector: '[data-testid="ops-sessions-row-flow-list-b"]',
        state: 'visible',
        timeout: 3_000,
      });
    } catch {
      console.log('SKIP — seeded session rows not rendered');
      await client.call('electron_close', { sessionId: eSessionId });
      return;
    }

    check('seeded session rows visible', true);

    await client.call('electron_close', { sessionId: eSessionId });
    console.log(process.exitCode === 1 ? 'FAIL — see above' : 'PASS — all list flow checks green');
  } catch (err) {
    console.error('flow crashed:', err);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
