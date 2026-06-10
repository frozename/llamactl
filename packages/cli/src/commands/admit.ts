import { probeNodeMem, projectAdmissionHeadroom } from "@llamactl/fleet-supervisor";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import yaml from "yaml";

import { readMeasuredMemoryCache } from "../../../fleet-supervisor/src/measured-memory.js";
import { runAdmitMeasure } from "./admit-measure.js";

function requireFinite(value: number, flag: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`admit: ${flag} must be a finite non-negative number (got ${value})`);
  }
  return value;
}

const USAGE = `llamactl admit — dry-run predictive admission check for a workload

USAGE:
  llamactl admit <workload-name-or-yaml-path> [flags]

When given a workload name, reads templates/workloads/<name>.yaml.
When given a path ending in .yaml, reads that file directly.

FLAGS:
  --headroom-mb=<n>      Minimum free pages after load. Default 1024 (= 1 GiB).
  --safety-factor=<f>    expectedMemoryGiB multiplier (catches under-reporting
                         in YAML; the 2026-05-22 incident had qwen3-8b yaml=7GB
                         actual=10GB). Default 1.3.
  --compressor-max-mb=<n>  Optional compressor pressure ceiling. When set, denies
                         when current compressor ≥ this (catches the gemma-
                         incident shape: free OK but compressor=2600MB
                         indicates pressure). Default off; pass 2048 to enable.
  --json                 Emit machine-readable JSON result.
  --quiet                Suppress narrative; print just allow/deny + reason.

NOTE: this check is only as accurate as spec.resources.expectedMemoryGiB
in the workload YAML. Underestimates in the YAML → false ALLOW. Bench
the model under real load to calibrate the value if uncertain.

EXIT CODES:
  0 — admission allowed
  1 — admission denied
  2 — usage error / file not found / spec missing expectedMemoryGiB
`;

export async function runAdmit(args: string[]): Promise<number> {
  if (args[0] === "measure") return await runAdmitMeasure(args.slice(1));
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  const target = args[0]!;
  let headroomMb = 1024;
  let safetyFactor = 1.3;
  let compressorMaxMb: number | undefined;
  let emitJson = false;
  let quiet = false;
  try {
    for (const raw of args.slice(1)) {
      if (raw === "--json") {
        emitJson = true;
        continue;
      }
      if (raw === "--quiet") {
        quiet = true;
        continue;
      }
      if (raw.startsWith("--headroom-mb=")) {
        headroomMb = requireFinite(Number(raw.slice("--headroom-mb=".length)), "--headroom-mb");
        continue;
      }
      if (raw.startsWith("--safety-factor=")) {
        safetyFactor = requireFinite(
          Number(raw.slice("--safety-factor=".length)),
          "--safety-factor",
        );
        continue;
      }
      // alias for back-compat
      if (raw.startsWith("--overhead-factor=")) {
        safetyFactor = requireFinite(
          Number(raw.slice("--overhead-factor=".length)),
          "--overhead-factor",
        );
        continue;
      }
      if (raw.startsWith("--compressor-max-mb=")) {
        compressorMaxMb = requireFinite(
          Number(raw.slice("--compressor-max-mb=".length)),
          "--compressor-max-mb",
        );
        continue;
      }
    }
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  const path = target.endsWith(".yaml") ? target : `templates/workloads/${target}.yaml`;
  let manifest: {
    kind?: string;
    spec?: {
      resources?: { expectedMemoryGiB?: number };
      target?: { value?: string };
      hostedModels?: { rel?: string }[];
    };
    metadata?: { name?: string };
  };
  try {
    manifest = yaml.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`admit: failed to read ${path}: ${(err as Error).message}`);
    return 2;
  }
  const name = manifest.metadata?.name ?? target;
  const expectedMemoryGiB = manifest.spec?.resources?.expectedMemoryGiB;
  if (typeof expectedMemoryGiB !== "number") {
    console.error(
      `admit: ${name}: spec.resources.expectedMemoryGiB missing — cannot project headroom`,
    );
    return 2;
  }

  // Build cache key to look up any prior `llamactl admit measure` result.
  let modelKey: string | undefined;
  if (manifest.kind === "ModelRun") {
    const val = manifest.spec?.target?.value;
    if (val) modelKey = `${val}::`;
  } else if (manifest.kind === "ModelHost") {
    const rel = manifest.spec?.hostedModels?.[0]?.rel;
    if (rel) modelKey = `${rel}::`;
  }
  const measured = modelKey ? readMeasuredMemoryCache(modelKey) : null;

  const nodeMem = await probeNodeMem({
    exec: async (cmd) => {
      // Argument-vector exec (no shell). Caller passes 'vm_stat' verbatim;
      // we don't compose shell strings from user input.
      const result = spawnSync(cmd, [], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`exec failed: ${cmd}`);
      return result.stdout;
    },
  });

  const currentFreeGiB = nodeMem.free_mb / 1024;
  const currentCompressorGiB = nodeMem.compressor_mb / 1024;
  const result = projectAdmissionHeadroom({
    currentFreeGiB,
    expectedMemoryGiB,
    headroomMinGiB: headroomMb / 1024,
    safetyFactor,
    ...(measured ? { measuredPeakMb: measured.peakMb } : {}),
    ...(compressorMaxMb !== undefined
      ? { currentCompressorGiB, compressorMaxGiB: compressorMaxMb / 1024 }
      : {}),
  });

  if (emitJson) {
    console.log(
      JSON.stringify(
        {
          workload: name,
          currentFreeMb: nodeMem.free_mb,
          currentFreeGiB,
          currentCompressorMb: nodeMem.compressor_mb,
          compressorMaxMb: compressorMaxMb ?? null,
          expectedMemoryGiB,
          safetyFactor,
          measuredPeakMb: measured?.peakMb ?? null,
          headroomMinMb: headroomMb,
          projectedFreeGiB: result.projectedFreeGiB,
          allowed: result.allowed,
          reason: result.allowed ? null : result.reason,
          source: result.source,
        },
        null,
        2,
      ),
    );
  } else if (quiet) {
    console.log(
      result.allowed
        ? `allow ${name}`
        : `deny ${name} — ${result.reason} (projected_free=${result.projectedFreeGiB.toFixed(2)}GiB, min=${(headroomMb / 1024).toFixed(2)}GiB)`,
    );
  } else {
    console.log(`workload:          ${name}`);
    console.log(
      `current free:      ${nodeMem.free_mb.toFixed(0)} MiB (${currentFreeGiB.toFixed(2)} GiB)`,
    );
    if (compressorMaxMb !== undefined) {
      console.log(
        `compressor:        ${nodeMem.compressor_mb.toFixed(0)} MiB (max ${compressorMaxMb})`,
      );
    }
    if (measured) {
      console.log(
        `measured peak:     ${measured.peakMb.toFixed(1)} MiB × 1.05 safety = ${((measured.peakMb * 1.05) / 1024).toFixed(2)} GiB  [source: measured]`,
      );
    } else {
      console.log(
        `expected to load:  ${expectedMemoryGiB} GiB × ${safetyFactor} safety = ${(expectedMemoryGiB * safetyFactor).toFixed(2)} GiB  [source: declared]`,
      );
    }
    console.log(`projected free:    ${result.projectedFreeGiB.toFixed(2)} GiB`);
    console.log(`headroom min:      ${(headroomMb / 1024).toFixed(2)} GiB`);
    console.log(`decision:          ${result.allowed ? "ALLOW" : "DENY"}`);
    if (!result.allowed) console.log(`reason:            ${result.reason}`);
  }
  return result.allowed ? 0 : 1;
}
