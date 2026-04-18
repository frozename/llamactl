import { config as kubecfg, LOCAL_NODE_ENDPOINT } from '@llamactl/remote';
import { resolveNodeKind } from '@llamactl/remote';
import { stringify as stringifyYaml } from 'yaml';

const USAGE = `llamactl sirius — sirius-gateway integration

USAGE:
  llamactl sirius export  [--format json|yaml|env] [--token-inline]
  llamactl sirius connect <url> [--name <n>] [--api-key-ref <ref>]

export — read the current kubeconfig and emit an entry suitable for
  the sirius gateway's \`LLAMACTL_NODES\` env var (or config file).
  Agent nodes register as sirius providers named \`llamactl-<node>\`;
  cloud nodes are skipped.

  --format <fmt>   json (default), yaml, or env (shell export line).
  --token-inline   include the raw bearer token. By default tokens
                   are placeholders (\`\${LLAMACTL_TOKEN_<NODE>}\`) so
                   the output is safe to paste into git-tracked config.

connect — register a sirius gateway as a cloud node, making every
  model sirius aggregates (openai, anthropic, ollama, llamactl
  agents) appear in llamactl's chat UI. Base URL should point at
  sirius's \`/v1\` root (e.g. \`http://localhost:3000/v1\`).

  --name <n>           Node name for kubeconfig (default: "sirius").
  --api-key-ref <ref>  Env var reference (\`\$FOO\`) or file path.
                       Omit for anonymous sirius (localhost dev).

EXAMPLES:
  llamactl sirius export
  llamactl sirius export --format env --token-inline >> .env.sirius
  llamactl sirius connect http://localhost:3000/v1
  llamactl sirius connect https://sirius.corp/v1 --api-key-ref \\$SIRIUS_TOKEN
`;

interface NodeEntry {
  name: string;
  baseUrl: string;
  apiKey: string;
}

function collectAgentNodes(tokenInline: boolean): NodeEntry[] {
  const cfg = kubecfg.loadConfig();
  const ctx = kubecfg.currentContext(cfg);
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  if (!cluster) return [];
  const user = cfg.users.find((u) => u.name === ctx.user);
  const entries: NodeEntry[] = [];
  for (const node of cluster.nodes) {
    const kind = resolveNodeKind(node);
    if (kind !== 'agent') continue;
    if (node.endpoint === LOCAL_NODE_ENDPOINT) continue; // sirius runs on the control plane, no inproc handoff
    const apiKey = tokenInline && user
      ? tryResolveToken(user)
      : `\${LLAMACTL_TOKEN_${node.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}}`;
    entries.push({
      name: node.name,
      baseUrl: `${node.endpoint.replace(/\/$/, '')}/v1`,
      apiKey,
    });
  }
  return entries;
}

function tryResolveToken(user: { name: string; token?: string; tokenRef?: string }): string {
  try {
    return kubecfg.resolveToken(user);
  } catch (err) {
    return `# ERROR: ${(err as Error).message}`;
  }
}

function renderJson(entries: NodeEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

function renderYaml(entries: NodeEntry[]): string {
  return stringifyYaml({ llamactlNodes: entries });
}

function renderEnv(entries: NodeEntry[]): string {
  const compact = JSON.stringify(entries);
  // Escape single quotes for shell safety.
  return `export LLAMACTL_NODES='${compact.replace(/'/g, "'\\''")}'`;
}

async function runConnect(argv: string[]): Promise<number> {
  const url = argv[0];
  if (!url || url.startsWith('--')) {
    process.stderr.write(`sirius connect: base URL is required\n\n${USAGE}`);
    return 1;
  }
  let name = 'sirius';
  let apiKeyRef: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--name') {
      name = argv[++i] ?? '';
      if (!name) {
        process.stderr.write(`--name requires a value\n`);
        return 1;
      }
    } else if (arg === '--api-key-ref') {
      apiKeyRef = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return 0;
    } else {
      process.stderr.write(`unknown flag: ${arg}\n\n${USAGE}`);
      return 1;
    }
  }
  const normalized = url.endsWith('/') ? url.slice(0, -1) : url;
  const baseUrl = normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
  const cfgPath = kubecfg.defaultConfigPath();
  let cfg = kubecfg.loadConfig(cfgPath);
  const ctx = kubecfg.currentContext(cfg);
  cfg = kubecfg.upsertNode(cfg, ctx.cluster, {
    name,
    endpoint: '',
    kind: 'cloud',
    cloud: {
      provider: 'sirius',
      baseUrl,
      ...(apiKeyRef ? { apiKeyRef } : {}),
    },
  });
  kubecfg.saveConfig(cfg, cfgPath);
  process.stdout.write(
    `registered sirius gateway as node '${name}' → ${baseUrl}\n` +
      `  switch with: llamactl ctx use ${ctx.name} && llamactl --node ${name} ...\n`,
  );
  return 0;
}

export async function runSirius(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (sub === 'connect') {
    return runConnect(argv.slice(1));
  }
  if (sub !== 'export') {
    process.stderr.write(`unknown sirius subcommand: ${sub}\n\n${USAGE}`);
    return 1;
  }
  let format: 'json' | 'yaml' | 'env' = 'json';
  let tokenInline = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--format') {
      const next = argv[++i];
      if (next !== 'json' && next !== 'yaml' && next !== 'env') {
        process.stderr.write(`--format must be json|yaml|env (got ${next ?? ''})\n`);
        return 1;
      }
      format = next;
    } else if (arg === '--token-inline') {
      tokenInline = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return 0;
    } else {
      process.stderr.write(`unknown flag: ${arg}\n\n${USAGE}`);
      return 1;
    }
  }

  const entries = collectAgentNodes(tokenInline);
  if (entries.length === 0) {
    process.stderr.write('no remote agent nodes registered — nothing to export\n');
    return 0;
  }

  const rendered =
    format === 'json' ? renderJson(entries) :
    format === 'yaml' ? renderYaml(entries) :
    renderEnv(entries);
  process.stdout.write(rendered);
  if (!rendered.endsWith('\n')) process.stdout.write('\n');
  return 0;
}
