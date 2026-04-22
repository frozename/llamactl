/**
 * R3.c — Pipeline wizard modal flow test. Opens Knowledge →
 * Pipelines → clicks "+ New pipeline" → steps through all four
 * steps and verifies both sides of the validation gate:
 *
 *   1. Empty form → Next-Next-Next lands on Review with errors
 *      surfaced + Apply disabled.
 *   2. Fill name, ragNode, collection, and source-root → Back to
 *      Destination → Next-Next-Next → errors gone + Apply
 *      enabled.
 *
 * Stops short of clicking Apply — applying against a test profile
 * with no real rag node would throw NOT_FOUND noise; the enabled-
 * state of the Apply button is the signal we care about here. The
 * R3.a draft-apply roundtrip + R3.b ragPipelineList ingestion are
 * covered by their own unit/router tests.
 *
 * Requires a test profile with at least one rag node registered
 * so the Pipelines tab is rendered (use LLAMACTL_TEST_PROFILE).
 * See tests/ui-flows/README.md for setup.
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
            clientInfo: { name: 'pipelines-wizard-flow', version: '0.0.1' },
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

    // Open Knowledge → Pipelines. Fast-exit if the profile has no
    // rag nodes (the Pipelines tab only renders when there's at
    // least one to target).
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
    const hasPipelinesTab = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelectorAll("[data-testid=\\"knowledge-tab-pipelines\\"]").length',
    })) as { result: number };
    if (hasPipelinesTab.result === 0) {
      console.log(
        'SKIP — no rag nodes registered in this profile; wizard flow requires one.',
      );
      await client.call('electron_close', { sessionId });
      return;
    }
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

    // Open the wizard.
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="pipelines-new"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-modal"]',
      state: 'visible',
      timeout: 5_000,
    });
    check('wizard modal opens', true);
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-destination"]',
      state: 'visible',
      timeout: 3_000,
    });

    // --- Round 1: advance with empty form, confirm Review flags errors.
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-next"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-sources"]',
      state: 'visible',
      timeout: 3_000,
    });
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-next"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-transforms"]',
      state: 'visible',
      timeout: 3_000,
    });
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-next"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-review"]',
      state: 'visible',
      timeout: 3_000,
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-errors"]',
      state: 'visible',
      timeout: 3_000,
    });
    check('review step surfaces validation errors with empty form', true);

    const applyDisabled = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelector("[data-testid=\\"pipeline-wizard-apply\\"]")?.disabled ?? null',
    })) as { result: boolean | null };
    check(
      'Apply button disabled while errors remain',
      applyDisabled.result === true,
      `disabled=${String(applyDisabled.result)}`,
    );

    // --- Round 2: back to Destination, fill the required fields.
    // Click the stepper button directly to jump back.
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-step-destination"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-destination"]',
      state: 'visible',
      timeout: 3_000,
    });
    await client.call('electron_type', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-name"]',
      text: 'wizard-flow-smoke',
    });
    // The ragnode select already carries the default from the Pipelines
    // tab context; we assert the option is chosen by reading its value.
    const ragNode = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelector("[data-testid=\\"pipeline-wizard-ragnode\\"]")?.value || ""',
    })) as { result: string };
    check(
      'ragNode select pre-populated from Pipelines tab context',
      ragNode.result.length > 0,
      `value=${ragNode.result}`,
    );
    await client.call('electron_type', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-collection"]',
      text: 'smoke_docs',
    });

    // Sources step — fill filesystem root.
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-step-sources"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-source-0"]',
      state: 'visible',
      timeout: 3_000,
    });
    await client.call('electron_type', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-source-root-0"]',
      text: '/tmp/wizard-flow-docs',
    });

    // Jump to Review. Errors div should be gone; Apply enabled.
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-step-review"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-yaml"]',
      state: 'visible',
      timeout: 3_000,
    });
    const errsGone = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelectorAll("[data-testid=\\"pipeline-wizard-errors\\"]").length',
    })) as { result: number };
    check(
      'errors block cleared after fields are filled',
      errsGone.result === 0,
      `errors-count=${errsGone.result}`,
    );
    const applyEnabledNow = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelector("[data-testid=\\"pipeline-wizard-apply\\"]")?.disabled ?? null',
    })) as { result: boolean | null };
    check(
      'Apply button enabled once every required field is set',
      applyEnabledNow.result === false,
      `disabled=${String(applyEnabledNow.result)}`,
    );

    const yaml = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelector("[data-testid=\\"pipeline-wizard-yaml\\"]")?.textContent || ""',
    })) as { result: string };
    check(
      'Review YAML reflects filled form values',
      yaml.result.includes('name: wizard-flow-smoke') &&
        yaml.result.includes('collection: smoke_docs') &&
        yaml.result.includes('/tmp/wizard-flow-docs'),
    );

    // Close without applying.
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-close"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-modal"]',
      state: 'detached',
      timeout: 3_000,
    });
    check('wizard closes cleanly', true);

    await client.call('electron_close', { sessionId });
    console.log(
      process.exitCode === 1
        ? 'FAIL — see above'
        : 'PASS — wizard stepper + validation flow green',
    );
  } catch (err) {
    console.error('flow crashed:', err);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
