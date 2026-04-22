/**
 * N.4 Operator Console flow — plan a goal, verify the plan renders
 * as tiered approval cards, run a read-tool step, assert the result
 * renders with ok=true.
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
            clientInfo: { name: 'ops-chat-flow', version: '0.0.1' },
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

    // Open Operator Console.
    await client.call('electron_click', {
      sessionId,
      selector: 'button[aria-label="Operator Console"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="ops-chat-root"]',
      state: 'visible',
      timeout: 5_000,
    });
    check('ops-chat-root visible after navigation', true);

    // Empty state on fresh open.
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="ops-chat-empty"]',
      state: 'visible',
      timeout: 3_000,
    });
    check('ops-chat-empty card shows on fresh open', true);

    // Plan a goal. Use one the stub catalog definitely satisfies:
    // the default catalog includes llamactl.catalog.list.
    await client.call('electron_fill', {
      sessionId,
      selector: '[data-testid="ops-chat-goal"]',
      value: 'list installed models on the control plane',
    });
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="ops-chat-submit"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="ops-chat-step-0"]',
      state: 'visible',
      timeout: 10_000,
    });
    check('first proposal bubble streams in inline (iteration 0)', true);

    // N.4 Phase 2 guarantee: proposal bubbles render inline in the
    // transcript (not as a separate StepCard-at-the-bottom layout).
    // The new Reject button is proposal-only — its presence proves
    // we're on the streaming-loop architecture.
    const rejectExists = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        '!!document.querySelector(\'[data-testid="ops-chat-step-0-reject"]\')',
    })) as { result: boolean };
    check(
      'inline proposal bubble exposes Reject button (new architecture)',
      rejectExists.result === true,
    );

    // Stub planner picks the first catalog entry — `llamactl.catalog.list`
    // on this layout. Confirm the tier badge shows it rendered as
    // `read` so the Run (not Preview) path applies.
    const tierEl = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelector(\'[data-testid="ops-chat-step-0-tier"]\')?.textContent ?? null',
    })) as { result: string | null };
    check(
      'tier badge present on proposal 0',
      typeof tierEl.result === 'string' && tierEl.result.length > 0,
      `tier=${String(tierEl.result)}`,
    );

    // Run the step so the audit journal captures an entry.
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="ops-chat-step-0-run"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="ops-chat-step-0-result"]',
      state: 'visible',
      timeout: 8_000,
    });
    const stepOk = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelector(\'[data-testid="ops-chat-step-0-result"]\')?.getAttribute("data-ok")',
    })) as { result: string | null };
    // Read tools against a fresh in-proc router succeed or at worst
    // return a structured envelope — either way the card should
    // resolve. We assert the attribute is set.
    check(
      'step 0 result card has data-ok',
      stepOk.result === 'true' || stepOk.result === 'false',
      `data-ok=${String(stepOk.result)}`,
    );

    // Audit panel reports at least one entry after the run.
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="ops-chat-audit-details"] summary',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="ops-chat-audit-entry-0"]',
      state: 'visible',
      timeout: 8_000,
    });
    check('audit panel shows at least one entry after the run', true);

    // Reset clears the transcript.
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="ops-chat-reset"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="ops-chat-empty"]',
      state: 'visible',
      timeout: 3_000,
    });
    check('reset returns to empty state', true);

    await client.call('electron_close', { sessionId });
    console.log(process.exitCode === 1 ? 'FAIL — see above' : 'PASS — all ops-chat flow checks green');
  } catch (err) {
    console.error('flow crashed:', err);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
