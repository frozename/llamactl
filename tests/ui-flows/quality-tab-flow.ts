/**
 * Quality-tab smoke. Opens Knowledge → Quality, asserts the starter
 * button populates a syntactically-plausible RagBench manifest, and
 * confirms the Run button exists + is clickable. Stops short of
 * invoking a real bench — query sets are collection-specific and a
 * clean test profile has no preloaded docs, so an actual run would
 * either fail (no rag node) or succeed with zero hits (both ok from
 * the UI's perspective but noisy in CI).
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
            clientInfo: { name: 'quality-tab-flow', version: '0.0.1' },
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

    // Open Knowledge → Quality. Fast-exit if no rag nodes.
    await client.call('electron_click', {
      sessionId,
      selector: 'button[aria-label="Knowledge"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="knowledge-root"]',
      state: 'visible',
      timeout: 8_000,
    });
    const hasTab = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelectorAll("[data-testid=\\"knowledge-tab-quality\\"]").length',
    })) as { result: number };
    if (hasTab.result === 0) {
      console.log('SKIP — no rag nodes registered; Quality tab requires one.');
      await client.call('electron_close', { sessionId });
      return;
    }

    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="knowledge-tab-quality"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="knowledge-quality-root"]',
      state: 'visible',
      timeout: 5_000,
    });
    check('Quality tab mounts', true);

    // Starter button should populate the YAML with a plausible shape.
    const initial = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelector("[data-testid=\\"knowledge-quality-yaml\\"]")?.value || ""',
    })) as { result: string };
    check(
      'starter YAML is seeded with RagBench shape on mount',
      initial.result.includes('kind: RagBench') &&
        initial.result.includes('apiVersion: llamactl/v1'),
      `yaml-len=${initial.result.length}`,
    );

    // Clearing + clicking "Load starter" should repopulate.
    await client.call('electron_fill', {
      sessionId,
      selector: '[data-testid="knowledge-quality-yaml"]',
      value: '',
    });
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="knowledge-quality-starter"]',
    });
    const reseeded = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelector("[data-testid=\\"knowledge-quality-yaml\\"]")?.value || ""',
    })) as { result: string };
    check(
      'Load starter repopulates the textarea after clearing',
      reseeded.result.includes('kind: RagBench'),
    );

    // Run button exists + is enabled when YAML is non-empty.
    const runBtnDisabled = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelector("[data-testid=\\"knowledge-quality-run\\"]")?.disabled ?? null',
    })) as { result: boolean | null };
    check(
      'Run button is enabled with non-empty YAML',
      runBtnDisabled.result === false,
      `disabled=${String(runBtnDisabled.result)}`,
    );

    await client.call('electron_close', { sessionId });
    console.log(
      process.exitCode === 1
        ? 'FAIL — see above'
        : 'PASS — Quality tab mount + starter + run-ready flow green',
    );
  } catch (err) {
    console.error('flow crashed:', err);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
