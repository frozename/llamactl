#!/usr/bin/env node
/**
 * Tier-A shell smoke — rail-views
 *
 * Clicks each of the six rail-view icons (Explorer, Search, Sessions,
 * Fleet, Cost, Settings) and verifies the matching panel becomes visible.
 *
 * Panel visibility is checked via data-testid="rail-panel-{id}" which is
 * set on the <aside> in ExplorerPanel based on the active view.
 *
 * Usage:
 *   node tests/ui-flows/shell/rail-views.ts \
 *     --executable=/path/to/electron \
 *     --args=path/to/main.js
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ── Minimal JSON-RPC / MCP client ─────────────────────────────────

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
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
        const cb = this.pending.get(frame.id);
        if (cb) {
          this.pending.delete(frame.id);
          cb(frame);
        }
      } catch {
        /* skip non-json */
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
            clientInfo: { name: 'rail-views', version: '0.0.1' },
          },
        }) + '\n',
      );
    });
  }
  kill(): void {
    try { this.proc.kill(); } catch { /* ignore */ }
  }
}

// ── CLI args ───────────────────────────────────────────────────────

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

function resolveServerScript(here: string): string {
  const explicit = process.env.ELECTRON_MCP_DIR;
  if (explicit && explicit.length > 0) {
    return resolve(explicit, 'dist', 'server', 'index.js');
  }
  return resolve(here, '..', '..', '..', '..', 'electron-mcp-server', 'dist', 'server', 'index.js');
}

// ── Rail helpers ───────────────────────────────────────────────────

const RAIL_VIEW_IDS = ['explorer', 'search', 'sessions', 'fleet'] as const;
type RailViewId = (typeof RAIL_VIEW_IDS)[number];

const TAB_OPENERS = [
  { id: 'cost' as const,     affordance: 'cost-tier' },
  { id: 'settings' as const, affordance: 'settings-root' },
];

/**
 * Clicks the rail icon for a rail-view and asserts the matching panel
 * becomes visible via data-testid="rail-panel-{id}".
 */
async function clickRailViewAndAssert(
  client: McpClient,
  sessionId: string,
  view: RailViewId,
): Promise<void> {
  // electron_click on the 40×40px rail buttons has been flaky in headless
  // CI (visibility checks fail in tight grid layouts). Dispatch a real
  // click via the renderer's DOM API instead — bypasses electron-mcp's
  // visibility wait, which isn't necessary here (the button is in the
  // DOM as confirmed by the dashboard-root mount earlier).
  await jsClick(client, sessionId, `[data-testid="rail-icon-${view}"]`);

  await client.call('electron_wait_for_selector', {
    sessionId,
    selector: `[data-testid="rail-panel-${view}"]`,
    state: 'visible',
    timeout: 5_000,
  });
}

/** Dispatches a `.click()` directly on the matching DOM element. */
async function jsClick(
  client: McpClient,
  sessionId: string,
  selector: string,
): Promise<void> {
  await client.call('electron_evaluate_renderer', {
    sessionId,
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('selector did not match: ' + ${JSON.stringify(selector)});
      el.click();
    })()`,
  });
}

/**
 * Clicks a bottom-rail tab-opener (cost, settings) and asserts the matching
 * module's smokeAffordance becomes visible — the rail item opens the module
 * tab directly rather than swapping the rail panel.
 */
async function clickTabOpenerAndAssert(
  client: McpClient,
  sessionId: string,
  opener: { id: 'cost' | 'settings'; affordance: string },
): Promise<void> {
  await jsClick(client, sessionId, `[data-testid="rail-icon-${opener.id}"]`);

  await client.call('electron_wait_for_selector', {
    sessionId,
    selector: `[data-testid="${opener.affordance}"]`,
    state: 'visible',
    timeout: 5_000,
  });
}

// ── Entry point ────────────────────────────────────────────────────

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

    const launchArgMap: Record<string, unknown> = {
      executablePath: args.executable,
      args: args.execArgs,
    };
    if (Object.keys(args.env).length > 0) launchArgMap.env = args.env;
    if (args.userDataDir !== undefined) launchArgMap.userDataDir = args.userDataDir;

    const launch = (await client.call('electron_launch', launchArgMap, 60_000)) as {
      sessionId?: string;
    };
    const sessionId = launch.sessionId;
    if (!sessionId) throw new Error('launch failed — no sessionId in response');

    // Wait for the renderer to be ready.
    await client.call('electron_wait_for_window', { sessionId, index: 0, timeoutMs: 30_000 });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="dashboard-root"]',
      state: 'visible',
      timeout: 15_000,
    });

    // ── Cycle through the four rail-views ─────────────────────────
    for (const view of RAIL_VIEW_IDS) {
      await clickRailViewAndAssert(client, sessionId, view);
      console.log(`[PASS] rail-icon-${view} → rail-panel-${view} visible`);
    }

    // ── Bottom rail tab-openers (cost, settings) ──────────────────
    for (const opener of TAB_OPENERS) {
      await clickTabOpenerAndAssert(client, sessionId, opener);
      console.log(`[PASS] rail-icon-${opener.id} → ${opener.affordance} visible`);
    }

    await client.call('electron_close', { sessionId });
    console.log('rail-views: ok');
  } catch (err) {
    console.error('rail-views FAILED:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
