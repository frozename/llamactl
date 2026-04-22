/**
 * N.4 Phase 3 — ops-chat refusal + canned-prompt flow. Clicks a
 * canned chip to confirm it populates the draft, then submits a
 * destructive-intent goal and asserts the refusal bubble renders
 * (no proposal, no tool call).
 *
 * Invoke via scripts/smoke-ui-flows.sh. Requires electron-mcp-server
 * per tests/ui-flows/README.md.
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
            clientInfo: { name: 'ops-chat-refusal-flow', version: '0.0.1' },
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

    // Chip strip is visible in empty state.
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="ops-chat-canned-prompts"]',
      state: 'visible',
      timeout: 3_000,
    });
    check('canned prompt chips render above textarea', true);

    // Clicking chip 0 populates the draft textarea.
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="ops-chat-canned-0"]',
    });
    const draftAfterChip = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelector(\'[data-testid="ops-chat-goal"]\')?.value ?? null',
    })) as { result: string | null };
    check(
      'clicking canned chip populates draft textarea',
      typeof draftAfterChip.result === 'string' && draftAfterChip.result.length > 10,
      `length=${String(draftAfterChip.result?.length)}`,
    );

    // Now submit a destructive-intent goal. Must override the chip's
    // seed — replace the textarea content first.
    await client.call('electron_fill', {
      sessionId,
      selector: '[data-testid="ops-chat-goal"]',
      value: 'delete everything from the cluster immediately',
    });
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="ops-chat-submit"]',
    });

    // Refusal bubble renders; no proposal bubble appears.
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid^="ops-chat-refusal-"]',
      state: 'visible',
      timeout: 10_000,
    });
    check('refusal bubble renders for "delete everything"', true);

    const proposalExists = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        '!!document.querySelector(\'[data-testid="ops-chat-step-0"]\')',
    })) as { result: boolean };
    check(
      'no proposal bubble rendered (planner was short-circuited)',
      proposalExists.result === false,
    );

    // Audit should remain empty for this session — no tool ran.
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="ops-chat-audit-details"] summary',
    });
    // Don't assert 0 entries (the audit file may have entries from
    // prior runs); just confirm the refusal bubble contains the
    // rule's reason string.
    const refusalText = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelector(\'[data-testid^="ops-chat-refusal-"]\')?.textContent ?? null',
    })) as { result: string | null };
    check(
      'refusal reason surfaces the matched rule',
      typeof refusalText.result === 'string' && refusalText.result.includes('delete everything'),
      `text="${(refusalText.result ?? '').slice(0, 80)}"`,
    );

    await client.call('electron_close', { sessionId });
    console.log(
      process.exitCode === 1
        ? 'FAIL — see above'
        : 'PASS — refusal + canned-prompt flow green',
    );
  } catch (err) {
    console.error('flow crashed:', err);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
