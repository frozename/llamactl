import {
  createDefaultToolClient,
  defaultCostGuardianConfigPath,
  defaultCostJournalPath,
  loadCostGuardianConfig,
  runCostGuardianTick,
} from '@llamactl/agents';

const USAGE = `llamactl cost-guardian — periodic spend checks with tiered intents

USAGE:
  llamactl cost-guardian tick [--config=<path>] [--journal=<path>] [--skip-journal]

Reads the guardian config (default: ~/.llamactl/cost-guardian.yaml or
\$LLAMACTL_COST_GUARDIAN_CONFIG), calls nova.ops.cost.snapshot to
compute daily + (if configured) weekly spend, runs the pure tier
state machine, journals the decision, and prints it.

This slice is intent-only. Webhook POST, embersynth flip, and
sirius deregister actions land in follow-up slices keyed off the
emitted decision. Tier fires only when pricing YAMLs exist under
~/.llamactl/pricing/ and match the recorded (provider, model) pairs.

FLAGS:
  --config=<path>       Override the config YAML path.
  --journal=<path>      Override the cost journal. Default:
                        \$LLAMACTL_COST_JOURNAL or
                        ~/.llamactl/healer/cost-journal.jsonl.
  --skip-journal        Print the decision without appending to
                        the journal. Useful for on-demand checks.

EXAMPLES:
  llamactl cost-guardian tick
  llamactl cost-guardian tick --config=/etc/cost.yaml --skip-journal
`;

interface TickFlags {
  configPath: string;
  journalPath: string;
  skipJournal: boolean;
}

function parseFlags(argv: string[]): TickFlags | null {
  const flags: TickFlags = {
    configPath: defaultCostGuardianConfigPath(),
    journalPath: defaultCostJournalPath(),
    skipJournal: false,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return null;
    }
    if (arg === '--skip-journal') {
      flags.skipJournal = true;
      continue;
    }
    const eq = arg.indexOf('=');
    if (!arg.startsWith('--') || eq < 0) {
      process.stderr.write(`cost-guardian: unknown arg ${arg}\n\n${USAGE}`);
      return null;
    }
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    switch (key) {
      case 'config':
        flags.configPath = value;
        break;
      case 'journal':
        flags.journalPath = value;
        break;
      default:
        process.stderr.write(`cost-guardian: unknown flag --${key}\n\n${USAGE}`);
        return null;
    }
  }
  return flags;
}

async function runTick(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  if (!flags) return 0;
  let config;
  try {
    config = loadCostGuardianConfig(flags.configPath);
  } catch (err) {
    process.stderr.write(`cost-guardian: invalid config: ${(err as Error).message}\n`);
    return 1;
  }
  const { client, dispose } = await createDefaultToolClient();
  try {
    const decision = await runCostGuardianTick({
      tools: client,
      config,
      journalPath: flags.journalPath,
      skipJournal: flags.skipJournal,
    });
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    return decision.tier === 'noop' ? 0 : 2;
  } finally {
    await dispose();
  }
}

export async function runCostGuardian(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'tick':
      return runTick(rest);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`cost-guardian: unknown subcommand ${sub}\n\n${USAGE}`);
      return 1;
  }
}
