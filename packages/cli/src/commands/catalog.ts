import { catalog } from '@llamactl/core';

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
  list [all|builtin|custom] [--json|--tsv]   Print catalog rows.
                                             Default scope: all. Default format: tsv.
`;

export async function runCatalog(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':
      return runList(rest);
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
