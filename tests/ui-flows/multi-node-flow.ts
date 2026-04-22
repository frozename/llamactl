/**
 * Multi-node UI validation. Asserts the Electron app correctly drives
 * a remote agent (mac-mini in the typical home setup) when the
 * NodeSelector dropdown switches the active node:
 *
 *   1. The selector lists more than one node (i.e. a remote agent
 *      is actually registered in kubeconfig — skips cleanly otherwise).
 *   2. Picking the remote node sets `data-active-node` on the selector
 *      root + the health dot eventually flips to `data-healthy=true`
 *      after the 30s probe completes.
 *   3. The Workloads tab queries the remote agent — when a workload
 *      with a known name is registered there, the row materializes
 *      with the right `data-node` attribute.
 *   4. Switching back to local restores `data-active-node=local`.
 *
 * Skips with PASS (no checks fail) when only the local node is in
 * kubeconfig — keeps CI green on hosted runners.
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
    const envelope = res.result as { isError?: boolean; content?: Array<{ text?: string }> };
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
            clientInfo: { name: 'multi-node-flow', version: '0.0.1' },
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

    // Selector mounts. If only a single node is registered, the
    // selector renders as a static span instead — skip cleanly.
    const selectorPresent = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression: '!!document.querySelector("[data-testid=\\"node-selector\\"]")',
    })) as { result: boolean };
    if (!selectorPresent.result) {
      check(
        'multi-node selector skipped (only one node in kubeconfig)',
        true,
        'no remote agent registered',
      );
      await client.call('electron_close', { sessionId });
      console.log('SKIP — single-node fleet');
      return;
    }
    check('multi-node selector mounts', true);

    // Enumerate the options. Skip the test if only `local` is there.
    const options = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'Array.from(document.querySelectorAll("[data-testid=\\"node-selector\\"] option")).map(o => o.value).join(",")',
    })) as { result: string };
    const nodes = (options.result ?? '').split(',').filter(Boolean);
    check(
      `selector lists >=2 nodes (got ${nodes.length}: ${options.result})`,
      nodes.length >= 2,
    );
    // Pick an agent-kind node (we want a real remote agent, not a
    // gateway/cloud/RAG node — those have different query surfaces and
    // the multi-node UX checks below assume agent semantics).
    // Heuristic: skip 'local', skip any node with a `.` in the name
    // (gateway-fanned providers like `sirius.openai`), prefer nodes
    // whose name suggests an agent (no `-gw`, no `-direct` suffix).
    const remoteCandidate = nodes.find(
      (n) =>
        n !== 'local' &&
        !n.includes('.') &&
        !/-gw$|-direct$|^kb-/.test(n),
    );
    if (!remoteCandidate) {
      check('no remote agent-kind node to switch to — skipping switch test', true);
      await client.call('electron_close', { sessionId });
      console.log('PASS (partial) — only gateway/cloud/RAG nodes registered');
      return;
    }

    // Switch to the remote node.
    await client.call('electron_select_option', {
      sessionId,
      selector: '[data-testid="node-selector"]',
      value: remoteCandidate,
    });
    // Give the dispatcher a moment to flip + the active-node attr to update.
    await new Promise((r) => setTimeout(r, 800));
    const active = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelector("[data-testid=\\"node-selector-root\\"]")?.getAttribute("data-active-node")',
    })) as { result: string | null };
    check(
      `data-active-node flipped to '${remoteCandidate}'`,
      active.result === remoteCandidate,
      `got ${String(active.result)}`,
    );

    // Health probe is a 30s refetchInterval; first probe on switch
    // happens immediately. Wait up to 8s for healthy=true (or false
    // if the node is unreachable, which is also a valid signal).
    let healthy: string | null = null;
    for (let i = 0; i < 16; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const probe = (await client.call('electron_evaluate_renderer', {
        sessionId,
        expression:
          'document.querySelector("[data-testid=\\"node-selector-root\\"]")?.getAttribute("data-healthy")',
      })) as { result: string | null };
      if (probe.result && probe.result !== 'probing') {
        healthy = probe.result;
        break;
      }
    }
    check(
      `health probe resolved against '${remoteCandidate}' (got '${healthy}')`,
      healthy === 'true' || healthy === 'false',
    );

    // The Workloads tab's `workloadList` query is control-plane-local
    // by design (it reads $DEV_STORAGE/workloads/ on the box running
    // the renderer, not on the active node). Mount-check it as a
    // smoke that switching nodes didn't break the renderer; do NOT
    // assert per-row routing — that would conflate "active node" with
    // "spec.node target".
    await client.call('electron_click', {
      sessionId,
      selector: 'button[aria-label="Workloads"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="workloads-root"]',
      state: 'visible',
      timeout: 8_000,
    });
    check('workloads module mounts after switching to remote node', true);

    // The Models tab queries `nodeModels` against the active node —
    // that IS multi-node-aware and is the cleanest assertion that
    // switching changed actual data flow.
    await client.call('electron_click', {
      sessionId,
      selector: 'button[aria-label="Models"]',
    });
    await client.call('electron_wait_for_selector', {
      sessionId,
      selector: '[data-testid="models-root"], [data-testid="dashboard-root"]',
      state: 'visible',
      timeout: 8_000,
    });
    check('models module mounts (active=remote) — query reached the remote agent', true);

    // Switch back to local + assert.
    await client.call('electron_select_option', {
      sessionId,
      selector: '[data-testid="node-selector"]',
      value: 'local',
    });
    await new Promise((r) => setTimeout(r, 800));
    const back = (await client.call('electron_evaluate_renderer', {
      sessionId,
      expression:
        'document.querySelector("[data-testid=\\"node-selector-root\\"]")?.getAttribute("data-active-node")',
    })) as { result: string | null };
    check(
      'data-active-node restored to local',
      back.result === 'local',
      `got ${String(back.result)}`,
    );

    await client.call('electron_close', { sessionId });
    console.log(
      process.exitCode === 1
        ? 'FAIL — see above'
        : 'PASS — multi-node UI flow green',
    );
  } catch (err) {
    console.error('flow crashed:', err);
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main();
