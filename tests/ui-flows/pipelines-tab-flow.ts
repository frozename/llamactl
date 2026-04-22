/**
 * R3.b — Pipelines tab flow. Opens Knowledge → Pipelines, asserts
 * the table (or empty-state) renders, exercises the draft-from-
 * description panel end-to-end, and confirms the returned YAML
 * contains the RagPipeline manifest shape.
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
            clientInfo: { name: 'pipelines-tab-flow', version: '0.0.1' },
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

    // Open Knowledge.
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

    // Empty profile still renders the module chrome; we need at least
    // the empty-state OR the RAG-node selector before we can click
    // the Pipelines tab. Tolerate either.
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector:
        '[data-testid="knowledge-empty-state"], [data-testid="knowledge-node-select"]',
      state: 'visible',
      timeout: 8_000,
    });

    // If the module is in empty-state (no rag nodes registered), the
    // Pipelines tab is NOT rendered — we stop here with a pass and
    // skip the wizard-dependent checks. The pipelines-wizard-flow
    // handles the full happy path against a seeded profile.
    const hasRagNode = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelectorAll("[data-testid=\\"knowledge-tab-pipelines\\"]").length',
    })) as { result: number };
    if (hasRagNode.result === 0) {
      check(
        'Pipelines tab is skipped when no rag nodes registered (empty profile)',
        true,
      );
      await client.call('electron_close', { sessionId });
      console.log('PASS — empty-profile fast-path');
      return;
    }

    // Click the Pipelines tab.
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="knowledge-tab-pipelines"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="pipelines-root"]',
      state: 'visible',
      timeout: 5_000,
    });
    check('Pipelines tab root renders', true);

    // Either the pipelines-table (with rows) or the pipelines-empty
    // state renders. We don't care which — both mean the tab is
    // functional and wired to ragPipelineList. Fail only if neither
    // shows up within the window.
    const surfaceCount = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelectorAll("[data-testid=\\"pipelines-table\\"], [data-testid=\\"pipelines-empty\\"]").length',
    })) as { result: number };
    check(
      'pipelines-table or pipelines-empty renders',
      surfaceCount.result >= 1,
      `count=${surfaceCount.result}`,
    );

    // Exercise the draft panel. Opens → reveals description textarea
    // → submit → returns YAML containing the RagPipeline shape.
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="pipelines-draft-open"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="pipelines-draft-panel"]',
      state: 'visible',
      timeout: 5_000,
    });

    await client.call('electron_type', {
      sessionId,
      selector: '[data-testid="pipelines-draft-description"]',
      text: 'crawl https://docs.example.com into kb-pg daily',
    });

    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="pipelines-draft-submit"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="pipelines-draft-yaml"]',
      state: 'visible',
      timeout: 5_000,
    });

    const yaml = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelector("[data-testid=\\"pipelines-draft-yaml\\"]")?.textContent || ""',
    })) as { result: string };
    check(
      'drafted YAML contains RagPipeline shape',
      yaml.result.includes('kind: RagPipeline') && yaml.result.includes('apiVersion: llamactl/v1'),
      `yaml-len=${yaml.result.length}`,
    );
    check(
      'drafted YAML includes the http URL from the description',
      yaml.result.includes('docs.example.com'),
    );
    check(
      'drafted YAML includes the inferred @daily schedule',
      yaml.result.includes('@daily'),
    );

    await client.call('electron_close', { sessionId });
    console.log(
      process.exitCode === 1
        ? 'FAIL — see above'
        : 'PASS — pipelines tab + draft panel flow green',
    );
  } catch (err) {
    console.error('flow crashed:', err);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
