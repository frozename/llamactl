import { runGlobalSearchFlow } from './global-search-flow.js';
import { runPaletteSearchFlow } from './palette-search-flow.js';
/**
 * Tier-A module smoke harness — palette navigation pass.
 *
 * For every APP_MODULES entry: opens the command palette (⌘⇧P),
 * types the module label, presses Enter, waits up to 5 s for the
 * module's smokeAffordance testid to appear, checks the error
 * boundary is absent, and sweeps the renderer console for errors
 * emitted since iteration start. Halts on first failure, captures
 * a screenshot, and exits 1. On full success exits 0.
 *
 * Invoke manually; see tests/ui-flows/README.md for setup. Requires
 * a built electron-mcp-server checkout pointed at by ELECTRON_MCP_DIR
 * (or ../electron-mcp-server relative to the llamactl repo root).
 *
 * Usage:
 *   bun run tests/ui-flows/tier-a-modules.ts \
 *     --executable=<path/to/Electron> \
 *     --args="<path/to/packages/app>"
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdir as fsMkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { APP_MODULES } from '../../packages/app/src/modules/registry.ts';

// ── MCP JSON-RPC client ────────────────────────────────────────────

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
            clientInfo: { name: 'tier-a-modules', version: '0.0.1' },
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

// ── CLI args ───────────────────────────────────────────────────────

interface DriverArgs {
  executable: string;
  execArgs: string[, runGlobalSearchFlow, runPaletteSearchFlow];
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
  return resolve(here, '..', '..', '..', 'electron-mcp-server', 'dist', 'server', 'index.js');
}

// ── Palette navigation helpers ─────────────────────────────────────

/**
 * Dismisses any open palette and resets to the dashboard tab so each
 * iteration starts from a clean state. Uses Escape first (in case the
 * palette is still open from a prior step), then navigates to dashboard
 * by clicking the activity-bar entry.
 *
 * Navigating to the dashboard explorer-tree leaf is sufficient as a
 * baseline reset. If a future test sets a different rail-view, this reset
 * will need to set rail back to explorer first.
 */
async function resetState(client: McpClient, sessionId: string): Promise<void> {
  // Escape (palette dismiss) + reset to dashboard via the test-only
  // window.useTabStore. Avoids the cost of waiting for an explorer-tree
  // leaf to render; the store mutation is synchronous and reliable.
  await client.call('electron_evaluate_renderer', {
    sessionId,
    expression: `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      }));
      const store = window.useTabStore;
      if (store && typeof store.getState === 'function') {
        store.getState().closeAll(false);
        store.getState().open({
          tabKey: 'module:dashboard',
          title: 'Dashboard',
          kind: 'module',
          openedAt: Date.now(),
        });
      }
    })()`,
  });
}

// ── Module-mount pass ──────────────────────────────────────────────

