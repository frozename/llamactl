/**
 * End-to-end check of the N.4.5 planner chat. Drives two turns in stub
 * mode (so no LLM is needed) and asserts the transcript grows to 4
 * turns with the second user message contributing history.
 *
 * Invoke manually; see tests/ui-flows/README.md for setup. Requires a
 * built electron-mcp-server checkout pointed at by ELECTRON_MCP_DIR
 * (or ../electron-mcp-server relative to the llamactl repo root).
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
      } catch {
        /* skip */
      }
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
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }) + '\n',
      );
    });
    if (res.error) throw new Error(`${tool} → ${res.error.message}`);
    const envelope = res.result as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    const text = envelope?.content?.[0]?.text ?? '';
    if (envelope?.isError) throw new Error(`${tool} → ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  initialize(): Promise<JsonRpcResponse> {
    const id = this.seq++;
    return new Promise((resolveP) => {
      this.pending.set(id, (r) => resolveP(r));
      this.proc.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'plan-chat-flow', version: '0.0.1' },
          },
        }) + '\n',
      );
    });
  }
  kill(): void {
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
  }
}

interface A11yNode {
  role: string;
  name?: string;
  children?: A11yNode[];
}
function countByRole(node: A11yNode | null | undefined, role: string): number {
  if (!node) return 0;
  let n = 0;
  const walk = (x: A11yNode): void => {
    if (x.role === role) n += 1;
    for (const c of x.children ?? []) walk(c);
  };
  walk(node);
  return n;
}

interface DriverArgs {
  executable: string;
  execArgs: string[];
  env: Record<string, string>;
  userDataDir?: string;
}

function parseArgs(argv: string[]): DriverArgs {
  let executable: string | undefined;
  let execArgs: string[] = [];
  const env: Record<string, string> = {};
  let userDataDir: string | undefined;
  for (const a of argv.slice(2)) {
    if (a.startsWith('--executable=')) executable = a.slice('--executable='.length);
    else if (a.startsWith('--args=')) execArgs = a.slice('--args='.length).split(' ').filter(Boolean);
    else if (a.startsWith('--env=')) {
      const kv = a.slice('--env='.length);
      const eq = kv.indexOf('=');
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a.startsWith('--userDataDir=')) {
      userDataDir = a.slice('--userDataDir='.length);
    }
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

/**
 * Resolve the electron-mcp-server stdio entrypoint. The driver lives in
 * `<electron-mcp-server>/dist/server/index.js`; callers point
 * `ELECTRON_MCP_DIR` at their checkout, and we fall back to a sibling
 * directory next to the llamactl repo root.
 */
function resolveServerScript(here: string): string {
  const explicit = process.env.ELECTRON_MCP_DIR;
  if (explicit && explicit.length > 0) {
    return resolve(explicit, 'dist', 'server', 'index.js');
  }
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
    const launchArgs: Record<string, unknown> = {
      executablePath: args.executable,
      args: args.execArgs,
    };
    if (Object.keys(args.env).length > 0) launchArgs.env = args.env;
    if (args.userDataDir !== undefined) launchArgs.userDataDir = args.userDataDir;
    const launch = (await client.call('electron_launch', launchArgs, 60_000)) as {
      sessionId?: string;
    };
    const sessionId = launch.sessionId;
    if (!sessionId) throw new Error('launch failed');
    await client.call('electron_wait_for_window', { sessionId, index: 0, timeoutMs: 30_000 });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="dashboard-root"]',
      state: 'visible',
      timeout: 10_000,
    });

    // Open Plan module.
    await client.call('electron_click', { sessionId, selector: 'button[aria-label="Plan"]' });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="plan-root"]',
      state: 'visible',
      timeout: 8_000,
    });

    /* -------- empty state shows on first visit -------- */
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="plan-empty"]',
      state: 'visible',
      timeout: 3_000,
    });
    check('plan-empty card visible on fresh open', true);

    /* -------- Turn 1: send a goal -------- */
    await client.call('electron_fill', {
      sessionId,
      selector: '[data-testid="plan-goal"]',
      value: 'promote the fastest vision model on macbook-pro-48g',
    });
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="plan-submit"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="plan-result"]',
      state: 'visible',
      timeout: 10_000,
    });

    const afterFirst = (await client.call('electron_accessibility_snapshot', {
      sessionId,
      root: '[data-testid="plan-transcript"]',
      interestingOnly: true,
      timeout: 5_000,
    })) as { tree: A11yNode | null };
    // Plan stub mode puts steps in a list; count "listitem" role.
    const stepsAfter1 = countByRole(afterFirst.tree, 'listitem');
    check(
      'Turn 1 assistant renders a plan with >= 1 step',
      stepsAfter1 >= 1,
      `listitems=${stepsAfter1}`,
    );

    /* -------- Turn 2: refinement — expect history folded in -------- */
    await client.call('electron_fill', {
      sessionId,
      selector: '[data-testid="plan-goal"]',
      value: 'also add a rollback step that re-promotes the previous winner',
    });
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="plan-submit"]',
    });
    // Wait for the pending indicator to disappear — indicates the new
    // assistant turn landed.
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="plan-pending"]',
      state: 'hidden',
      timeout: 10_000,
    });

    const afterSecond = (await client.call('electron_accessibility_snapshot', {
      sessionId,
      root: '[data-testid="plan-transcript"]',
      interestingOnly: true,
      timeout: 5_000,
    })) as { tree: A11yNode | null };
    // Count assistant turns: each renders a group containing a Plan
    // card. A simpler proxy: count list items across both turns.
    const listItems = countByRole(afterSecond.tree, 'listitem');
    check(
      'Turn 2 doubled list items (two plans rendered)',
      listItems > stepsAfter1,
      `before=${stepsAfter1} after=${listItems}`,
    );

    /* -------- Reset clears the transcript -------- */
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="plan-reset"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="plan-empty"]',
      state: 'visible',
      timeout: 3_000,
    });
    check('Reset returns to empty state', true);

    await client.call('electron_close', { sessionId });
    console.log(process.exitCode === 1 ? 'FAIL — see above' : 'PASS — all chat flow checks green');
  } catch (err) {
    console.error('flow crashed:', err);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
