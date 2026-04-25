#!/usr/bin/env node
/**
 * Tier-A shell smoke — tab-bar
 *
 * Verifies the tab-store reducer behaviors are correctly wired into the
 * renderer via window.useTabStore.  All mutations are programmatic —
 * no DOM drag-and-drop.
 *
 * Operations exercised (in order):
 *   open × 3  →  move  →  close (fallback assert)  →  pin  →  closeOthers
 *
 * Usage:
 *   node tests/ui-flows/shell/tab-bar.ts \
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
            clientInfo: { name: 'tab-bar', version: '0.0.1' },
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

// ── Store helpers ──────────────────────────────────────────────────

/** Call a void action on window.useTabStore. */
async function storeDispatch(
  client: McpClient,
  sessionId: string,
  js: string,
): Promise<void> {
  await client.call('electron_evaluate_renderer', { sessionId, expression: js });
}

/** Read state from window.useTabStore and return parsed JSON. */
async function storeRead<T>(
  client: McpClient,
  sessionId: string,
  js: string,
): Promise<T> {
  return (await client.call('electron_evaluate_renderer', {
    sessionId,
    expression: `JSON.stringify(${js})`,
  })) as T;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
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

    // Verify window.useTabStore is exposed.
    const storePresent = await storeRead<boolean>(
      client,
      sessionId,
      `typeof window.useTabStore === 'function'`,
    );
    assert(storePresent === true, 'window.useTabStore must be a function');

    // ── Open 3 module tabs ────────────────────────────────────────

    const openTab = (tabKey: string, title: string) =>
      storeDispatch(
        client,
        sessionId,
        `window.useTabStore.getState().open({ tabKey: '${tabKey}', title: '${title}', kind: 'module', openedAt: Date.now() })`,
      );

    await openTab('module:dashboard', 'Dashboard');
    await openTab('module:chat', 'Chat');
    await openTab('module:logs', 'Logs');

    const keysAfterOpen = await storeRead<string[]>(
      client,
      sessionId,
      `window.useTabStore.getState().tabs.map(t => t.tabKey)`,
    );
    assert(
      keysAfterOpen.includes('module:dashboard') &&
        keysAfterOpen.includes('module:chat') &&
        keysAfterOpen.includes('module:logs'),
      `expected all three tabs open, got: ${JSON.stringify(keysAfterOpen)}`,
    );
    console.log('[PASS] open × 3 — tabs present');

    // ── Move chat to index 0 ──────────────────────────────────────

    await storeDispatch(
      client,
      sessionId,
      `window.useTabStore.getState().move('module:chat', 0)`,
    );

    const keysAfterMove = await storeRead<string[]>(
      client,
      sessionId,
      `window.useTabStore.getState().tabs.map(t => t.tabKey)`,
    );
    assert(
      keysAfterMove[0] === 'module:chat' &&
        keysAfterMove[1] === 'module:dashboard' &&
        keysAfterMove[2] === 'module:logs',
      `expected [chat, dashboard, logs], got: ${JSON.stringify(keysAfterMove)}`,
    );
    console.log('[PASS] move — chat at index 0');

    // ── Close dashboard (index 1) — assert right-neighbour fallback ──

    await storeDispatch(
      client,
      sessionId,
      `window.useTabStore.getState().close('module:dashboard')`,
    );

    const activeAfterClose = await storeRead<string | null>(
      client,
      sessionId,
      `window.useTabStore.getState().activeKey`,
    );
    assert(
      activeAfterClose === 'module:logs',
      `expected activeKey === 'module:logs' after closing dashboard, got: ${JSON.stringify(activeAfterClose)}`,
    );
    console.log('[PASS] close — right-neighbour fallback to module:logs');

    // ── Pin chat ──────────────────────────────────────────────────

    await storeDispatch(
      client,
      sessionId,
      `window.useTabStore.getState().pin('module:chat')`,
    );

    const chatTab = await storeRead<{ pinned?: boolean }>(
      client,
      sessionId,
      `window.useTabStore.getState().tabs[0]`,
    );
    assert(
      chatTab.pinned === true,
      `expected tabs[0].pinned === true, got: ${JSON.stringify(chatTab)}`,
    );
    console.log('[PASS] pin — chat pinned at index 0');

    // ── closeOthers keeping logs ──────────────────────────────────

    await storeDispatch(
      client,
      sessionId,
      `window.useTabStore.getState().closeOthers('module:logs')`,
    );

    const keysAfterCloseOthers = await storeRead<string[]>(
      client,
      sessionId,
      `window.useTabStore.getState().tabs.map(t => t.tabKey)`,
    );
    assert(
      keysAfterCloseOthers.includes('module:chat'),
      `expected pinned chat to survive closeOthers, got: ${JSON.stringify(keysAfterCloseOthers)}`,
    );
    assert(
      keysAfterCloseOthers.includes('module:logs'),
      `expected logs to survive closeOthers, got: ${JSON.stringify(keysAfterCloseOthers)}`,
    );

    const activeAfterCloseOthers = await storeRead<string | null>(
      client,
      sessionId,
      `window.useTabStore.getState().activeKey`,
    );
    assert(
      activeAfterCloseOthers === 'module:logs',
      `expected activeKey === 'module:logs' after closeOthers, got: ${JSON.stringify(activeAfterCloseOthers)}`,
    );
    console.log('[PASS] closeOthers — pinned chat + logs survive; activeKey === module:logs');

    await client.call('electron_close', { sessionId });
    console.log('tab-bar: ok');
  } catch (err) {
    console.error('tab-bar FAILED:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
