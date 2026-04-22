/**
 * Phase-E E2E smoke — the full "is llamactl alive" arc: wizard →
 * apply → run → running-badge appears → run completes → lastRun
 * badge → remove.
 *
 * Exercises Aliveness A + B + C + D together:
 *   - A: hits the live agent through the real tRPC layer (built
 *        from the current @llamactl/remote sources).
 *   - B: the pulsing running badge appears when
 *        ragPipelineRunning.running[] has the name, disappears
 *        after endRun + retention.
 *   - C: the Query-tab header is exercised implicitly (wizard
 *        uses the same selected rag node); Pipelines tab doesn't
 *        render the header but does reuse the same data.
 *   - D: the wizard + Pipelines tab are the UI surfaces driven.
 *
 * Before launching Electron, pre-creates a tmpdir fixture at
 * /tmp/llamactl-wizard-smoke/ with a one-file markdown tree so
 * the filesystem source has something deterministic to ingest.
 * The pipeline name + collection carry a timestamp so re-running
 * never collides with a prior run's state.json.
 *
 * Side effect: leaves a tiny `wizard_smoke_<ts>` collection in the
 * targeted rag node (chroma/pgvector) after the run. Pipeline
 * spec + journal are removed at the end via the tab's Remove
 * button, but stored documents stay per the documented
 * remove-semantics. Operator can clean manually if needed.
 *
 * Invoke manually; see tests/ui-flows/README.md for setup.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

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
            clientInfo: { name: 'pipelines-apply-run-flow', version: '0.0.1' },
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

async function waitUntil<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs: number,
  pollMs = 500,
): Promise<{ ok: boolean; value: T | null }> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (predicate(last)) return { ok: true, value: last };
    } catch {
      /* treat as false */
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false, value: last };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const here = dirname(fileURLToPath(import.meta.url));
  const serverScript = resolveServerScript(here);

  // --- Fixture: filesystem source the pipeline will ingest. Tiny,
  // deterministic, safe to re-run.
  const fixtureRoot = '/tmp/llamactl-wizard-smoke';
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(
    join(fixtureRoot, 'doc.md'),
    '# Wizard smoke\n\nSingle-paragraph doc so the filesystem fetcher has one chunk to ingest.\n',
    'utf8',
  );

  const ts = Date.now();
  const pipelineName = `wizard-smoke-${ts}`;
  const collectionName = `wizard_smoke_${ts}`;

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

    // Knowledge → Pipelines.
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
        'document.querySelectorAll("[data-testid=\\"knowledge-tab-pipelines\\"]").length',
    })) as { result: number };
    if (hasTab.result === 0) {
      console.log('SKIP — no rag nodes registered; E2E smoke requires one.');
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

    // --- Wizard: fill every required field, apply.
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
    await client.call('electron_fill', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-name"]',
      value: pipelineName,
    });
    await client.call('electron_fill', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-collection"]',
      value: collectionName,
    });
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
    await client.call('electron_fill', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-source-root-0"]',
      value: fixtureRoot,
    });
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
    await client.call('electron_click', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-apply"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="pipeline-wizard-modal"]',
      state: 'detached',
      timeout: 10_000,
    });
    check('wizard closes after Apply', true);

    // Row should appear in the Pipelines table within a polling
    // window (ragPipelineList invalidates on Apply success).
    const rowSelector = `[data-testid="pipelines-row-${pipelineName}"]`;
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: rowSelector,
      state: 'visible',
      timeout: 10_000,
    });
    check('applied pipeline appears in the Pipelines table', true);

    // --- Click Run (wet). Running badge should appear in < 3s
    // (scheduler is not involved; the runtime's startRun fires
    // synchronously after the run-started journal append).
    await client.call('electron_click', {
      sessionId,
      selector: `[data-testid="pipelines-run-${pipelineName}"]`,
    });
    const runningAppeared = await waitUntil(
      async () => {
        const r = (await client.call('electron_evaluate_renderer', {
          sessionId,
          expression: `document.querySelector('[data-testid="pipelines-running-${pipelineName}"]') !== null`,
        })) as { result: boolean };
        return r.result;
      },
      (v) => v === true,
      10_000,
      250,
    );
    check(
      'running badge appears after Run click (Phase B signal live)',
      runningAppeared.ok,
    );

    // --- Wait for the run to complete — running badge goes away
    // and lastRun badge renders instead. Filesystem ingest of one
    // tiny file typically finishes in < 5s end-to-end (chroma
    // embeds internally), but give it 60s to cover cold embedders.
    const runEnded = await waitUntil(
      async () => {
        const r = (await client.call('electron_evaluate_renderer', {
          sessionId,
          expression: `(() => {
            const runningEl = document.querySelector('[data-testid="pipelines-running-${pipelineName}"]');
            const lastRunEl = document.querySelector('[data-testid="pipelines-row-${pipelineName}"] [data-testid^="pipelines-lastrun"]');
            return { running: runningEl !== null, lastRun: lastRunEl !== null };
          })()`,
        })) as { result: { running: boolean; lastRun: boolean } };
        return r.result;
      },
      (v) => v.running === false && v.lastRun === true,
      60_000,
      500,
    );
    check(
      'running badge clears + lastRun badge appears after completion',
      runEnded.ok,
      runEnded.value
        ? `running=${runEnded.value.running} lastRun=${runEnded.value.lastRun}`
        : 'timeout',
    );

    // --- Check that the lastRun badge's summary looks sane. The
    // one-doc filesystem ingest should result in exactly one
    // doc + >= 1 chunk, zero errors. We just assert "ok" (green
    // badge) which the component renders when errors === 0.
    const badgeText = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression: `document.querySelector('[data-testid="pipelines-row-${pipelineName}"] [data-testid^="pipelines-lastrun"]')?.textContent || ''`,
    })) as { result: string };
    check(
      'lastRun badge reports ok (zero errors)',
      badgeText.result.includes('ok'),
      `text=${JSON.stringify(badgeText.result.slice(0, 80))}`,
    );

    // --- Cleanup: click Remove. The component uses window.confirm;
    // flip the dialog policy to accept so the flow doesn't hang.
    await client.call('electron_dialog_policy', {
      sessionId,
      policy: 'accept',
    });
    await client.call('electron_click', {
      sessionId,
      selector: `[data-testid="pipelines-remove-${pipelineName}"]`,
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: rowSelector,
      state: 'detached',
      timeout: 10_000,
    });
    check('Remove detaches the row', true);

    await client.call('electron_close', { sessionId });
    console.log(
      process.exitCode === 1
        ? 'FAIL — see above'
        : 'PASS — full apply → run → running → done → remove arc green',
    );
  } catch (err) {
    console.error('flow crashed:', err);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
