#!/usr/bin/env node
/**
 * Tier-A shell smoke — error-boundary
 *
 * Sweeps every APP_MODULES entry by opening each one programmatically
 * via window.useTabStore.getState().open(), then asserts that
 * [data-testid="beacon-error-boundary"] is absent from the DOM.
 *
 * Belt-and-suspenders companion to the per-module check in tier-a-modules.ts:
 * if any module throws during render the error boundary catches it and
 * the selector assertion here will fail, surfacing the crash.
 *
 * Usage:
 *   node tests/ui-flows/shell/error-boundary.ts \
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
            clientInfo: { name: 'error-boundary', version: '0.0.1' },
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

// ── Module list (mirrors APP_MODULES ids) ──────────────────────────
//
// Kept as a static list so the test has no compile-time dep on the
// app bundle. Must stay in sync with packages/app/src/modules/registry.ts.

const MODULE_IDS: ReadonlyArray<{ id: string; labelKey: string }> = [
  { id: 'dashboard',             labelKey: 'Dashboard' },
  { id: 'chat',                  labelKey: 'Chat' },
  { id: 'ops-chat',              labelKey: 'Ops Chat' },
  { id: 'plan',                  labelKey: 'Planner' },
  { id: 'projects',              labelKey: 'Projects' },
  { id: 'knowledge.retrieval',   labelKey: 'Retrieval' },
  { id: 'knowledge.pipelines',   labelKey: 'Pipelines' },
  { id: 'workloads',             labelKey: 'Workloads' },
  { id: 'workloads.model-runs',  labelKey: 'Model Runs' },
  { id: 'workloads.composites',  labelKey: 'Composites' },
  { id: 'models.catalog',        labelKey: 'Catalog' },
  { id: 'models.presets',        labelKey: 'Presets' },
  { id: 'models.pulls',          labelKey: 'Pulls' },
  { id: 'models.bench',          labelKey: 'Bench' },
  { id: 'models.lmstudio',       labelKey: 'LM Studio' },
  { id: 'models.server',         labelKey: 'Local Server' },
  { id: 'nodes',                 labelKey: 'Nodes' },
  { id: 'logs',                  labelKey: 'Logs' },
  { id: 'cost',                  labelKey: 'Cost' },
  { id: 'settings',              labelKey: 'Settings' },
  { id: 'ui-primitives',         labelKey: 'UI Primitives' },
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

    // ── Sweep every module tab ─────────────────────────────────────

    for (const mod of MODULE_IDS) {
      await client.call('electron_evaluate_renderer', {
        sessionId,
        expression: [
          `window.useTabStore.getState().open({`,
          `  tabKey: 'module:${mod.id}',`,
          `  title: ${JSON.stringify(mod.labelKey)},`,
          `  kind: 'module',`,
          `  openedAt: Date.now(),`,
          `})`,
        ].join('\n'),
      });
      await sleep(150);
    }

    // ── Assert no error boundary is mounted anywhere ───────────────

    const errorBoundaryPresent = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression: `document.querySelector('[data-testid="beacon-error-boundary"]') !== null`,
    })) as boolean;

    if (errorBoundaryPresent) {
      throw new Error(
        'beacon-error-boundary detected — at least one module crashed during the sweep',
      );
    }

    await client.call('electron_close', { sessionId });
    console.log('error-boundary: ok');
  } catch (err) {
    console.error('error-boundary FAILED:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