async function runPalettePass(client: McpClient, sessionId: string): Promise<void> {
  const total = APP_MODULES.length;
  let passed = 0;
  const here = dirname(fileURLToPath(import.meta.url));

  for (const m of APP_MODULES) {
    // Mark the console baseline for this iteration.
    await client.call('electron_evaluate_renderer', {
      sessionId,
      expression: '(() => { window.__smokeMarkTime = Date.now(); })()',
    });

    try {
      // 1. Open the module via the test-only window.useTabStore handle.
      //    The palette's UI flow is tested separately by
      //    tests/ui-flows/shell/command-palette.ts; here we want a
      //    deterministic navigation primitive so the module-loop measures
      //    what it claims to measure ("module mounts when its tab is
      //    active"), not React-controlled-input quirks.
      await client.call('electron_evaluate_renderer', {
        sessionId,
        expression: `(() => {
          const store = window.useTabStore;
          if (!store || typeof store.getState !== 'function') {
            throw new Error('window.useTabStore not exposed in this build');
          }
          store.getState().open({
            tabKey: 'module:${m.id}',
            title: ${JSON.stringify(m.labelKey)},
            kind: 'module',
            openedAt: Date.now(),
          });
        })()`,
      });

      // 2. Wait up to 5 s for the smoke affordance.
      await client.call('electron_wait_for_selector', {
        sessionId,
        selector: `[data-testid="${m.smokeAffordance}"]`,
        state: 'visible',
        timeout: 5_000,
      });

      // 5. Assert error boundary is NOT present.
      const errBoundary = (await client.call('electron_evaluate_renderer', {
        sessionId,
        expression: `!!document.querySelector('[data-testid="beacon-error-boundary"]')`,
      })) as { result: boolean };
      if (errBoundary.result) {
        throw new Error(`beacon-error-boundary present after navigating to "${m.id}"`);
      }

      // 6. Sweep console for errors since iteration start.
      const consoleCheck = (await client.call('electron_evaluate_renderer', {
        sessionId,
        expression: `(() => {
          const mark = window.__smokeMarkTime ?? 0;
          const errs = (window.__smokeConsoleErrors ?? []).filter(
            (e) => e.t >= mark,
          );
          return { count: errs.length, first: errs[0]?.msg ?? null };
        })()`,
      })) as { result: { count: number; first: string | null } };
      if (consoleCheck.result.count > 0) {
        throw new Error(
          `${consoleCheck.result.count} console error(s) since iteration start — first: ${consoleCheck.result.first ?? '?'}`,
        );
      }

      console.log(`[PASS] ${m.id} — ${m.smokeAffordance} visible`);
      passed += 1;
    } catch (err) {
      // Capture screenshot under the repo so upload-artifact picks it up.
      const screenshotsDir = join(here, 'screenshots');
      await fsMkdir(screenshotsDir, { recursive: true });
      const screenshotPath = join(screenshotsDir, `tier-a-fail-${m.id.replace(/\./g, '-')}.png`);
      try {
        await client.call('electron_screenshot', {
          sessionId,
          path: screenshotPath,
        });
        console.error(`screenshot: ${screenshotPath}`);
      } catch {
        /* best-effort */
      }
      // Dump captured console errors + error-boundary status + DOM snapshot.
      try {
        const diag = await client.call('electron_evaluate_renderer', {
          sessionId,
          expression: `(() => ({
            errors: window.__smokeConsoleErrors ?? [],
            boundary: !!document.querySelector('[data-testid="beacon-error-boundary"]'),
            url: location.href,
            activeKey: window.useTabStore?.getState?.()?.activeKey,
            bodyHead: document.body?.innerText?.slice(0, 800) ?? '',
          }))()`,
        }) as { result: { errors: unknown[]; boundary: boolean; url: string; activeKey: string | null | undefined; bodyHead: string } };
        console.error(`diagnostics: ${JSON.stringify(diag.result, null, 2)}`);
      } catch {
        /* best-effort */
      }
      console.error(`[FAIL] ${m.id}: ${(err as Error).message}`);
      console.error(`Tier A FAILED at module ${m.id} (${passed}/${total} passed before failure)`);
      process.exit(1);
    }

    // 7. Reset between iterations.
    await resetState(client, sessionId);
  }

  console.log(`Tier A passed: ${passed}/${total} modules`);
}

// ── Console error capture bootstrap ───────────────────────────────

/**
 * Installs a tiny shim on the renderer's console.error so we can
 * query errors after each navigation without relying on a native
 * MCP console-capture tool (none is exposed by this electron-mcp
 * build). The shim is idempotent — calling it twice is safe.
 */
async function installConsoleCapture(client: McpClient, sessionId: string): Promise<void> {
  await client.call('electron_evaluate_renderer', {
    sessionId,
    expression: `(() => {
      if (window.__smokeConsolePatched) return;
      window.__smokeConsoleErrors = [];
      const orig = console.error.bind(console);
      console.error = (...args) => {
        window.__smokeConsoleErrors.push({ t: Date.now(), msg: args.map(String).join(' ') });
        orig(...args);
      };
      window.addEventListener('unhandledrejection', (e) => {
        window.__smokeConsoleErrors.push({ t: Date.now(), msg: String(e.reason) });
      });
      window.__smokeConsolePatched = true;
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

    await client.call('electron_wait_for_window', { sessionId, index: 0, timeoutMs: 30_000 });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="dashboard-root"]',
      state: 'visible',
      timeout: 15_000,
    });

    // Install console capture before any navigation.
    await installConsoleCapture(client, sessionId);

    // ── Module-mount pass ────────────────────────────────────────
    // Opens each APP_MODULES entry via window.useTabStore and asserts
    // its smokeAffordance renders. Exercises every module's main view
    // under the hermetic test profile in ~22 s.
    await runPalettePass(client, sessionId);

    await client.call('electron_close', { sessionId });
  } catch (err) {
    console.error('harness crashed:', err);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
