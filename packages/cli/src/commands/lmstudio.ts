import { hf, lmstudio } from '@llamactl/core';
import { getGlobals, getNodeClient, isLocalDispatch } from '../dispatcher.js';

const USAGE = `Usage: llamactl lmstudio <subcommand>

Subcommands:
  scan [--root=<dir>] [--json]
      Walk \$LMSTUDIO_MODELS_DIR (or ~/.lmstudio/models) for .gguf
      files and print one row per model. No state changes.

  import [--root=<dir>] [--apply] [--no-link] [--json]
      Preview (default) or materialize an import of LM Studio models
      into the llamactl custom catalog. By default \`--apply\` also
      symlinks each model into \$LLAMA_CPP_MODELS/<rel> so existing
      bench / pull commands find it. \`--no-link\` registers the
      catalog row but leaves the file in place.
`;

function parseImportFlags(args: string[]):
  | { root?: string; apply: boolean; link: boolean; json: boolean }
  | { error: string } {
  let root: string | undefined;
  let apply = false;
  let link = true;
  let json = false;
  for (const arg of args) {
    if (arg === '--apply') apply = true;
    else if (arg === '--no-link') link = false;
    else if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') return { error: 'help' };
    else if (arg.startsWith('--root=')) root = arg.slice('--root='.length);
    else if (arg.startsWith('--')) return { error: `Unknown flag: ${arg}` };
    else return { error: `Unexpected positional: ${arg}` };
  }
  return { root, apply, link, json };
}

async function runScan(args: string[]): Promise<number> {
  let root: string | undefined;
  let json = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return 0;
    } else if (arg.startsWith('--root=')) {
      root = arg.slice('--root='.length);
    } else if (arg.startsWith('--')) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return 1;
    }
  }
  let scan: ReturnType<typeof lmstudio.scanLMStudio>;
  if (isLocalDispatch()) {
    scan = lmstudio.scanLMStudio({ root });
  } else {
    try {
      scan = await getNodeClient().lmstudioScan.query(root ? { root } : undefined) as typeof scan;
    } catch (err) {
      process.stderr.write(`lmstudio scan: remote call to '${getGlobals().nodeName ?? ''}' failed: ${(err as Error).message}\n`);
      return 1;
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
    return scan.models.length > 0 ? 0 : 1;
  }
  if (!scan.root) {
    process.stderr.write('No LM Studio install detected. Pass --root or set LMSTUDIO_MODELS_DIR.\n');
    return 1;
  }
  process.stdout.write(`root=${scan.root} (${scan.models.length} models)\n`);
  for (const m of scan.models) {
    process.stdout.write(
      `  ${m.rel.padEnd(40)} size=${hf.humanSize(m.sizeBytes)} repo=${m.repo} path=${m.path}\n`,
    );
  }
  return scan.models.length > 0 ? 0 : 1;
}

async function runImport(args: string[]): Promise<number> {
  const parsed = parseImportFlags(args);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const { root, apply, link, json } = parsed;

  if (!apply) {
    let plan: ReturnType<typeof lmstudio.planImport>;
    if (isLocalDispatch()) {
      plan = lmstudio.planImport({ root, link });
    } else {
      try {
        const input: { root?: string; link?: boolean } = {};
        if (root !== undefined) input.root = root;
        if (link !== true) input.link = link;
        plan = await getNodeClient().lmstudioPlan.query(Object.keys(input).length > 0 ? input : undefined) as typeof plan;
      } catch (err) {
        process.stderr.write(`lmstudio plan: remote call to '${getGlobals().nodeName ?? ''}' failed: ${(err as Error).message}\n`);
        return 1;
      }
    }
    if (json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return 0;
    }
    if (!plan.root) {
      process.stderr.write('No LM Studio install detected. Pass --root or set LMSTUDIO_MODELS_DIR.\n');
      return 1;
    }
    process.stdout.write(`root=${plan.root} (${plan.items.length} candidates)\n`);
    for (const item of plan.items) {
      const suffix = item.reason ? ` — ${item.reason}` : '';
      process.stdout.write(
        `  ${item.action.padEnd(26)} rel=${item.rel.padEnd(40)} target=${item.targetPath}${suffix}\n`,
      );
    }
    process.stdout.write(`\nRe-run with --apply to make the above changes.\n`);
    return 0;
  }

  let result: Awaited<ReturnType<typeof lmstudio.applyImport>>;
  if (isLocalDispatch()) {
    result = await lmstudio.applyImport({ root, apply: true, link });
  } else {
    try {
      const input: { root?: string; link?: boolean } = {};
      if (root !== undefined) input.root = root;
      if (link !== true) input.link = link;
      result = await getNodeClient().lmstudioImport.mutate(input) as typeof result;
    } catch (err) {
      process.stderr.write(`lmstudio import: remote call to '${getGlobals().nodeName ?? ''}' failed: ${(err as Error).message}\n`);
      return 1;
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.errors.length === 0 ? 0 : 1;
  }
  if (!result.root) {
    process.stderr.write('No LM Studio install detected.\n');
    return 1;
  }
  process.stdout.write(
    `root=${result.root} applied=${result.applied.length} skipped=${result.skipped.length} errors=${result.errors.length}\n`,
  );
  for (const a of result.applied) {
    process.stdout.write(`  ${a.action.padEnd(16)} rel=${a.rel}\n`);
  }
  for (const s of result.skipped) {
    process.stdout.write(`  ${s.action.padEnd(24)} rel=${s.rel} — ${s.reason}\n`);
  }
  for (const err of result.errors) {
    process.stderr.write(`  error rel=${err.rel}: ${err.error}\n`);
  }
  return result.errors.length === 0 ? 0 : 1;
}

export async function runLMStudio(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'scan':
      return runScan(rest);
    case 'import':
      return runImport(rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return sub ? 0 : 1;
    default:
      process.stderr.write(`Unknown lmstudio subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}
