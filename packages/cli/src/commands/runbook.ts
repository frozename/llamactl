import { listRunbooks, runRunbook } from '@llamactl/agents';

const USAGE = `llamactl runbook — operator runbooks that chain MCP tools

USAGE:
  llamactl runbook list
  llamactl runbook run <name> [--dry-run] [--params <json>]

Each runbook is a named, parameterized script. The harness wires it
through @llamactl/mcp in-process, so what runs matches what an MCP
client would see calling the same tools directly.

OPTIONS:
  --dry-run          Pass dryRun:true to every mutation tool — runbook
                     records what it would have done without touching disk.
  --params <json>    Per-runbook parameters as a JSON object.

EXAMPLES:
  llamactl runbook list
  llamactl runbook run promote-fastest-vision-model --dry-run
  llamactl runbook run promote-fastest-vision-model --params '{"profile":"macbook-pro-48g"}'
`;

function parseRunArgs(argv: string[]): {
  name: string;
  dryRun: boolean;
  params: Record<string, unknown>;
} | null {
  const name = argv[0];
  if (!name || name.startsWith('--')) {
    process.stderr.write(`runbook run: name is required\n\n${USAGE}`);
    return null;
  }
  let dryRun = false;
  let params: Record<string, unknown> = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--params') {
      const next = argv[++i];
      if (!next) {
        process.stderr.write('--params requires a JSON value\n');
        return null;
      }
      try {
        const parsed = JSON.parse(next);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          process.stderr.write('--params must be a JSON object\n');
          return null;
        }
        params = parsed as Record<string, unknown>;
      } catch (err) {
        process.stderr.write(`--params: invalid JSON (${(err as Error).message})\n`);
        return null;
      }
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return null;
    } else {
      process.stderr.write(`unknown flag: ${arg}\n\n${USAGE}`);
      return null;
    }
  }
  return { name, dryRun, params };
}

export async function runRunbookCmd(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (sub === 'list') {
    const runbooks = listRunbooks();
    for (const r of runbooks) {
      process.stdout.write(`${r.name}\t${r.description}\n`);
    }
    return 0;
  }
  if (sub === 'run') {
    const parsed = parseRunArgs(argv.slice(1));
    if (!parsed) return 1;
    try {
      const result = await runRunbook(parsed.name, parsed.params, {
        dryRun: parsed.dryRun,
        log: (m) => process.stderr.write(`${m}\n`),
      });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return result.ok ? 0 : 1;
    } catch (err) {
      process.stderr.write(`runbook: ${(err as Error).message}\n`);
      return 1;
    }
  }
  process.stderr.write(`unknown runbook subcommand: ${sub}\n\n${USAGE}`);
  return 1;
}
