/**
 * K.2 — A/B compare mode flow test. Opens Chat, creates a new
 * conversation, enters compare mode, and asserts both panes exist;
 * then exits compare and confirms pane B is gone.
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
            clientInfo: { name: 'chat-compare-flow', version: '0.0.1' },
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
  // Default: ../../../../electron-mcp-server/dist/server/index.js
  // (from tests/ui-flows up to llamactl root, then sibling repo).
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

    // Navigate to Chat via the command palette (Beacon shell).
    await client.call('electron_evaluate_renderer', {
      sessionId,
      expression: `(() => {
        const e = new KeyboardEvent('keydown', {
          key: 'p',
          code: 'KeyP',
          shiftKey: true,
          metaKey: true,
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(e);
      })()`,
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="command-palette"]',
      state: 'visible',
      timeout: 3_000,
    });
    await client.call('electron_fill', {
      sessionId,
      selector: '[data-testid="command-palette-input"]',
      value: 'Chat',
    });
    await client.call('electron_evaluate_renderer', {
      sessionId,
      expression: `(() => {
        const e = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        const input = document.querySelector('[data-testid="command-palette-input"]');
        const target = input ?? window;
        target.dispatchEvent(e);
      })()`,
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="chat-root"]',
      state: 'visible',
      timeout: 8_000,
    });

    // Empty state → click "New chat". The chat module gates this button
    // behind nodeList.isLoading — without a backend the query never
    // resolves, so the empty state never renders. SKIP gracefully.
    try {
      await client.call('electron_wait_for_selector', {
        sessionId,
        selector: '[data-testid="chat-new"]',
        state: 'visible',
        timeout: 5_000,
      });
    } catch {
      console.log('SKIP — chat-new button not visible (likely nodeList still loading; needs backend).');
      await client.call('electron_close', { sessionId });
      return;
    }
    // Dispatch via DOM click() — electron_click's clickability check has
    // been flaky on the small chat-new button in headless macOS CI.
    await client.call('electron_evaluate_renderer', {
      sessionId,
      expression: `(() => {
        const el = document.querySelector('[data-testid="chat-new"]');
        if (!el) throw new Error('chat-new vanished between wait and click');
        el.click();
      })()`,
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="chat-pane-a"]',
      state: 'visible',
      timeout: 5_000,
    });
    check('pane A visible after New chat', true);

    // Pane B should NOT be rendered yet.
    const before = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression: 'document.querySelectorAll("[data-testid=\\"chat-pane-b\\"]").length',
    })) as { result: number };
    check('pane B absent before compare', before.result === 0, `count=${before.result}`);

    // Enter compare mode. force:true skips Playwright's actionability
    // wait — the headless macOS runner intermittently fails the small-
    // button visibility check. Wrap the assertion in a SKIP path: chat
    // compare-mode requires a configured node + model, which the
    // hermetic profile doesn't provide.
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="chat-compare"]',
      force: true,
    });
    try {
      await client.call('electron_wait_for_selector', {
        sessionId,
        selector: '[data-testid="chat-pane-b"]',
        state: 'visible',
        timeout: 5_000,
      });
    } catch {
      console.log('SKIP — chat-pane-b did not render (likely needs node+model configured).');
      await client.call('electron_close', { sessionId });
      return;
    }
    check('pane B appears after Compare', true);

    // Both panes have their own node/model select plus capability pills.
    const dual = (await client.call('electron_accessibility_snapshot', {
      sessionId,
      root: '[data-testid="chat-root"]',
      interestingOnly: true,
      timeout: 5_000,
    })) as { tree: unknown };
    const serialized = JSON.stringify(dual.tree ?? '');
    const comboBoxCount = (serialized.match(/"combobox"/g) ?? []).length;
    // Expect 4 selects: node+model on each pane.
    check(
      'dual panes expose 4 combobox selects',
      comboBoxCount >= 4,
      `comboboxes=${comboBoxCount}`,
    );

    // Exit compare.
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="chat-compare-exit"]',
      force: true,
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="chat-pane-b"]',
      state: 'detached',
      timeout: 5_000,
    });
    check('pane B removed after Exit compare', true);

    await client.call('electron_close', { sessionId });
    console.log(process.exitCode === 1 ? 'FAIL — see above' : 'PASS — all compare flow checks green');
  } catch (err) {
    console.error('flow crashed:', err);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
