/**
 * Phase 4 — Projects module smoke. Opens the activity-bar Projects
 * entry, asserts the module mounts, and exercises the empty-state
 * / list-state branches. The full register → index → open-detail
 * arc against a real agent is covered by the CLI + tRPC unit tests
 * from Phases 1–3; this flow just validates the Electron surface
 * is wired + renders against live data.
 *
 * Invoke manually; see tests/ui-flows/README.md for setup.
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
            clientInfo: { name: 'projects-tab-flow', version: '0.0.1' },
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

    // Navigate to Projects via the command palette (Beacon shell).
    // Inline openPalette / paletteType / paletteConfirm — no import needed.
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
      value: 'Projects',
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
      selector: '[data-testid="projects-root"]',
      state: 'visible',
      timeout: 8_000,
    });
    check('Projects module root renders', true);

    // Either empty state (wraps EditorialHero) or table — both mean the
    // list query resolved.
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="projects-empty"], [data-testid="projects-table"]',
      state: 'visible',
      timeout: 5_000,
    });
    check('projects-empty (EditorialHero) or projects-table renders', true);

    // If the operator has registered at least one project, click the
    // first row's Detail button and confirm the detail card mounts.
    const tableCount = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelectorAll("[data-testid=\\"projects-table\\"]").length',
    })) as { result: number };
    if (tableCount.result > 0) {
      const firstName = (await client.call('electron_evaluate_renderer', {
        sessionId,
        expression:
          'document.querySelector("[data-testid^=\\"projects-row-\\"]")?.getAttribute("data-testid")?.slice("projects-row-".length) || null',
      })) as { result: string | null };
      if (firstName.result) {
        await client.call('electron_click', {
          sessionId,
          selector: `[data-testid="projects-detail-button-${firstName.result}"]`,
        });
        await client.call('electron_wait_for_selector', {
          sessionId,
          selector: `[data-testid="projects-detail-${firstName.result}"]`,
          state: 'visible',
          timeout: 3_000,
        });
        check('detail card mounts for the first project row', true);
        // Close + assert detach.
        await client.call('electron_click', {
          sessionId,
          selector: '[data-testid="projects-detail-close"]',
        });
        await client.call('electron_wait_for_selector', {
          sessionId,
          selector: `[data-testid="projects-detail-${firstName.result}"]`,
          state: 'detached',
          timeout: 3_000,
        });
        check('detail card detaches after close', true);
      }
    } else {
      check('empty-state fast-path (no projects registered)', true);
    }

    await client.call('electron_close', { sessionId });
    console.log(
      process.exitCode === 1
        ? 'FAIL — see above'
        : 'PASS — Projects module mount + list + detail flow green',
    );
  } catch (err) {
    console.error('flow crashed:', err);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
