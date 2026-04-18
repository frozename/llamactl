import {
  agentConfig as agentConfigMod,
  bootstrapTokens,
} from '@llamactl/remote';

const USAGE = `llamactl deploy-node — mint a bootstrap token for a new node

USAGE:
  llamactl deploy-node <name> [--central-url=<url>] [--ttl=<minutes>]
  llamactl deploy-node --list
  llamactl deploy-node --prune

Mints a single-use, short-lived token the target host presents to this
control plane when it POSTs /register during the curl-pipe-sh install
flow. Prints a one-liner the operator pastes on the target host.

The plaintext token is shown exactly once — re-run this command if the
target install is delayed past --ttl (default 15 min).

FLAGS:
  --central-url=<url>   URL the target host will reach this control
                        plane at. Defaults to inferring from
                        ~/.llamactl/agent.yaml (if present).
  --ttl=<minutes>       Token lifetime in minutes. Default 15.
  --list                Enumerate outstanding tokens (name, state,
                        expiry). Plaintext never redisplayed.
  --prune               Remove used + expired tokens from disk.
`;

interface DeployFlags {
  name: string;
  centralUrl: string | null;
  ttlMinutes: number;
}

function inferCentralUrl(): string | null {
  try {
    const agent = agentConfigMod.loadAgentConfig();
    return `https://${agent.bindHost}:${agent.port}`;
  } catch {
    return null;
  }
}

function parseFlags(argv: string[]): { mode: 'deploy'; flags: DeployFlags } | { mode: 'list' } | { mode: 'prune' } | null {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(USAGE);
    return null;
  }
  if (argv[0] === '--list') return { mode: 'list' };
  if (argv[0] === '--prune') return { mode: 'prune' };

  const name = argv[0];
  if (!name || name.startsWith('--')) {
    process.stderr.write(`deploy-node: node name is required\n\n${USAGE}`);
    return null;
  }
  const flags: DeployFlags = {
    name,
    centralUrl: null,
    ttlMinutes: 15,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return null;
    }
    const eq = arg.indexOf('=');
    if (!arg.startsWith('--') || eq < 0) {
      process.stderr.write(`deploy-node: unknown arg ${arg}\n\n${USAGE}`);
      return null;
    }
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    switch (key) {
      case 'central-url':
        flags.centralUrl = value;
        break;
      case 'ttl': {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          process.stderr.write(`deploy-node: --ttl must be a positive integer (minutes)\n`);
          return null;
        }
        flags.ttlMinutes = parsed;
        break;
      }
      default:
        process.stderr.write(`deploy-node: unknown flag --${key}\n\n${USAGE}`);
        return null;
    }
  }
  return { mode: 'deploy', flags };
}

function formatList(): void {
  const rows = bootstrapTokens.listBootstrapTokens();
  if (rows.length === 0) {
    process.stdout.write('no outstanding bootstrap tokens\n');
    return;
  }
  const now = new Date();
  for (const { record } of rows) {
    const expired = now > new Date(record.expiresAt);
    const state = record.used ? 'used' : expired ? 'expired' : 'fresh';
    process.stdout.write(
      `${record.nodeName}\t${state}\texpires=${record.expiresAt}\tcentral=${record.centralUrl}\n`,
    );
  }
}

export async function runDeployNode(argv: string[]): Promise<number> {
  const parsed = parseFlags(argv);
  if (!parsed) return 0;

  if (parsed.mode === 'list') {
    formatList();
    return 0;
  }
  if (parsed.mode === 'prune') {
    const removed = bootstrapTokens.pruneBootstrapTokens();
    process.stdout.write(`pruned ${removed} used+expired token(s)\n`);
    return 0;
  }

  const centralUrl = parsed.flags.centralUrl ?? inferCentralUrl();
  if (!centralUrl) {
    process.stderr.write(
      'deploy-node: --central-url is required (could not infer from ~/.llamactl/agent.yaml).\n' +
        'Hint: run `llamactl agent init` on this host first, or pass --central-url=https://<host>:<port>.\n',
    );
    return 1;
  }

  const { token, record } = bootstrapTokens.generateBootstrapToken({
    nodeName: parsed.flags.name,
    centralUrl,
    ttlMs: parsed.flags.ttlMinutes * 60_000,
  });

  const installUrl = `${centralUrl}/install-agent.sh?token=${token}`;
  process.stdout.write(
    `Bootstrap token minted for node '${record.nodeName}'.\n` +
      `Expires: ${record.expiresAt}  (${parsed.flags.ttlMinutes} minute(s))\n` +
      `\n` +
      `On the target host, run:\n` +
      `  curl -fsSL '${installUrl}' | sh\n` +
      `\n` +
      `The token is single-use and never redisplayed — re-run this command if the install is delayed.\n`,
  );
  return 0;
}
