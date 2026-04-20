import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer as createNetServer, connect as tcpConnect } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rpcServer } from '@llamactl/core';
import { makeCluster, type Cluster } from '../../remote/test/helpers';

/**
 * Phase E.2 — real two-node multinode apply, end-to-end.
 *
 * Scenario: coordinator runs llama-server with `--rpc host:port`
 * pointing at a worker's rpc-server. Both pieces are spawned via the
 * actual remote-router procedures (`workloadApply` on the coordinator,
 * which in turn invokes `rpcServerStart` on the worker through the
 * pinned tRPC client wired by the kubeconfig).
 *
 * Two hard skip gates, both stderr-only:
 *
 *   1. `rpcServer.checkRpcServerAvailable()` — stock llama.cpp builds
 *      do not ship `rpc-server` (it requires `-DGGML_RPC=ON`). We skip
 *      rather than fail since most developer machines lack it. The
 *      apply-time preflight shipped in Slice E.1 also surfaces this
 *      exact reason via `rpcServerDoctor`, but here we check locally
 *      so the describe block never starts in the first place.
 *
 *   2. Local GGUF availability — `llama-server --rpc` still needs a
 *      model file to load. We search `$LLAMA_CPP_MODELS` (the standard
 *      catalog location) and `$LOCAL_AI_RUNTIME_DIR/ai-models/local-ai`
 *      recursively for any `*.gguf`, pick the smallest by file size,
 *      and use its relative path as the ModelRun target. If nothing
 *      is found, the block skips with that reason. We never create a
 *      GGUF on the fly; the test is gated on the developer's real
 *      catalog because generating a valid GGUF fixture is out of scope.
 *
 * Connectivity-only. This test does not assert on token generation,
 * inference correctness, or multi-worker topologies beyond one
 * coordinator + one worker. Those belong to the bench runner and to
 * future slices respectively.
 *
 * Design notes:
 *
 *   - `makeCluster({nodes: 2})` spins up two in-proc agent servers on
 *     OS-assigned HTTPS ports with per-node TLS + tokens + kubeconfig.
 *     Both agents share the one `process.env` since Bun test runs them
 *     in the same Bun process — llama-server.pid and rpc-server.pid
 *     live in distinct files inside the one runtime dir, which is how
 *     the production apply path already coexists them.
 *
 *   - Worker rpc-server port is picked via `net.createServer().listen(0)`
 *     then closed, so the OS guarantees it's free. No hardcoded ports.
 *
 *   - Teardown goes through `workloadDelete` (exercises the real path)
 *     plus a `finally` block that calls `cluster.cleanup()` on any
 *     outcome — assertion failure, timeout, or thrown error — so no
 *     bun-server or spawned binary ever leaks across iterations.
 */

// ---------- skip guards (resolved once per file) --------------------

const rpcCheck = rpcServer.checkRpcServerAvailable();
const ggufPath = findSmallestLocalGguf();

const skipReason: string | null = !rpcCheck.ok
  ? `rpc-server not available: ${rpcCheck.reason ?? 'unknown'} — ${rpcCheck.hint ?? ''}`
  : ggufPath === null
    ? 'no local GGUF found under $LLAMA_CPP_MODELS or $LOCAL_AI_RUNTIME_DIR/ai-models/local-ai'
    : null;

const shouldRun = skipReason === null;

// ---------- helpers -------------------------------------------------

interface GgufHit {
  absPath: string;
  /** Path relative to the models root. Passed to ModelRunSpec.target. */
  rel: string;
  /** Root dir that was the source of this hit; becomes LLAMA_CPP_MODELS. */
  modelsRoot: string;
  size: number;
}

/**
 * Recursively scan candidate model roots for .gguf files and return
 * the smallest by size. Skips quickly when nothing is set. Returns
 * null so the describe block can skip with a clear reason rather than
 * synthesizing a fake GGUF (llama-server would reject a non-GGUF file
 * anyway, so there's no safe short-circuit).
 */
