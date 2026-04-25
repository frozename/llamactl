#!/usr/bin/env node
/**
 * Pilot driver for electron-mcp. Drives a real server over stdio,
 * exercises a realistic sequence (initialize → tools/list → launch
 * a target app → list windows → screenshot → evaluate → close), then
 * walks llamactl's Plan + Cost modules end-to-end and prints a
 * structured report of findings.
 *
 * Usage:
 *   node tests/ui-flows/pilot-driver.ts \
 *     --executable=/path/to/electron \
 *     --args='path/to/main.js' \
 *     --allowlist='/path/**'
 *
 * With no args the driver just smokes the tools/list surface + the
 * validation error envelopes.
 *
 * Invoke manually; see tests/ui-flows/README.md for setup. Requires a
 * built electron-mcp-server checkout pointed at by ELECTRON_MCP_DIR
 * (or ../electron-mcp-server relative to the llamactl repo root).
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type PilotFinding = {
  severity: 'low' | 'medium' | 'high';
  area: string;
  issue: string;
  context: string;
  rootCause?: string;
  suggested?: string;
  reproducibility: 'always' | 'sometimes' | 'once';
  confidence: 'low' | 'medium' | 'high';
};

interface Args {
  executable?: string;
  execArgs: string[];
  allowlist?: string;
  timeoutMs: number;
  env: Record<string, string>;
  userDataDir?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { execArgs: [], timeoutMs: 15_000, env: {} };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--executable=')) out.executable = a.slice('--executable='.length);
    else if (a.startsWith('--args=')) out.execArgs = a.slice('--args='.length).split(' ').filter(Boolean);
    else if (a.startsWith('--allowlist=')) out.allowlist = a.slice('--allowlist='.length);
    else if (a.startsWith('--timeout=')) out.timeoutMs = Number.parseInt(a.slice('--timeout='.length), 10) || 15_000;
    else if (a.startsWith('--env=')) {
      const kv = a.slice('--env='.length);
      const eq = kv.indexOf('=');
      if (eq > 0) out.env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a.startsWith('--userDataDir=')) {
      out.userDataDir = a.slice('--userDataDir='.length);
    }
  }
  return out;
}

class McpClient {
  private seq = 1;
  private pending = new Map<number | string, (res: JsonRpcResponse) => void>();
  constructor(private readonly proc: ChildProcessByStdio<Writable, Readable, null>) {
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
        // skip non-json
      }
    });
  }
  send(method: string, params?: unknown, timeoutMs = 5000): Promise<JsonRpcResponse> {
    const id = this.seq++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }, timeoutMs);
      this.pending.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      this.proc.stdin.write(JSON.stringify(req) + '\n');
    });
  }
  kill(): void {
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
  }
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
  if (!existsSync(serverScript)) {
    console.error(`server script not found: ${serverScript}`);
    console.error(
      'build electron-mcp-server first (`bun run build` inside your checkout),\n' +
        'then point ELECTRON_MCP_DIR at that checkout if it\'s not at ../electron-mcp-server.',
    );
    process.exit(1);
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (args.allowlist) env.ELECTRON_MCP_EXECUTABLE_ALLOWLIST = args.allowlist;
  // Speed up the internal Playwright launch timeout so flakes fail fast.
  env.ELECTRON_MCP_LOG_LEVEL = env.ELECTRON_MCP_LOG_LEVEL ?? 'info';
  // Always run the MCP server under Node, even when the driver is
  // invoked via Bun. Playwright's Electron launch stalls under Bun's
  // runtime (the Node inspector WebSocket handshake never completes),
  // so the server subprocess has to live under Node to unblock
  // `electron.launch()`. The `node` on $PATH is used; callers can
  // override with `MCP_NODE` if they need a specific interpreter.
  const nodeBin = process.env.MCP_NODE ?? 'node';
  const proc = spawn(nodeBin, [serverScript], {
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const client = new McpClient(proc);
  const findings: PilotFinding[] = [];
  let sessionId: string | undefined;

  function log(step: string, detail?: unknown): void {
    console.log(`\x1b[36m[pilot] ${step}\x1b[0m`);
    if (detail !== undefined) console.log('  ' + JSON.stringify(detail, null, 2).replace(/\n/g, '\n  '));
  }

  async function step<T>(label: string, fn: () => Promise<T>, allowFailure = false): Promise<T | null> {
    log(label);
    try {
      const t0 = Date.now();
      const v = await fn();
      const dt = Date.now() - t0;
      log(`${label} done in ${dt}ms`);
      return v;
    } catch (err) {
      log(`${label} FAILED: ${(err as Error).message}`);
      if (!allowFailure) {
        findings.push({
          severity: 'high',
          area: label,
          issue: (err as Error).message,
          context: `${label} threw`,
          reproducibility: 'always',
          confidence: 'high',
        });
      }
      return null;
    }
  }

  try {
    const init = await step('initialize', () =>
      client.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'pilot-driver', version: '0.0.1' },
      }, args.timeoutMs),
    );
    if (init && init.error) {
      findings.push({
        severity: 'high',
        area: 'initialize',
        issue: 'initialize errored',
        context: JSON.stringify(init.error),
        reproducibility: 'always',
        confidence: 'high',
      });
    }

    const tools = await step('tools/list', () => client.send('tools/list'));
    const toolNames =
      tools?.result && typeof tools.result === 'object'
        ? ((tools.result as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name)
        : [];
    log(`tools enumerated (${toolNames.length})`, toolNames);
    if (toolNames.length < 10) {
      findings.push({
        severity: 'medium',
        area: 'tools/list',
        issue: 'fewer than 10 tools exposed — are all handlers registered?',
        context: `got ${toolNames.length}`,
        reproducibility: 'always',
        confidence: 'medium',
      });
    }

    // Validation error smoke: close with no session id.
    const badClose = await step(
      'electron_close with empty sessionId → should return envelope, not throw',
      () => client.send('tools/call', { name: 'electron_close', arguments: { sessionId: '' } }),
      true,
    );
    if (badClose) {
      const text = (badClose.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? '';
      let env: { ok?: boolean; error?: { code?: string } } | null = null;
      try { env = JSON.parse(text); } catch { /* */ }
      if (env?.ok !== false) {
        findings.push({
          severity: 'high',
          area: 'electron_close',
          issue: 'empty sessionId did not return ok:false envelope',
          context: text.slice(0, 200),
          reproducibility: 'always',
          confidence: 'high',
        });
      } else {
        log('  ✓ returned ok:false with code', env.error?.code ?? null);
      }
    }

    // Bogus-path launch → launch_error envelope.
    const bogusLaunch = await step(
      'electron_launch with /does/not/exist → launch_error',
      () =>
        client.send('tools/call', {
          name: 'electron_launch',
          arguments: { executablePath: '/does/not/exist' },
        }),
      true,
    );
    if (bogusLaunch) {
      const text = (bogusLaunch.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? '';
      try {
        const env = JSON.parse(text) as { ok?: boolean; error?: { code?: string; message?: string } };
        if (env.ok !== false) {
          findings.push({
            severity: 'high',
            area: 'electron_launch',
            issue: 'bogus path did not return ok:false',
            context: text.slice(0, 200),
            reproducibility: 'always',
            confidence: 'high',
          });
        }
      } catch {
        findings.push({
          severity: 'medium',
          area: 'electron_launch',
          issue: 'response content was not JSON-parsable',
          context: text.slice(0, 200),
          reproducibility: 'always',
          confidence: 'medium',
        });
      }
    }

    if (args.executable) {
      const launchArgs: Record<string, unknown> = {
        executablePath: args.executable,
        args: args.execArgs,
      };
      if (Object.keys(args.env).length > 0) launchArgs.env = args.env;
      if (args.userDataDir !== undefined) launchArgs.userDataDir = args.userDataDir;
      const launched = await step(
        `electron_launch ${args.executable}`,
        () =>
          client.send(
            'tools/call',
            { name: 'electron_launch', arguments: launchArgs },
            args.timeoutMs,
          ),
      );
      if (launched?.result) {
        const text = (launched.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? '';
        log('launch response body', text);
        try {
          const env = JSON.parse(text) as { ok?: boolean; sessionId?: string };
          if (env.sessionId) {
            sessionId = env.sessionId;
            log(`session ${sessionId}`);
          } else if (env.ok === false) {
            findings.push({
              severity: 'high',
              area: 'electron_launch',
              issue: 'real launch returned ok:false',
              context: text.slice(0, 400),
              reproducibility: 'always',
              confidence: 'high',
            });
          } else {
            findings.push({
              severity: 'medium',
              area: 'electron_launch',
              issue: 'launch response had no sessionId despite no explicit failure',
              context: text.slice(0, 400),
              reproducibility: 'always',
              confidence: 'medium',
            });
          }
        } catch {
          findings.push({
            severity: 'medium',
            area: 'electron_launch',
            issue: 'launch response not json-parsable',
            context: text.slice(0, 200),
            reproducibility: 'always',
            confidence: 'medium',
          });
        }
      }

      if (sessionId) {
        // Wait for the first window — Playwright's electron.launch
        // resolves before the main process has created a window, so
        // list_windows / click / evaluate would all fail with
        // `window_not_found` if called immediately.
        await step('electron_wait_for_window (index 0)', () =>
          client.send(
            'tools/call',
            {
              name: 'electron_wait_for_window',
              arguments: { sessionId, index: 0, timeoutMs: 20_000 },
            },
            25_000,
          ),
        );

        const wins = await step('electron_list_windows', () =>
          client.send('tools/call', {
            name: 'electron_list_windows',
            arguments: { sessionId },
          }),
        );
        log('windows', wins?.result);

        const evalResult = await step('electron_evaluate_renderer: document.title', () =>
          client.send(
            'tools/call',
            {
              name: 'electron_evaluate_renderer',
              arguments: { sessionId, expression: 'document.title' },
            },
            args.timeoutMs,
          ),
        );
        log('title', evalResult?.result);

        // Module walks removed (T14) — bundled Plan/Cost flows now in dedicated flow files.
        // Kept: McpClient primitives, launch setup, window initialization.
        // Kept: electron_close cleanup pattern for session teardown.
        await step(
          'electron_close',
          () =>
            client.send('tools/call', {
              name: 'electron_close',
              arguments: { sessionId },
            }),
          true,
        );
      }
    } else {
      log('(skipping real launch — pass --executable to exercise it)');
    }
  } finally {
    client.kill();
  }

  console.log('\n===== pilot report =====');
  console.log(`findings: ${findings.length}`);
  for (const f of findings) {
    console.log(`  [${f.severity}] ${f.area}: ${f.issue}`);
  }
  if (findings.length === 0) {
    console.log('  no issues surfaced');
  }
  process.exit(findings.some((f) => f.severity === 'high') ? 1 : 0);
}

main().catch((err) => {
  console.error('driver crashed:', err);
  process.exit(2);
});
