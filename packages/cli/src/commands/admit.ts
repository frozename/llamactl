import { probeNodeMem, projectAdmissionHeadroom } from "@llamactl/fleet-supervisor";
import { spawnSync } from "node:child_process";
import yaml from "yaml";

import { readMeasuredMemoryCache } from "../../../fleet-supervisor/src/measured-memory.js";
import { required } from "../required.js";
import { isRecord } from "../runtime-shape.js";
import { readFileSync } from "../safe-fs.js";
import { runAdmitMeasure } from "./admit-measure.js";

function requireFinite(value: number, flag: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`admit: ${flag} must be a finite non-negative number (got ${String(value)})`);
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

interface AdmitFlags {
  headroomMb: number;
  safetyFactor: number;
  compressorMaxMb: number | undefined;
  emitJson: boolean;
  quiet: boolean;
}

function applyAdmitFlag(raw: string, flags: AdmitFlags): void {
  if (raw === "--json") {
    flags.emitJson = true;
    return;
  }
  if (raw === "--quiet") {
    flags.quiet = true;
    return;
  }
  if (raw.startsWith("--headroom-mb=")) {
    flags.headroomMb = requireFinite(Number(raw.slice("--headroom-mb=".length)), "--headroom-mb");
    return;
  }
  if (raw.startsWith("--safety-factor=")) {
    flags.safetyFactor = requireFinite(
      Number(raw.slice("--safety-factor=".length)),
      "--safety-factor",
    );
    return;
  }
  // alias for back-compat
  if (raw.startsWith("--overhead-factor=")) {
    flags.safetyFactor = requireFinite(
      Number(raw.slice("--overhead-factor=".length)),
      "--overhead-factor",
    );
    return;
  }
  if (raw.startsWith("--compressor-max-mb=")) {
    flags.compressorMaxMb = requireFinite(
      Number(raw.slice("--compressor-max-mb=".length)),
      "--compressor-max-mb",
    );
  }
}

function parseAdmitFlags(args: string[]): AdmitFlags | { error: string } {
  const flags: AdmitFlags = {
    headroomMb: 1024,
    safetyFactor: 1.3,
    compressorMaxMb: undefined,
    emitJson: false,
    quiet: false,
  };
  try {
    for (const raw of args) {
      applyAdmitFlag(raw, flags);
    }
  } catch (err) {
    return { error: (err as Error).message };
  }
  return flags;
}

type AdmitPrintOpts = {
  name: string;
  nodeMem: { free_mb: number; compressor_mb: number };
  expectedMemoryGiB: number;
  result: { allowed: boolean; reason?: string; projectedFreeGiB: number; source: string };
} & AdmitFlags & { measured: { peakMb: number } | null };

function printAdmitJson(opts: AdmitPrintOpts): void {
  const { name, nodeMem, expectedMemoryGiB, result, headroomMb, safetyFactor, measured } = opts;
  process.stdout.write(
    `${JSON.stringify(
      {
        workload: name,
        currentFreeMb: nodeMem.free_mb,
        currentFreeGiB: nodeMem.free_mb / 1024,
        currentCompressorMb: nodeMem.compressor_mb,
        compressorMaxMb: opts.compressorMaxMb ?? null,
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
    )}\n`,
  );
}

function printAdmitQuiet(opts: AdmitPrintOpts): void {
  const { name, result, headroomMb } = opts;
  process.stdout.write(
    `${
      result.allowed
        ? `allow ${name}`
        : `deny ${name} — ${result.reason ?? ""} (projected_free=${result.projectedFreeGiB.toFixed(2)}GiB, min=${(headroomMb / 1024).toFixed(2)}GiB)`
    }\n`,
  );
}

