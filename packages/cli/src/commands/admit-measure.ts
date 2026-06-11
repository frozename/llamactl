import type { ChildProcess } from "node:child_process";

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import yaml from "yaml";

import type { MeasuredMemoryEntry } from "../../../fleet-supervisor/src/measured-memory.js";

// Relative import so the worktree's measured-memory module is used directly,
// bypassing the node_modules symlink that points at the main checkout.
import { writeMeasuredMemoryCache } from "../../../fleet-supervisor/src/measured-memory.js";
import { required } from "../required.js";

const MEASURE_USAGE = `llamactl admit measure — probe real RSS of a workload under load

USAGE:
  llamactl admit measure <workload-name-or-yaml-path> [flags]

Launches the workload on an ephemeral sandbox port, waits for the
server to report healthy, samples RSS over a steady-state window,
then terminates the process and writes the result to
~/.llamactl/measured-memory.json (or $LLAMACTL_MEASURED_MEMORY_PATH).

Future calls to \`llamactl admit\` automatically use the measured peak
instead of spec.resources.expectedMemoryGiB, preventing false ADMITs
caused by hand-maintained YAML underestimates.

FLAGS:
  --port=<n>                  Sandbox port (default: first free port ≥ 18000).
  --steady-state-seconds=<n>  Window over which RSS is sampled (default 30).
  --samples=<n>               RSS samples within the window (default 6).

EXIT CODES:
  0 — measurement complete; cache updated
  1 — launch or health-check failure
  2 — usage / manifest error
`;

function findFreePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    function tryPort(p: number): void {
      if (p > start + 200) {
        reject(new Error(`No free port found in range ${String(start)}–${String(start + 200)}`));
        return;
      }
      const srv = createServer();
      srv.once("error", () => {
        tryPort(p + 1);
      });
      srv.listen(p, "127.0.0.1", () =>
        srv.close(() => {
          resolve(p);
        }),
      );
    }
    tryPort(start);
  });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) return;
    } catch {
      /* retry */
    }
    await new Promise<void>((r) => setTimeout(r, 1000));
  }
  throw new Error(`Health check timed out after ${String(timeoutMs)}ms: ${url}`);
}

function sampleRssMb(pid: number): number | null {
  // spawnSync types stdout as string when an encoding is set, but it is
  // null at runtime when the spawn itself fails — never throw here, or
  // the caller skips killGracefully and leaks the sandbox server.
  const r: { stdout: string | null } = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const kb = parseInt((r.stdout ?? "").trim(), 10);
  return Number.isFinite(kb) && kb > 0 ? kb / 1024 : null;
}

/** Remove --port / -p / --host and their values from an extraArgs list. */
function stripPortHost(args: string[]): string[] {
  const PAIR_FLAGS = new Set(["--port", "-p", "--host"]);
  const out: string[] = [];
  let i = 0;
  while (i < args.length) {
    const a = required(args[i]);
    if (PAIR_FLAGS.has(a)) {
      i += 2;
      continue;
    }
    if (a.startsWith("--port=") || a.startsWith("--host=")) {
      i++;
      continue;
    }
    out.push(a);
    i++;
  }
  return out;
}

function killGracefully(proc: ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(false);
    }, 10_000);
    proc.on("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
    proc.kill("SIGTERM");
  });
}

interface LaunchConfig {
  engineKind: "llama.cpp" | "oMLX";
  binary: string;
  launchArgs: string[];
  modelKey: string;
  healthPath: string;
  timeoutSecs: number;
  workloadName: string;
}

function readLaunchConfig(target: string, manifestPath: string): LaunchConfig | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    return { error: `admit measure: cannot read ${manifestPath}: ${(err as Error).message}` };
  }

  const m = yaml.parse(raw) as Record<string, unknown>;
  const kind = m["kind"] as string | undefined;
  const spec = (m["spec"] ?? {}) as Record<string, unknown>;
  const meta = (m["metadata"] ?? {}) as Record<string, unknown>;
  const workloadName = (meta["name"] as string | undefined) ?? target;

  let engineKind: "llama.cpp" | "oMLX";
  let binary: string;
  let launchArgs: string[];
  let modelKey: string;
  let healthPath: string;
  let timeoutSecs: number;

  if (kind === "ModelRun") {
    engineKind = "llama.cpp";
    binary = (spec["binary"] as string | undefined) ?? "llama-server";
    const targetSpec = (spec["target"] ?? {}) as Record<string, unknown>;
    const modelRel = (targetSpec["value"] as string | undefined) ?? "";
    const modelsDir = process.env["LLAMA_CPP_MODELS"] ?? "";
    const resolvedModel = modelsDir ? `${modelsDir}/${modelRel}` : modelRel;
    modelKey = `${modelRel}::`;
    const extraArgs = stripPortHost((spec["extraArgs"] as string[] | undefined) ?? []);
    launchArgs = ["--model", resolvedModel, ...extraArgs];
    healthPath = "/health";
    timeoutSecs = (spec["timeoutSeconds"] as number | undefined) ?? 60;
  } else if (kind === "ModelHost") {
    const engine = spec["engine"] as string | undefined;
    if (engine !== "omlx") {
      return { error: `admit measure: unsupported ModelHost engine '${engine ?? "none"}'` };
    }
    engineKind = "oMLX";
    binary = (spec["binary"] as string | undefined) ?? "";
    if (!binary) {
      return { error: "admit measure: ModelHost spec.binary is required" };
    }
    const hostedModels = (spec["hostedModels"] as Record<string, unknown>[] | undefined) ?? [];
    const modelRel = (hostedModels[0]?.["rel"] as string | undefined) ?? "";
    modelKey = `${modelRel}::`;
    const extraArgs = stripPortHost((spec["extraArgs"] as string[] | undefined) ?? []);
    launchArgs = ["serve", modelRel, ...extraArgs];
    healthPath = "/v1/models";
    timeoutSecs = (spec["timeoutSeconds"] as number | undefined) ?? 60;
  } else {
    return { error: `admit measure: unsupported manifest kind '${kind ?? "none"}'` };
  }

  return { engineKind, binary, launchArgs, modelKey, healthPath, timeoutSecs, workloadName };
}

