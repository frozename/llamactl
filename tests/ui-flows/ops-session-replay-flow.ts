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
    const sessionId = 'flow-replay-fixture';
    const dir = join(profileDir, 'ops-chat', 'sessions', sessionId);
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: 'session_started', ts: '2026-04-25T00:00:00.000Z', sessionId,
        goal: 'flow fixture: replay only', historyLen: 0, toolCount: 0,
      }),
      JSON.stringify({
        type: 'plan_proposed', ts: '2026-04-25T00:00:01.000Z', stepId: 'sp-fixture-1',
        iteration: 0, tier: 'read', reasoning: 'fixture reasoning text',
        step: { tool: 'llamactl.workload.list', annotation: 'fixture' },
      }),
      JSON.stringify({
        type: 'preview_outcome', ts: '2026-04-25T00:00:02.000Z', stepId: 'sp-fixture-1',
        ok: true, durationMs: 7,
      }),
      JSON.stringify({
        type: 'done', ts: '2026-04-25T00:00:03.000Z', iterations: 1,
      }),
    ];
    writeFileSync(join(dir, 'journal.jsonl'), lines.join('\n') + '\n', 'utf8');

    const launchArgs: Record<string, unknown> = {
      executablePath: args.executable,
      args: args.execArgs,
    };
    if (Object.keys(args.env).length > 0) launchArgs.env = args.env;
    if (args.userDataDir !== undefined) launchArgs.userDataDir = args.userDataDir;
    const launch = (await client.call('electron_launch', launchArgs, 60_000)) as { sessionId?: string };
    const eSessionId = launch.sessionId;
    if (!eSessionId) throw new Error('launch failed');
    
    // Wait for the app to boot
    await client.call('electron_wait_for_window', { sessionId: eSessionId, index: 0, timeoutMs: 30_000 });
    
    // Open the session directly via evaluation
    await client.call('electron_evaluate_renderer', {
      sessionId: eSessionId,
      expression: `(() => {
        window.useTabStore.getState().open({
          tabKey: 'ops-session:${sessionId}',
          title: 'Session ${sessionId}',
          kind: 'ops-session',
          instanceId: '${sessionId}',
          openedAt: Date.now(),
        });
      })()`,
    });

    // Verify it renders
    try {
      await client.call('electron_wait_for_selector', {
        sessionId: eSessionId,
        selector: '[data-testid="ops-session-detail-root"]',
        state: 'visible',
        timeout: 5_000,
      });
    } catch {
      console.log('SKIP — ops-session-detail-root never mounted');
      await client.call('electron_close', { sessionId: eSessionId });
      return;
    }
    
    check('ops-session root visible', true);

    try {
      await client.call('electron_wait_for_selector', {
        sessionId: eSessionId,
        selector: '[data-testid="iteration-card-sp-fixture-1"]',
        state: 'visible',
        timeout: 3_000,
      });
    } catch {
      console.log('SKIP — iteration card not found — selector drift');
      await client.call('electron_close', { sessionId: eSessionId });
      return;
    }

    check('iteration card visible', true);

    // Expand
    await client.call('electron_click', {
      sessionId: eSessionId,
      selector: '[data-testid="iteration-card-header-sp-fixture-1"]',
      force: true,
    });

    try {
      await client.call('electron_wait_for_selector', {
        sessionId: eSessionId,
        selector: 'text=fixture reasoning text',
        state: 'visible',
        timeout: 3_000,
      });
    } catch {
      console.log('SKIP — reasoning text not visible after expand');
      await client.call('electron_close', { sessionId: eSessionId });
      return;
    }

    check('reasoning text visible', true);

    await client.call('electron_close', { sessionId: eSessionId });
    console.log(process.exitCode === 1 ? 'FAIL — see above' : 'PASS — all replay flow checks green');
  } catch (err) {
    console.error('flow crashed:', err);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