function printAdmitNarrative(opts: AdmitPrintOpts): void {
  const { name, nodeMem, expectedMemoryGiB, result, headroomMb, safetyFactor, measured } = opts;
  const currentFreeGiB = nodeMem.free_mb / 1024;

  process.stdout.write(`workload:          ${name}\n`);
  process.stdout.write(
    `current free:      ${nodeMem.free_mb.toFixed(0)} MiB (${currentFreeGiB.toFixed(2)} GiB)\n`,
  );
  if (opts.compressorMaxMb !== undefined) {
    process.stdout.write(
      `compressor:        ${nodeMem.compressor_mb.toFixed(0)} MiB (max ${String(opts.compressorMaxMb)})\n`,
    );
  }
  if (measured) {
    process.stdout.write(
      `measured peak:     ${measured.peakMb.toFixed(1)} MiB × 1.05 safety = ${((measured.peakMb * 1.05) / 1024).toFixed(2)} GiB  [source: measured]\n`,
    );
  } else {
    process.stdout.write(
      `expected to load:  ${String(expectedMemoryGiB)} GiB × ${String(safetyFactor)} safety = ${(expectedMemoryGiB * safetyFactor).toFixed(2)} GiB  [source: declared]\n`,
    );
  }
  process.stdout.write(`projected free:    ${result.projectedFreeGiB.toFixed(2)} GiB\n`);
  process.stdout.write(`headroom min:      ${(headroomMb / 1024).toFixed(2)} GiB\n`);
  process.stdout.write(`decision:          ${result.allowed ? "ALLOW" : "DENY"}\n`);
  if (!result.allowed) process.stdout.write(`reason:            ${result.reason ?? ""}\n`);
}

function printAdmitResult(opts: AdmitPrintOpts): void {
  if (opts.emitJson) {
    printAdmitJson(opts);
    return;
  }
  if (opts.quiet) {
    printAdmitQuiet(opts);
    return;
  }
  printAdmitNarrative(opts);
}

type AdmitManifest = {
  kind?: string;
  spec?: {
    resources?: { expectedMemoryGiB?: number };
    target?: { value?: string };
    hostedModels?: { rel?: string }[];
  };
  metadata?: { name?: string };
};

function readAdmitManifest(
  path: string,
): { ok: true; manifest: AdmitManifest } | { ok: false; error: string } {
  try {
    const parsedYaml: unknown = yaml.parse(readFileSync(path, "utf8"));
    return { ok: true, manifest: isAdmitManifest(parsedYaml) ? parsedYaml : {} };
  } catch (err) {
    return { ok: false, error: `admit: failed to read ${path}: ${(err as Error).message}` };
  }
}

// Build cache key to look up any prior `llamactl admit measure` result.
function buildAdmitModelKey(manifest: AdmitManifest): string | undefined {
  if (manifest.kind === "ModelRun") {
    const val = manifest.spec?.target?.value;
    return val ? `${val}::` : undefined;
  }
  if (manifest.kind === "ModelHost") {
    const rel = manifest.spec?.hostedModels?.[0]?.rel;
    return rel ? `${rel}::` : undefined;
  }
  return undefined;
}

export async function runAdmit(args: string[]): Promise<number> {
  if (args[0] === "measure") return await runAdmitMeasure(args.slice(1));
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return args.length === 0 ? 2 : 0;
  }
  const target = required(args[0]);
  const parsed = parseAdmitFlags(args.slice(1));
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  const path = target.endsWith(".yaml") ? target : `templates/workloads/${target}.yaml`;
  const read = readAdmitManifest(path);
  if (!read.ok) {
    console.error(read.error);
    return 2;
  }
  const manifest = read.manifest;
  const name = manifest.metadata?.name ?? target;
  const expectedMemoryGiB = manifest.spec?.resources?.expectedMemoryGiB;
  if (typeof expectedMemoryGiB !== "number") {
    console.error(
      `admit: ${name}: spec.resources.expectedMemoryGiB missing — cannot project headroom`,
    );
    return 2;
  }

  const modelKey = buildAdmitModelKey(manifest);
  const measured = modelKey ? readMeasuredMemoryCache(modelKey) : null;

  const nodeMem = await probeNodeMem({
    // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
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
    headroomMinGiB: parsed.headroomMb / 1024,
    safetyFactor: parsed.safetyFactor,
    ...(measured ? { measuredPeakMb: measured.peakMb } : {}),
    ...(parsed.compressorMaxMb !== undefined
      ? { currentCompressorGiB, compressorMaxGiB: parsed.compressorMaxMb / 1024 }
      : {}),
  });

  printAdmitResult({
    name,
    nodeMem,
    expectedMemoryGiB,
    result,
    ...parsed,
    measured,
  });
  return result.allowed ? 0 : 1;
}

function isAdmitManifest(value: unknown): value is AdmitManifest {
  return isRecord(value);
}
