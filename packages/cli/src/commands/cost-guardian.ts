import {
  createDefaultToolClient,
  defaultCostGuardianConfigPath,
  defaultCostJournalPath,
  loadCostGuardianConfig,
  runCostGuardianTick,
} from '@llamactl/agents';

const USAGE = `llamactl cost-guardian — periodic spend checks with tiered intents

USAGE:
  llamactl cost-guardian tick [--config=<path>] [--journal=<path>]
                              [--skip-journal]
                              [--auto] [--auto-tier-2] [--auto-tier-3]

Reads the guardian config (default: ~/.llamactl/cost-guardian.yaml or
\$LLAMACTL_COST_GUARDIAN_CONFIG), calls nova.ops.cost.snapshot to
compute daily + (if configured) weekly spend, runs the pure tier
state machine, journals the decision, and prints it.

The tier-2 (force-private) and tier-3 (deregister) branches always
journal a dry-run preview. A follow-up wet-run (dryRun:false) is
gated behind an explicit opt-in via \`auto_force_private\` /
\`auto_deregister\` in the config file, or via the \`--auto*\` CLI
flags below (CLI wins when set). Tier-3 additionally honors
\`config.protectedProviders\` — names on that denylist are refused
even when the flag is on, and journaled as \`deregister-refused\`.

FLAGS:
  --config=<path>       Override the config YAML path.
  --journal=<path>      Override the cost journal. Default:
                        \$LLAMACTL_COST_JOURNAL or
                        ~/.llamactl/healer/cost-journal.jsonl.
  --skip-journal        Print the decision without appending to
                        the journal. Useful for on-demand checks.
  --auto                Enable tier-2 AND tier-3 auto wet-runs.
                        Equivalent to --auto-tier-2 --auto-tier-3.
                        CLI flag overrides config file values.
  --auto-tier-2         Override \`auto_force_private\` to true. The
                        tier-2 branch follows every successful
                        dry-run with a wet-run (dryRun:false).
  --auto-tier-3         Override \`auto_deregister\` to true. The
                        tier-3 branch follows every successful
                        dry-run with a wet-run, unless the target
                        provider is on \`protectedProviders\`.

EXAMPLES:
  llamactl cost-guardian tick
  llamactl cost-guardian tick --config=/etc/cost.yaml --skip-journal
  llamactl cost-guardian tick --auto
  llamactl cost-guardian tick --auto-tier-2   # force-private wet, deregister dry-only
`;

interface TickFlags {
  configPath: string;
  journalPath: string;
  skipJournal: boolean;
  autoTier2: boolean;
  autoTier3: boolean;
}

function parseFlags(argv: string[]): TickFlags | null {
  const flags: TickFlags = {
    configPath: defaultCostGuardianConfigPath(),
    journalPath: defaultCostJournalPath(),
    skipJournal: false,
    autoTier2: false,
    autoTier3: false,
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
    if (arg === '--auto') {
      flags.autoTier2 = true;
      flags.autoTier3 = true;
      continue;
    }
    if (arg === '--auto-tier-2') {
      flags.autoTier2 = true;
      continue;
    }
    if (arg === '--auto-tier-3') {
      flags.autoTier3 = true;
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
  // CLI flag overrides — only present flags win over config values.
  // A bare boolean absence means "defer to config" (not "force off").
  if (flags.autoTier2) config = { ...config, auto_force_private: true };
  if (flags.autoTier3) config = { ...config, auto_deregister: true };
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
