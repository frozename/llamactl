import { catalog, env as envMod, hf, quant } from '@llamactl/core';
import type { ModelClass } from '@llamactl/core';

type Format = 'tsv' | 'json';
type Scope = catalog.CatalogScope;

interface ParsedListFlags {
  scope: Scope;
  format: Format;
}

const SCOPES: readonly Scope[] = ['all', 'builtin', 'custom'];

function parseList(args: string[]): ParsedListFlags | { error: string } {
  let scope: Scope = 'all';
  let format: Format = 'tsv';
  let gotPositional = false;

  for (const arg of args) {
    switch (arg) {
      case '--json':
        format = 'json';
        break;
      case '--tsv':
        format = 'tsv';
        break;
      default:
        if (arg.startsWith('--')) {
          return { error: `Unknown flag for catalog list: ${arg}` };
        }
        if (gotPositional) {
          return { error: `Unexpected extra argument: ${arg}` };
        }
        if (!(SCOPES as readonly string[]).includes(arg)) {
          return {
            error: `Unknown scope: ${arg} (expected ${SCOPES.join(' | ')})`,
          };
        }
        scope = arg as Scope;
        gotPositional = true;
        break;
    }
  }

  return { scope, format };
}

async function runList(args: string[]): Promise<number> {
  const parsed = parseList(args);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }

  const entries = catalog.listCatalog(parsed.scope);

  if (parsed.format === 'json') {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return 0;
  }

  // Historical shell output was raw TSV with a trailing newline per row
  // and no final blank line at the end of the block. Match that shape.
  if (entries.length === 0) return 0;
  process.stdout.write(`${catalog.formatCatalogTsv(entries)}\n`);
  return 0;
}

const USAGE = `Usage: llamactl catalog <subcommand>

Subcommands:
  list [all|builtin|custom] [--json|--tsv]
      Print catalog rows. Default scope: all. Default format: tsv.

  status <rel> [--json]
      Inspect a rel: catalog membership, layered class resolution
      (catalog -> HF pipeline -> path pattern), quant, scope, family,
      and whether the file is installed on disk.
`;

interface StatusReport {
  rel: string;
  installed: boolean;
  quant: string;
  catalog: {
    hit: 'builtin' | 'custom' | 'none';
    label: string | null;
    family: string | null;
    scope: string | null;
    repo: string | null;
  };
  class: {
    value: ModelClass;
    source: 'catalog' | 'hf' | 'pattern';
  };
  hf: {
    enabled: boolean;
    repo: string | null;
    pipeline_tag: string | null;
  };
}

function classifyFromPattern(rel: string): ModelClass {
  if (/^gemma-4-/.test(rel) || /^Qwen3\.6-35B-A3B-GGUF\//.test(rel)) return 'multimodal';
  if (/^Qwen3\.5-/.test(rel) || /^DeepSeek-/.test(rel) || /^deepseek-/.test(rel) || /R1/.test(rel)) {
    return 'reasoning';
  }
  return 'general';
}

async function resolveLayeredClass(
  rel: string,
): Promise<{ value: ModelClass; source: StatusReport['class']['source']; repo: string | null; pipeline: string | null; hfEnabled: boolean }> {
  const fromCatalog = catalog.findByRel(rel);
  if (fromCatalog) {
    return {
      value: fromCatalog.class,
      source: 'catalog',
      repo: fromCatalog.repo,
      pipeline: null,
      hfEnabled: hf.hfEnabled(),
    };
  }

  const resolved = envMod.resolveEnv();
  const hfOn = hf.hfEnabled();
  let repo: string | null = null;
  const slash = rel.indexOf('/');
  if (slash > 0) {
    repo = `${resolved.LOCAL_AI_DISCOVERY_AUTHOR}/${rel.slice(0, slash)}`;
  }

  let pipeline: string | null = null;
  if (hfOn && repo) {
    const info = await hf.fetchModelInfo(repo);
    if (info) {
      pipeline = info.pipeline_tag ?? info.pipelineTag ?? null;
      if (pipeline === 'image-text-to-text' || pipeline === 'visual-question-answering' || pipeline === 'image-to-text') {
        return { value: 'multimodal', source: 'hf', repo, pipeline, hfEnabled: hfOn };
      }
    }
  }

  return { value: classifyFromPattern(rel), source: 'pattern', repo, pipeline, hfEnabled: hfOn };
}

async function runStatus(args: string[]): Promise<number> {
  const flags = new Set<string>();
  let rel = '';
  for (const arg of args) {
    if (arg.startsWith('--')) flags.add(arg);
    else if (!rel) rel = arg;
    else {
      process.stderr.write(`Unexpected extra argument: ${arg}\n`);
      return 1;
    }
  }
  if (!rel) {
    process.stderr.write(`Usage: llamactl catalog status <rel> [--json]\n`);
    return 1;
  }

  const resolved = envMod.resolveEnv();
  const installed = (await Bun.file(`${resolved.LLAMA_CPP_MODELS}/${rel}`).exists()) ?? false;
  const entry = catalog.findByRel(rel);
  const klass = await resolveLayeredClass(rel);

  const report: StatusReport = {
    rel,
    installed,
    quant: quant.quantFromRel(rel),
    catalog: entry
      ? {
          hit: catalog.findByRel(rel, { scope: 'builtin' }) ? 'builtin' : 'custom',
          label: entry.label,
          family: entry.family,
          scope: entry.scope,
          repo: entry.repo,
        }
      : { hit: 'none', label: null, family: null, scope: null, repo: null },
    class: { value: klass.value, source: klass.source },
    hf: { enabled: klass.hfEnabled, repo: klass.repo, pipeline_tag: klass.pipeline },
  };

  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  const c = report.catalog;
  process.stdout.write(
    [
      `rel=${report.rel}`,
      `installed=${report.installed ? 'yes' : 'no'}`,
      `quant=${report.quant}`,
      `catalog=${c.hit}`,
      ...(c.hit !== 'none'
        ? [
            `  label=${c.label}`,
            `  family=${c.family}`,
            `  scope=${c.scope}`,
            `  repo=${c.repo}`,
          ]
        : []),
      `class=${report.class.value}`,
      `class_source=${report.class.source}`,
      `hf_enabled=${report.hf.enabled}`,
      ...(report.hf.repo ? [`hf_repo=${report.hf.repo}`] : []),
      ...(report.hf.pipeline_tag ? [`hf_pipeline=${report.hf.pipeline_tag}`] : []),
      '',
    ].join('\n'),
  );
  return 0;
}

export async function runCatalog(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':
      return runList(rest);
    case 'status':
      return runStatus(rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown catalog subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}
