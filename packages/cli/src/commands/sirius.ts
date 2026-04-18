import {
  config as kubecfg,
  LOCAL_NODE_ENDPOINT,
  resolveNodeKind,
  siriusProviders,
} from '@llamactl/remote';
import { stringify as stringifyYaml } from 'yaml';

const USAGE = `llamactl sirius — sirius-gateway integration

USAGE:
  llamactl sirius export            [--format json|yaml|env] [--token-inline]
  llamactl sirius connect <url>     [--name <n>] [--api-key-ref <ref>]
  llamactl sirius add-provider <kind> [--name <n>] [--api-key-ref <ref>]
                                       [--base-url <url>]
  llamactl sirius list-providers    [--format json|yaml]
  llamactl sirius remove-provider <name>

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

add-provider — register an AI provider with sirius. Stored in
  ~/.llamactl/sirius-providers.yaml; sirius reads this file at boot
  (via the \`@sirius/provider-fromfile\` module pointed at
  LLAMACTL_PROVIDERS_FILE). Kinds: openai, anthropic, together,
  groq, mistral, openai-compatible.

  --name <n>           Provider name sirius exposes (default: <kind>).
  --api-key-ref <ref>  Env var (\`\$FOO\`) or file path. Required for
                       named providers; optional for openai-compatible.
  --base-url <url>     Override the default (required for
                       openai-compatible).

list-providers — show all providers registered with sirius.
  --format <fmt>       json (default) or yaml.

remove-provider <name> — unregister a provider by name.

EXAMPLES:
  llamactl sirius export
  llamactl sirius export --format env --token-inline >> .env.sirius
  llamactl sirius connect http://localhost:3000/v1
  llamactl sirius connect https://sirius.corp/v1 --api-key-ref \\$SIRIUS_TOKEN
  llamactl sirius add-provider openai --api-key-ref \\$OPENAI_API_KEY
  llamactl sirius add-provider anthropic --api-key-ref ~/.llamactl/keys/anthropic
  llamactl sirius add-provider openai-compatible --name vllm \\
      --base-url http://gpu.lan:8000/v1 --api-key-ref \\$VLLM_KEY
  llamactl sirius list-providers
  llamactl sirius remove-provider openai
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
    // Sirius is a gateway (fans out to many providers), not a cloud
    // provider per se. `kind: 'gateway'` lets the UI render the right
    // badge and future gateway-specific features (routing insight,
    // per-provider health) light up only for these nodes.
    kind: 'gateway',
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

async function runAddProvider(argv: string[]): Promise<number> {
  const kind = argv[0];
  if (!kind || kind.startsWith('--')) {
    process.stderr.write(`sirius add-provider: kind is required\n\n${USAGE}`);
    return 1;
  }
  const validKinds: ReadonlyArray<string> = [
    'openai',
    'anthropic',
    'together',
    'groq',
    'mistral',
    'openai-compatible',
  ];
  if (!validKinds.includes(kind)) {
    process.stderr.write(`unknown provider kind: ${kind}\nvalid: ${validKinds.join(', ')}\n`);
    return 1;
  }
  let name = kind;
  let apiKeyRef: string | undefined;
  let baseUrl: string | undefined;
  let displayName: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--name') name = argv[++i] ?? name;
    else if (arg === '--api-key-ref') apiKeyRef = argv[++i];
    else if (arg === '--base-url') baseUrl = argv[++i];
    else if (arg === '--display-name') displayName = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return 0;
    } else {
      process.stderr.write(`unknown flag: ${arg}\n`);
      return 1;
    }
  }
  if (!baseUrl) {
    baseUrl = siriusProviders.SIRIUS_PROVIDER_DEFAULT_BASE_URLS[
      kind as siriusProviders.SiriusProviderKind
    ];
  }
  if (!baseUrl) {
    process.stderr.write(`--base-url is required for ${kind}\n`);
    return 1;
  }
  if (kind !== 'openai-compatible' && !apiKeyRef) {
    process.stderr.write(`--api-key-ref is required for ${kind}\n`);
    return 1;
  }
  const path = siriusProviders.defaultSiriusProvidersPath();
  const existing = siriusProviders.loadSiriusProviders(path);
  const entry: siriusProviders.SiriusProvider = {
    name,
    kind: kind as siriusProviders.SiriusProviderKind,
    baseUrl,
    ...(apiKeyRef ? { apiKeyRef } : {}),
    ...(displayName ? { displayName } : {}),
  };
  const next = siriusProviders.upsertSiriusProvider(existing, entry);
  siriusProviders.saveSiriusProviders(next, path);
  process.stdout.write(
    `registered sirius provider '${name}' (${kind} → ${baseUrl})\n` +
      `  stored in ${path}\n` +
      `  restart sirius with LLAMACTL_PROVIDERS_FILE=${path} to pick it up.\n`,
  );
  return 0;
}

async function runListProviders(argv: string[]): Promise<number> {
  let format: 'json' | 'yaml' = 'json';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--format') {
      const next = argv[++i];
      if (next !== 'json' && next !== 'yaml') {
        process.stderr.write(`--format must be json|yaml\n`);
        return 1;
      }
      format = next;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return 0;
    } else {
      process.stderr.write(`unknown flag: ${arg}\n`);
      return 1;
    }
  }
  const providers = siriusProviders.loadSiriusProviders();
  const rendered =
    format === 'json'
      ? JSON.stringify(providers, null, 2)
      : stringifyYaml({ providers });
  process.stdout.write(rendered);
  if (!rendered.endsWith('\n')) process.stdout.write('\n');
  return 0;
}

async function runRemoveProvider(argv: string[]): Promise<number> {
  const name = argv[0];
  if (!name) {
    process.stderr.write(`sirius remove-provider: name is required\n`);
    return 1;
  }
  const path = siriusProviders.defaultSiriusProvidersPath();
  const existing = siriusProviders.loadSiriusProviders(path);
  const next = siriusProviders.removeSiriusProvider(existing, name);
  if (next.length === existing.length) {
    process.stderr.write(`no provider named '${name}'\n`);
    return 1;
  }
  siriusProviders.saveSiriusProviders(next, path);
  process.stdout.write(`removed sirius provider '${name}'\n`);
  return 0;
}

export async function runSirius(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (sub === 'connect') return runConnect(argv.slice(1));
  if (sub === 'add-provider') return runAddProvider(argv.slice(1));
  if (sub === 'list-providers') return runListProviders(argv.slice(1));
  if (sub === 'remove-provider') return runRemoveProvider(argv.slice(1));
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