interface MeasureFlags {
  overridePort: number | undefined;
  steadyStateSecs: number;
  samples: number;
}

function parseMeasureFlags(args: string[]): MeasureFlags {
  let overridePort: number | undefined;
  let steadyStateSecs = 30;
  let samples = 6;

  for (const raw of args) {
    if (raw.startsWith("--port=")) {
      overridePort = parseInt(raw.slice("--port=".length), 10);
    } else if (raw.startsWith("--steady-state-seconds=")) {
      steadyStateSecs = parseInt(raw.slice("--steady-state-seconds=".length), 10);
    } else if (raw.startsWith("--samples=")) {
      samples = parseInt(raw.slice("--samples=".length), 10);
    }
  }

  return { overridePort, steadyStateSecs, samples };
}

async function awaitSandboxHealth(
  proc: ChildProcess,
  pid: number,
  healthUrl: string,
  timeoutSecs: number,
): Promise<boolean> {
  try {
    process.stdout.write(
      `waiting for health at ${healthUrl} (pid ${String(pid)}, timeout ${String(timeoutSecs)}s)...\n`,
    );
    await waitForHealth(healthUrl, timeoutSecs * 1000);
    return true;
  } catch (err) {
    console.error(`admit measure: ${(err as Error).message}`);
    proc.kill("SIGKILL");
    return false;
  }
}

async function collectRssSamples(
  pid: number,
  samples: number,
  intervalMs: number,
  hasExitedEarly: () => boolean,
): Promise<number[]> {
  const rssSamples: number[] = [];
  for (let i = 0; i < samples; i++) {
    if (i > 0) await new Promise<void>((r) => setTimeout(r, intervalMs));
    if (hasExitedEarly()) break;
    const rss = sampleRssMb(pid);
    if (rss !== null) rssSamples.push(rss);
  }
  return rssSamples;
}

export async function runAdmitMeasure(args: string[]): Promise<number> {
  const target = args[0];
  if (!target || target === "--help" || target === "-h") {
    process.stdout.write(`${MEASURE_USAGE}\n`);
    return target ? 0 : 2;
  }

  const { overridePort, steadyStateSecs, samples } = parseMeasureFlags(args.slice(1));

  const manifestPath = target.endsWith(".yaml") ? target : `templates/workloads/${target}.yaml`;
  const config = readLaunchConfig(target, manifestPath);
  if ("error" in config) {
    console.error(config.error);
    return 2;
  }

  const port = overridePort ?? (await findFreePort(18000));
  const healthUrl = `http://127.0.0.1:${String(port)}${config.healthPath}`;
  const cmdArgs = [...config.launchArgs, "--port", String(port), "--host", "127.0.0.1"];

  process.stdout.write(`launching: ${config.binary} ... --port ${String(port)}\n`);

  const proc = spawn(config.binary, cmdArgs, { stdio: "ignore", detached: false });
  const pid = proc.pid;
  if (pid === undefined) {
    console.error("admit measure: failed to spawn process (no PID)");
    return 1;
  }

  const exitedEarly = { value: false };
  proc.once("exit", () => {
    exitedEarly.value = true;
  });
  const hasExitedEarly = (): boolean => exitedEarly.value;

  const healthy = await awaitSandboxHealth(proc, pid, healthUrl, config.timeoutSecs);
  if (!healthy) return 1;

  if (exitedEarly.value) {
    console.error("admit measure: process exited before health check passed");
    return 1;
  }

  process.stdout.write(
    `sampling RSS over ${String(steadyStateSecs)}s (${String(samples)} samples)...\n`,
  );
  const intervalMs = Math.max(1000, Math.round((steadyStateSecs * 1000) / Math.max(samples, 1)));
  const rssSamples = await collectRssSamples(pid, samples, intervalMs, hasExitedEarly);

  process.stdout.write("terminating sandbox...\n");
  const cleanExit = await killGracefully(proc);
  if (!cleanExit) console.warn("admit measure: process did not exit cleanly (SIGKILL sent)");

  if (rssSamples.length === 0) {
    console.error("admit measure: no RSS samples collected (process may have exited too early)");
    return 1;
  }

  const rssMeanMb = rssSamples.reduce((a, b) => a + b, 0) / rssSamples.length;
  const rssPeakMb = Math.max(...rssSamples);

  const entry: MeasuredMemoryEntry = {
    workloadName: config.workloadName,
    measuredAt: new Date().toISOString(),
    rssMeanMb,
    rssPeakMb,
    sampleCount: rssSamples.length,
    engineKind: config.engineKind,
    binary: config.binary,
  };

  writeMeasuredMemoryCache(config.modelKey, entry);

  const cachePath =
    process.env["LLAMACTL_MEASURED_MEMORY_PATH"] ?? "~/.llamactl/measured-memory.json";
  process.stdout.write(`\nmeasured: ${config.workloadName}\n`);
  process.stdout.write(`  model key:  ${config.modelKey}\n`);
  process.stdout.write(`  peak RSS:   ${rssPeakMb.toFixed(1)} MiB\n`);
  process.stdout.write(`  mean RSS:   ${rssMeanMb.toFixed(1)} MiB\n`);
  process.stdout.write(`  samples:    ${String(rssSamples.length)}\n`);
  process.stdout.write(`  cached:     ${cachePath}\n`);
  return 0;
}
