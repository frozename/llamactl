/**
 * Short-lived parent that launches a ModelRun engine through the real
 * core `startServer` and then parks until killed (#806 phase 1).
 *
 * The ModelRun path (`startServer` -> `launchBackground`) is the llama-server
 * the node runs for a plain model target; it detaches the engine the same way
 * the ModelHost path does. Run with `bun <this file> <config-json>`; the
 * config travels as argv, never the environment. The parent records the
 * launch outcome to `resultPath`, then holds its loop open so the test can
 * kill it and confirm the engine survives and is still advertised.
 */

import { startServer } from "../../../core/src/server.js";
import { writeFileSync } from "../../src/safe-fs.js";

interface ParentConfig {
  readonly name: string;
  readonly target: string;
  readonly endpoint: { readonly host: string; readonly port: number };
  readonly timeoutSeconds: number;
  readonly env: NodeJS.ProcessEnv;
  readonly resultPath: string;
}

const raw = process.argv[2];
if (raw === undefined) {
  process.stderr.write("engine-survival-modelrun-parent: missing config argv\n");
  process.exit(2);
}

const config = JSON.parse(raw) as ParentConfig;
let outcome: { ok: boolean; pid: number | null; error: string | null };
try {
  const started = await startServer({
    key: { name: config.name },
    target: config.target,
    endpoint: config.endpoint,
    timeoutSeconds: config.timeoutSeconds,
    skipTuned: true,
    env: config.env,
  });
  outcome = { ok: started.ok, pid: started.pid, error: started.error ?? null };
} catch (error) {
  outcome = { ok: false, pid: null, error: error instanceof Error ? error.message : String(error) };
}

writeFileSync(config.resultPath, JSON.stringify(outcome));

// Hold the loop so the parent lives until the test signals it.
setInterval(() => undefined, 1 << 30);
