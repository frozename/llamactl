import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import yaml from 'yaml';
import { probeNodeMem, projectAdmissionHeadroom } from '@llamactl/fleet-supervisor';

const USAGE = `llamactl admit — dry-run predictive admission check for a workload

USAGE:
  llamactl admit <workload-name-or-yaml-path> [flags]

When given a workload name, reads templates/workloads/<name>.yaml.
When given a path ending in .yaml, reads that file directly.

FLAGS:
  --headroom-mb=<n>      Minimum free pages after load. Default 1024 (= 1 GiB).
  --overhead-factor=<f>  expectedMemoryGiB safety multiplier. Default 1.3.
  --json                 Emit machine-readable JSON result.
  --quiet                Suppress narrative; print just allow/deny + reason.

EXIT CODES:
  0 — admission allowed
  1 — admission denied
  2 — usage error / file not found / spec missing expectedMemoryGiB
`;

export async function runAdmit(args: string[]): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  const target = args[0]!;
  let headroomMb = 1024;
  let overheadFactor = 1.3;
  let emitJson = false;
  let quiet = false;
  for (const raw of args.slice(1)) {
    if (raw === '--json') { emitJson = true; continue; }
    if (raw === '--quiet') { quiet = true; continue; }
    if (raw.startsWith('--headroom-mb=')) { headroomMb = Number(raw.slice('--headroom-mb='.length)); continue; }
    if (raw.startsWith('--overhead-factor=')) { overheadFactor = Number(raw.slice('--overhead-factor='.length)); continue; }
  }

  const path = target.endsWith('.yaml')
    ? target
    : `templates/workloads/${target}.yaml`;
  let manifest: { spec?: { resources?: { expectedMemoryGiB?: number } }; metadata?: { name?: string } };
  try {
    manifest = yaml.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`admit: failed to read ${path}: ${(err as Error).message}`);
    return 2;
  }
  const name = manifest.metadata?.name ?? target;
  const expectedMemoryGiB = manifest.spec?.resources?.expectedMemoryGiB;
  if (typeof expectedMemoryGiB !== 'number') {
    console.error(`admit: ${name}: spec.resources.expectedMemoryGiB missing — cannot project headroom`);
    return 2;
  }

  const nodeMem = await probeNodeMem({ exec: async (cmd) => {
    const result = spawnSync(cmd, { shell: true, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`exec failed: ${cmd}`);
    return result.stdout;
  } });

  const currentFreeGiB = nodeMem.free_mb / 1024;
  const result = projectAdmissionHeadroom({
    currentFreeGiB,
    expectedMemoryGiB,
    headroomMinGiB: headroomMb / 1024,
    safetyFactor: overheadFactor,
  });

  if (emitJson) {
    console.log(JSON.stringify({
      workload: name,
      currentFreeMb: nodeMem.free_mb,
      currentFreeGiB,
      expectedMemoryGiB,
      safetyFactor: overheadFactor,
      headroomMinMb: headroomMb,
      projectedFreeGiB: result.projectedFreeGiB,
      allowed: result.allowed,
      reason: result.allowed ? null : result.reason,
    }, null, 2));
  } else if (quiet) {
    console.log(result.allowed
      ? `allow ${name}`
      : `deny ${name} — ${result.reason} (projected_free=${result.projectedFreeGiB.toFixed(2)}GiB, min=${(headroomMb/1024).toFixed(2)}GiB)`);
  } else {
    console.log(`workload:          ${name}`);
    console.log(`current free:      ${nodeMem.free_mb.toFixed(0)} MiB (${currentFreeGiB.toFixed(2)} GiB)`);
    console.log(`expected to load:  ${expectedMemoryGiB} GiB × ${overheadFactor} safety = ${(expectedMemoryGiB * overheadFactor).toFixed(2)} GiB`);
    console.log(`projected free:    ${result.projectedFreeGiB.toFixed(2)} GiB`);
    console.log(`headroom min:      ${(headroomMb / 1024).toFixed(2)} GiB`);
    console.log(`decision:          ${result.allowed ? 'ALLOW' : 'DENY'}`);
    if (!result.allowed) console.log(`reason:            ${result.reason}`);
  }
  return result.allowed ? 0 : 1;
}
