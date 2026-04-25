#!/usr/bin/env node
/**
 * Tier-A shell smoke — command-palette
 *
 * Exercises the command palette end-to-end:
 *   1. ⌘⇧P opens the palette.
 *   2. Typing "log" filters the list to the Logs module row.
 *   3. Enter navigates to Logs (logs-root becomes visible).
 *   4. Reopening and pressing Escape closes without opening a tab.
 *
 * Usage:
 *   node tests/ui-flows/shell/command-palette.ts \
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
            clientInfo: { name: 'command-palette', version: '0.0.1' },
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

// ── Command-palette helpers ────────────────────────────────────────

/**
 * Opens the command palette by dispatching ⌘⇧P on document.
 * Dispatching on document (with bubbles:true) reaches the window
 * listener installed by CommandPaletteMount — the same path as a real
 * keypress.
 */
async function openPalette(client: McpClient, sessionId: string): Promise<void> {
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
}

/**
 * Types text into the palette's controlled input via electron_fill.
 */
async function paletteType(client: McpClient, sessionId: string, text: string): Promise<void> {
  // electron_fill sets the DOM value but doesn't reliably trigger React's
  // controlled-input onChange. Drive the input via the native value setter
  // + an explicit input event — same trick React Testing Library uses.
  await client.call('electron_evaluate_renderer', {
    sessionId,
    expression: `(() => {
      const el = document.querySelector('[data-testid="command-palette-input"]');
      if (!el) throw new Error('command-palette-input missing');
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  });
}

/**
 * Presses Enter inside the palette. The palette's keydown handler
 * listens on window with { capture: true }, so dispatching on the
 * input element is sufficient.
 */
async function paletteConfirm(client: McpClient, sessionId: string): Promise<void> {
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
}

/**
 * Presses Escape. CommandPaletteMount listens on window, so dispatching
 * on document (bubbles:true) is sufficient.
 */
async function paletteEscape(client: McpClient, sessionId: string): Promise<void> {
  await client.call('electron_evaluate_renderer', {
    sessionId,
    expression: `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
    })()`,
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

    // ── Step 1: ⌘⇧P opens the palette ────────────────────────────
    await openPalette(client, sessionId);
    console.log('[PASS] ⌘⇧P → command-palette visible');

    // ── Step 2: type "log" and assert the Logs row is visible ─────
    await paletteType(client, sessionId, 'log');

    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="command-palette-row-go:logs"]',
      state: 'visible',
      timeout: 3_000,
    });
    console.log('[PASS] filter "log" → command-palette-row-go:logs visible');

    // ── Step 3: Enter opens the Logs module ───────────────────────
    await paletteConfirm(client, sessionId);

    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="logs-root"]',
      state: 'visible',
      timeout: 3_000,
    });
    console.log('[PASS] Enter → logs-root visible');

    // ── Step 4: reopen palette, Escape closes without opening a tab
    await openPalette(client, sessionId);
    console.log('[PASS] reopen → command-palette visible');

    await paletteEscape(client, sessionId);

    // Assert the palette is gone (hidden / detached).
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="command-palette"]',
      state: 'hidden',
      timeout: 3_000,
    });
    console.log('[PASS] Escape → command-palette hidden');

    // Logs tab should still be the active view (Escape must not change it).
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="logs-root"]',
      state: 'visible',
      timeout: 3_000,
    });
    console.log('[PASS] Escape did not navigate away from logs-root');

    await client.call('electron_close', { sessionId });
    console.log('command-palette: ok');
  } catch (err) {
    console.error('command-palette FAILED:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