function findSmallestLocalGguf(): GgufHit | null {
  const candidates: string[] = [];
  const cppModels = process.env.LLAMA_CPP_MODELS?.trim();
  if (cppModels) candidates.push(cppModels);
  const runtime = process.env.LOCAL_AI_RUNTIME_DIR?.trim();
  if (runtime) candidates.push(join(runtime, 'ai-models', 'local-ai'));
  // Keep the roots in priority order. The first root with any .gguf
  // wins — we don't merge across roots because the `target` field is
  // resolved against a single models directory.
  for (const root of candidates) {
    let entries: string[];
    try {
      entries = readdirSync(root, { recursive: true }) as string[];
    } catch {
      continue;
    }
    let best: GgufHit | null = null;
    for (const entry of entries) {
      if (!entry.endsWith('.gguf')) continue;
      const abs = join(root, entry);
      let size = 0;
      try {
        size = statSync(abs).size;
      } catch {
        continue;
      }
      if (!best || size < best.size) {
        best = { absPath: abs, rel: entry, modelsRoot: root, size };
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Allocate a TCP port by binding to :0, reading back the OS-assigned
 * port, and releasing immediately. There's a short TOCTOU window, but
 * it's the standard hermetic-test pattern and the worker rpc-server
 * binds in ~ms so the race never surfaces in practice.
 */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error('could not read OS-assigned port'));
      }
    });
  });
}

/**
 * Bounded TCP connect retry. Resolves when a single TCP connect to
 * host:port succeeds; rejects when the deadline elapses. Doubling
 * backoff from 50ms to 500ms cap means at most ~ceil(timeoutMs/500)
 * attempts. No hidden retry loop without a deadline.
 */
function waitForTcpOpen(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 50;
  return new Promise((resolve, reject) => {
    const tryOnce = (): void => {
      const sock = tcpConnect({ host, port, timeout: 500 });
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      const fail = (): void => {
        sock.destroy();
        if (Date.now() >= deadline) {
          reject(
            new Error(
              `waitForTcpOpen(${host}:${port}) timed out after ${timeoutMs}ms`,
            ),
          );
          return;
        }
        setTimeout(tryOnce, delay).unref?.();
        delay = Math.min(delay * 2, 500);
      };
      sock.once('error', fail);
      sock.once('timeout', fail);
    };
    tryOnce();
  });
}

// ---------- shared fixture state ------------------------------------

let cluster: Cluster | null = null;
let tmpRuntime = '';
const originalEnv: NodeJS.ProcessEnv = { ...process.env };

const describeMaybe = shouldRun ? describe : describe.skip;

// ---------- beforeAll / afterAll ------------------------------------

beforeAll(() => {
  if (skipReason !== null) {
    process.stderr.write(`multinode-e2e skipped: ${skipReason}\n`);
  }
});

afterAll(async () => {
  if (cluster) {
    await cluster.cleanup().catch(() => {});
    cluster = null;
  }
  if (tmpRuntime) {
    rmSync(tmpRuntime, { recursive: true, force: true });
    tmpRuntime = '';
  }
  process.env = { ...originalEnv };
});

// ---------- the test ------------------------------------------------

