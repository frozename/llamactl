/**
 * Short-lived parent that launches a ModelHost engine through the real
 * `startModelHost` and then parks until killed (#806 phase 1).
 *
 * Run with `bun <this file> <config-json>`. The config is passed as argv,
 * never through the environment, so the survival fixture introduces no new
 * `LLAMACTL_*` variable. The parent spawns the engine detached (its own
 * process group, file stdio), records the launch outcome to `resultPath`,
 * then keeps its event loop alive on an interval. The test kills this parent
 * and asserts the engine — the parent's child, the test's grandchild — is
 * still serving. A plain `Promise` would not hold the loop open, so the
 * interval is what makes "kill the launching parent" observable.
 */

import { atomicWriteFileSync } from "../../src/atomic-write.js";
import { startModelHost } from "../../src/server/modelhost.js";

interface ParentConfig {
  readonly name: string;
  readonly manifest: unknown;
  readonly workloadsDir: string;
  readonly runtimeDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly resultPath: string;
}

const raw = process.argv[2];
if (raw === undefined) {
  process.stderr.write("engine-survival-modelhost-parent: missing config argv\n");
  process.exit(2);
}

const config = JSON.parse(raw) as ParentConfig;
let outcome: { ok: boolean; pid: number | null; error: string | null };
try {
  const started = await startModelHost({
    key: { name: config.name },
    manifest: config.manifest,
    workloadsDir: config.workloadsDir,
    runtimeDir: config.runtimeDir,
    env: config.env,
  });
  outcome = { ok: started.ok, pid: started.pid, error: started.error ?? null };
} catch (error) {
  outcome = { ok: false, pid: null, error: error instanceof Error ? error.message : String(error) };
}

atomicWriteFileSync(config.resultPath, JSON.stringify(outcome));

// Hold the loop so the parent lives until the test signals it. The engine is
// already detached by startModelHost, so killing this process must not take
// it down.
setInterval(() => undefined, 1 << 30);
