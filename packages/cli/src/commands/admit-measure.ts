import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import type { ChildProcess } from "node:child_process";
import yaml from "yaml";
// Relative import so the worktree's measured-memory module is used directly,
// bypassing the node_modules symlink that points at the main checkout.
import { writeMeasuredMemoryCache } from "../../../fleet-supervisor/src/measured-memory.js";
import type { MeasuredMemoryEntry } from "../../../fleet-supervisor/src/measured-memory.js";

const MEASURE_USAGE = `llamactl admit measure — probe real RSS of a workload under load

USAGE:
  llamactl admit measure <workload-name-or-yaml-path> [flags]

Launches the workload on an ephemeral sandbox port, waits for the
server to report healthy, samples RSS over a steady-state window,
then terminates the process and writes the result to
~/.llamactl/measured-memory.json (or \$LLAMACTL_MEASURED_MEMORY_PATH).

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
    function tryPort(p: number) {
      if (p > start + 200) {
        reject(new Error(`No free port found in range ${start}–${start + 200}`));
        return;
      }
      const srv = createServer();
      srv.once("error", () => tryPort(p + 1));
      srv.listen(p, "127.0.0.1", () => srv.close(() => resolve(p)));
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
  throw new Error(`Health check timed out after ${timeoutMs}ms: ${url}`);
}

function sampleRssMb(pid: number): number | null {
  const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  const kb = parseInt((r.stdout ?? "").trim(), 10);
  return Number.isFinite(kb) && kb > 0 ? kb / 1024 : null;
}

/** Remove --port / -p / --host and their values from an extraArgs list. */
function stripPortHost(args: string[]): string[] {
  const PAIR_FLAGS = new Set(["--port", "-p", "--host"]);
  const out: string[] = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
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

export async function runAdmitMeasure(args: string[]): Promise<number> {
  const target = args[0];
  if (!target || target === "--help" || target === "-h") {
    console.log(MEASURE_USAGE);
    return target ? 0 : 2;
  }

  let overridePort: number | undefined;
  let steadyStateSecs = 30;
  let samples = 6;

  for (const raw of args.slice(1)) {
    if (raw.startsWith("--port=")) {
      overridePort = parseInt(raw.slice("--port=".length), 10);
    } else if (raw.startsWith("--steady-state-seconds=")) {
      steadyStateSecs = parseInt(raw.slice("--steady-state-seconds=".length), 10);
    } else if (raw.startsWith("--samples=")) {
      samples = parseInt(raw.slice("--samples=".length), 10);
    }
  }

  const manifestPath = target.endsWith(".yaml") ? target : `templates/workloads/${target}.yaml`;

  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    console.error(`admit measure: cannot read ${manifestPath}: ${(err as Error).message}`);
    return 2;
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
      console.error(`admit measure: unsupported ModelHost engine '${engine ?? "none"}'`);
      return 2;
    }
    engineKind = "oMLX";
    binary = (spec["binary"] as string | undefined) ?? "";
    if (!binary) {
      console.error("admit measure: ModelHost spec.binary is required");
      return 2;
    }
    const hostedModels = (spec["hostedModels"] as Array<Record<string, unknown>> | undefined) ?? [];
    const modelRel = (hostedModels[0]?.["rel"] as string | undefined) ?? "";
    modelKey = `${modelRel}::`;
    const extraArgs = stripPortHost((spec["extraArgs"] as string[] | undefined) ?? []);
    launchArgs = ["serve", modelRel, ...extraArgs];
    healthPath = "/v1/models";
    timeoutSecs = (spec["timeoutSeconds"] as number | undefined) ?? 60;
  } else {
    console.error(`admit measure: unsupported manifest kind '${kind ?? "none"}'`);
    return 2;
  }

  const port = overridePort ?? (await findFreePort(18000));
  const healthUrl = `http://127.0.0.1:${port}${healthPath}`;
  const cmdArgs = [...launchArgs, "--port", String(port), "--host", "127.0.0.1"];

  console.log(`launching: ${binary} ... --port ${port}`);

  const proc = spawn(binary, cmdArgs, { stdio: "ignore", detached: false });
  const pid = proc.pid;
  if (pid === undefined) {
    console.error("admit measure: failed to spawn process (no PID)");
    return 1;
  }

  let exitedEarly = false;
  proc.once("exit", () => {
    exitedEarly = true;
  });

  try {
    console.log(`waiting for health at ${healthUrl} (pid ${pid}, timeout ${timeoutSecs}s)...`);
    await waitForHealth(healthUrl, timeoutSecs * 1000);
  } catch (err) {
    console.error(`admit measure: ${(err as Error).message}`);
    proc.kill("SIGKILL");
    return 1;
  }

  if (exitedEarly) {
    console.error("admit measure: process exited before health check passed");
    return 1;
  }

  console.log(`sampling RSS over ${steadyStateSecs}s (${samples} samples)...`);
  const intervalMs = Math.max(1000, Math.round((steadyStateSecs * 1000) / Math.max(samples, 1)));
  const rssSamples: number[] = [];

  for (let i = 0; i < samples; i++) {
    if (i > 0) await new Promise<void>((r) => setTimeout(r, intervalMs));
    if (exitedEarly) break;
    const rss = sampleRssMb(pid);
    if (rss !== null) rssSamples.push(rss);
  }

  console.log("terminating sandbox...");
  const cleanExit = await killGracefully(proc);
  if (!cleanExit) console.warn("admit measure: process did not exit cleanly (SIGKILL sent)");

  if (rssSamples.length === 0) {
    console.error("admit measure: no RSS samples collected (process may have exited too early)");
    return 1;
  }

  const rssMeanMb = rssSamples.reduce((a, b) => a + b, 0) / rssSamples.length;
  const rssPeakMb = Math.max(...rssSamples);

  const entry: MeasuredMemoryEntry = {
    workloadName,
    measuredAt: new Date().toISOString(),
    rssMeanMb,
    rssPeakMb,
    sampleCount: rssSamples.length,
    engineKind,
    binary,
  };

  writeMeasuredMemoryCache(modelKey, entry);

  const cachePath =
    process.env["LLAMACTL_MEASURED_MEMORY_PATH"] ?? "~/.llamactl/measured-memory.json";
  console.log(`\nmeasured: ${workloadName}`);
  console.log(`  model key:  ${modelKey}`);
  console.log(`  peak RSS:   ${rssPeakMb.toFixed(1)} MiB`);
  console.log(`  mean RSS:   ${rssMeanMb.toFixed(1)} MiB`);
  console.log(`  samples:    ${rssSamples.length}`);
  console.log(`  cached:     ${cachePath}`);
  return 0;
}