describeMaybe('multinode e2e: coordinator + worker via --rpc', () => {
  test(
    'worker rpc-server binds + coordinator llama-server connects via --rpc',
    async () => {
      // Narrowing — shouldRun === true implies both are non-null, but
      // TS can't see that across the describe boundary.
      if (!ggufPath) throw new Error('unreachable: ggufPath must be set');

      tmpRuntime = mkdtempSync(join(tmpdir(), 'llamactl-multinode-'));
      const runtimeDir = join(tmpRuntime, 'ai-models', 'local-ai');
      const logsDir = join(tmpRuntime, 'logs', 'llama.cpp');
      const workloadsDir = join(tmpRuntime, 'workloads');
      mkdirSync(runtimeDir, { recursive: true });
      mkdirSync(logsDir, { recursive: true });
      mkdirSync(workloadsDir, { recursive: true });

      // Pick ports before starting anything so allocation failures
      // surface before the cluster boots — bounded at pickFreePort's
      // own connect timeout (500ms per attempt) via the OS.
      const coordPort = await pickFreePort();
      const workerPort = await pickFreePort();

      // The remote router resolves env live (resolveEnv(process.env)
      // inside each serverStart / rpcServerStart). Both in-proc agents
      // share the one process.env; setting once here is sufficient.
      // Preserve the existing LLAMA_CPP_BIN since the doctor check
      // has already confirmed rpc-server lives there.
      process.env.DEV_STORAGE = tmpRuntime;
      process.env.LOCAL_AI_RUNTIME_DIR = runtimeDir;
      process.env.LLAMA_CPP_MODELS = ggufPath.modelsRoot;
      process.env.LLAMA_CPP_LOGS = logsDir;
      process.env.LLAMA_CPP_HOST = '127.0.0.1';
      process.env.LLAMA_CPP_PORT = String(coordPort);
      // Skip tuned-profile lookup: would require a seeded bench TSV.
      process.env.LLAMA_CPP_USE_TUNED_ARGS = 'false';

      cluster = await makeCluster({
        nodes: [{ name: 'coord' }, { name: 'worker1' }],
      });

      // The router's `workloadApply` calls `kubecfg.loadConfig()`,
      // which reads $LLAMACTL_CONFIG. Point it at the cluster config
      // makeCluster just wrote so `clientForNode(name)` can resolve
      // every node in the topology.
      process.env.LLAMACTL_CONFIG = cluster.clusterConfigPath;
      process.env.LLAMACTL_WORKLOADS_DIR = workloadsDir;

      const [coord, worker] = cluster.nodes;
      if (!coord || !worker) throw new Error('unreachable: 2 nodes requested');
      // `worker` exists only to assert the topology makeCluster handed
      // back matches what the manifest names; the worker-side calls
      // all flow through the coordinator via `workloadApply` below.
      expect(worker.name).toBe('worker1');

      const manifestYaml = [
        'apiVersion: llamactl/v1',
        'kind: ModelRun',
        'metadata:',
        '  name: e2e-tp-test',
        'spec:',
        '  node: coord',
        '  target:',
        '    kind: rel',
        `    value: ${ggufPath.rel}`,
        '  extraArgs:',
        '    - --host',
        '    - 127.0.0.1',
        '    - --port',
        `    - "${coordPort}"`,
        '  workers:',
        '    - node: worker1',
        '      rpcHost: 127.0.0.1',
        `      rpcPort: ${workerPort}`,
        '      timeoutSeconds: 10',
        '  timeoutSeconds: 20',
        '',
      ].join('\n');

      try {
        // Apply through the coordinator's pinned tRPC client. The
        // router handles worker preflight + rpcServerStart on worker1
        // + serverStart on coord, all in sequence.
        const applyResult = await coord.client.workloadApply.mutate({
          yaml: manifestYaml,
        });
        expect(applyResult.name).toBe('e2e-tp-test');
        expect(applyResult.node).toBe('coord');
        expect(applyResult.status.phase).toBe('Running');

        // Worker rpc-server should be bound on its port. Bounded
        // probe — 5s is a generous ceiling; rpc-server typically
        // binds in <1s once spawned.
        await waitForTcpOpen('127.0.0.1', workerPort, 5_000);

        // Confirm the coordinator llama-server is actually up with
        // the composed flags. We go via `serverStatus.query()` rather
        // than hitting the agent's OpenAI `/v1/models` directly: the
        // tRPC client already has the pinned TLS + bearer, so it's
        // the cheapest way to read back PID + rel + extraArgs in one
        // round-trip (listOpenAIModels reads the same underlying
        // state file, so the signal is equivalent).
        const status = await coord.client.serverStatus.query();
        expect(status.state).toBe('up');
        expect(status.rel).toBe(ggufPath.rel);
        expect(status.pid).toBeGreaterThan(0);
        // The `--rpc host:port` flag the apply path composed should
        // appear in the live server's extraArgs.
        expect(status.extraArgs.join(' ')).toContain(
          `--rpc 127.0.0.1:${workerPort}`,
        );

        // Delete the workload through the same coordinator client.
        // Stops both the coordinator llama-server and the worker
        // rpc-server via `workloadDelete` → `rpcServerStop` reverse.
        const deleteResult = await coord.client.workloadDelete.mutate({
          name: 'e2e-tp-test',
        });
        expect(deleteResult.ok).toBe(true);

        // After delete, the worker rpc-server port must be free.
        // `waitForTcpOpen` rejects on timeout — exactly what we want
        // to assert (the port is NO LONGER open). 2s is enough; the
        // stop path SIGTERM + wait ≤ 3s by default.
        await expect(
          waitForTcpOpen('127.0.0.1', workerPort, 2_000),
        ).rejects.toThrow(/timed out/);
      } finally {
        // Even if any assertion above threw, tear the cluster down so
        // bun:test doesn't hang on dangling servers. `cluster.cleanup`
        // stops both agents and rms their tempdirs.
        if (cluster) {
          await cluster.cleanup().catch(() => {});
          cluster = null;
        }
        // Best-effort kill any still-tracked pids (covers the failed
        // apply case where workloadDelete never ran).
        for (const basename of ['llama-server.pid', 'rpc-server.pid']) {
          const pidFile = join(runtimeDir, basename);
          if (!existsSync(pidFile)) continue;
          try {
            const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
            if (Number.isFinite(pid) && pid > 0) {
              try { process.kill(pid, 'SIGTERM'); } catch {}
            }
          } catch {}
        }
      }
    },
    // Wall-time cap for the whole test. Covers cluster boot (~0.5s),
    // rpc-server spawn + bind (1-2s), llama-server spawn + warm
    // /health on a small GGUF (up to ~20s in pathological cases),
    // and teardown (~1s). Under 30s per the slice budget.
    30_000,
  );
});
