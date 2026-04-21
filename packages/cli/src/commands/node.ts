import { readFileSync } from 'node:fs';
import {
  agentConfig as agentConfigMod,
  config as kubecfg,
  configSchema,
  createNodeClient,
  createRemoteNodeClient,
} from '@llamactl/remote';

const USAGE = `Usage: llamactl node <subcommand>

Subcommands:
  ls [--json]
      List nodes in the current context.
  add <name> --bootstrap <blob> [--force]
      Decode a bootstrap blob from 'llamactl agent init' and persist it.
  add <name> --server <url> --fingerprint <sha256:...>
      [--token <tok>|--token-file <p>] [--force]
      Register a node explicitly.
  add-rag <name> --provider <chroma|pgvector> --endpoint <e>
      [--collection <c>] [--embedder-node <n> --embedder-model <m>]
      [--password-env <VAR> | --password-ref <secret-ref>]
      [--extra-arg <a>]...
      Register a RAG-kind node. --password-ref accepts any unified-
      resolver ref: env:VAR / keychain:service/account / file:/path.
  rm <name>
      Remove a node (refuses to remove 'local').
  test <name>
      Call nodeFacts() against the node and print the result.

By default, 'add' verifies the node is reachable with the supplied
credentials before persisting. Pass --force to skip the check
(useful when registering a node that isn't online yet).

Kubeconfig path: \$LLAMACTL_CONFIG, or \$DEV_STORAGE/config, or ~/.llamactl/config.
`;

export async function runNode(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'ls':
      return runLs(rest);
    case 'add':
      return runAdd(rest);
    case 'add-rag':
      return runAddRag(rest);
    case 'rm':
      return runRm(rest);
    case 'test':
      return runTest(rest);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown node subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf('=');
  if (eq < 0) return [arg, undefined];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

function runLs(args: string[]): number {
  let json = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else {
      process.stderr.write(`node ls: unknown argument ${arg}\n`);
      return 1;
    }
  }
  const cfgPath = kubecfg.defaultConfigPath();
  const cfg = kubecfg.loadConfig(cfgPath);
  const ctx = kubecfg.currentContext(cfg);
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  const nodes = cluster?.nodes ?? [];
  if (json) {
    process.stdout.write(`${JSON.stringify({ context: ctx.name, nodes }, null, 2)}\n`);
    return 0;
  }
  if (nodes.length === 0) {
    process.stdout.write(`(no nodes in context ${ctx.name})\n`);
    return 0;
  }
  const width = Math.max(...nodes.map((n) => n.name.length));
  for (const n of nodes) {
    const suffix = n.name === ctx.defaultNode ? ' (default)' : '';
    process.stdout.write(`${n.name.padEnd(width)}  ${n.endpoint}${suffix}\n`);
  }
  return 0;
}

interface AddFlags {
  name: string;
  bootstrap?: string;
  server?: string;
  fingerprint?: string;
  token?: string;
  tokenFile?: string;
  certificate?: string;        // inline PEM (currently unused; written if bootstrap + fetch succeeds)
  force: boolean;
}

function parseAdd(args: string[]): AddFlags | { error: string } {
  if (args.length === 0) return { error: 'node add: missing <name>' };
  const [name, ...rest] = args;
  if (!name || name.startsWith('-')) return { error: 'node add: missing <name>' };
  const flags: AddFlags = { name, force: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--force') { flags.force = true; continue; }
    if (arg === '--bootstrap') { flags.bootstrap = rest[++i]; continue; }
    if (arg === '--server') { flags.server = rest[++i]; continue; }
    if (arg === '--fingerprint') { flags.fingerprint = rest[++i]; continue; }
    if (arg === '--token') { flags.token = rest[++i]; continue; }
    if (arg === '--token-file') { flags.tokenFile = rest[++i]; continue; }
    const [k, v] = splitFlag(arg);
    if (v !== undefined) {
      switch (k) {
        case '--bootstrap': flags.bootstrap = v; continue;
        case '--server': flags.server = v; continue;
        case '--fingerprint': flags.fingerprint = v; continue;
        case '--token': flags.token = v; continue;
        case '--token-file': flags.tokenFile = v; continue;
      }
    }
    return { error: `node add: unknown argument ${arg}` };
  }
  return flags;
}

async function runAdd(args: string[]): Promise<number> {
  const parsed = parseAdd(args);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const f = parsed;
  let url: string;
  let fingerprint: string;
  let token: string;
  let certificate: string | undefined;

  if (f.bootstrap) {
    const decoded = agentConfigMod.decodeBootstrap(f.bootstrap);
    url = decoded.url;
    fingerprint = decoded.fingerprint;
    token = decoded.token;
    certificate = decoded.certificate;
  } else {
    if (!f.server || !f.fingerprint) {
      process.stderr.write('node add: --bootstrap or (--server + --fingerprint + --token|--token-file) required\n');
      return 1;
    }
    url = f.server;
    fingerprint = f.fingerprint;
    if (f.token) token = f.token;
    else if (f.tokenFile) token = readFileSync(f.tokenFile, 'utf8').trim();
    else {
      process.stderr.write('node add: --token or --token-file required when not using --bootstrap\n');
      return 1;
    }
  }

  // Probe the node for reachability + credential validity before we
  // commit anything to the kubeconfig. nodeFacts is the cheapest query
  // on the router that exercises auth + TLS end-to-end.
  type ProbeFacts = {
    nodeName: string;
    profile: string;
    platform: string;
    advertisedEndpoint?: string;
  };
  let probeFacts: ProbeFacts | null = null;
  if (!f.force) {
    try {
      const probeClient = createRemoteNodeClient({
        url,
        token,
        ...(certificate ? { certificate } : {}),
        certificateFingerprint: fingerprint,
      });
      probeFacts = await probeClient.nodeFacts.query() as ProbeFacts;
    } catch (err) {
      process.stderr.write(
        [
          `node add: reachability check failed for ${url}`,
          `  error: ${(err as Error).message}`,
          `  hint:  verify the agent is running and \`llamactl agent serve\``,
          `         started successfully on that host; or pass --force to`,
          `         persist without the check.`,
          '',
        ].join('\n'),
      );
      return 1;
    }
  }

  const cfgPath = kubecfg.defaultConfigPath();
  let cfg = kubecfg.loadConfig(cfgPath);
  const ctx = kubecfg.currentContext(cfg);

  // Persist the token at the user's tokenRef path if present; otherwise
  // inline it on the user entry.
  cfg = {
    ...cfg,
    users: cfg.users.map((u) => {
      if (u.name !== ctx.user) return u;
      const updated: configSchema.User = { ...u };
      if (u.tokenRef) {
        // Write token to referenced file. Not caching the write here —
        // user-managed path semantics.
        const tokenRef = u.tokenRef.replace(/^~(?=$|\/)/, process.env.HOME ?? '');
        try {
          const fs = require('node:fs');
          const path = require('node:path');
          fs.mkdirSync(path.dirname(tokenRef), { recursive: true });
          fs.writeFileSync(tokenRef, token, { mode: 0o600 });
        } catch {
          // fall through: inline the token as a fallback.
          updated.token = token;
        }
      } else {
        updated.token = token;
      }
      return updated;
    }),
  };

  const nodeEntry: configSchema.ClusterNode = {
    name: f.name,
    endpoint: url,
    certificateFingerprint: fingerprint,
  };
  if (certificate) nodeEntry.certificate = certificate;
  cfg = kubecfg.upsertNode(cfg, ctx.cluster, nodeEntry);

  kubecfg.saveConfig(cfg, cfgPath);
  if (probeFacts) {
    const advertised = probeFacts.advertisedEndpoint && probeFacts.advertisedEndpoint.length > 0
      ? probeFacts.advertisedEndpoint
      : '(not set)';
    process.stdout.write(
      [
        `added node '${f.name}' (${url}) to context '${ctx.name}'`,
        `  profile:    ${probeFacts.profile}`,
        `  platform:   ${probeFacts.platform}`,
        `  advertised: ${advertised}`,
        '',
      ].join('\n'),
    );
  } else {
    // --force path — unverified persistence
    process.stdout.write(
      `added node '${f.name}' (${url}) to context '${ctx.name}' [unverified]\n`,
    );
  }
  return 0;
}

function runRm(args: string[]): number {
  const [name, ...rest] = args;
  if (!name || name.startsWith('-')) {
    process.stderr.write('node rm: missing <name>\n');
    return 1;
  }
  if (rest.length > 0) {
    process.stderr.write(`node rm: unexpected argument ${rest[0]}\n`);
    return 1;
  }
  const cfgPath = kubecfg.defaultConfigPath();
  let cfg = kubecfg.loadConfig(cfgPath);
  const ctx = kubecfg.currentContext(cfg);
  try {
    cfg = kubecfg.removeNode(cfg, ctx.cluster, name);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  kubecfg.saveConfig(cfg, cfgPath);
  process.stdout.write(`removed node '${name}' from context '${ctx.name}'\n`);
  return 0;
}

async function runTest(args: string[]): Promise<number> {
  const [name, ...rest] = args;
  if (!name || name.startsWith('-')) {
    process.stderr.write('node test: missing <name>\n');
    return 1;
  }
  if (rest.length > 0) {
    process.stderr.write(`node test: unexpected argument ${rest[0]}\n`);
    return 1;
  }
  const cfgPath = kubecfg.defaultConfigPath();
  const cfg = kubecfg.loadConfig(cfgPath);
  const client = createNodeClient(cfg, { nodeName: name });
  try {
    const facts = await client.nodeFacts.query();
    process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`node test failed: ${(err as Error).message}\n`);
    return 1;
  }
}

/**
 * `llamactl node add-rag` — registers a RAG-kind node in the current
 * context. Covers the common operator paths: pgvector with env or
 * keychain-sourced password + optional delegated embedder, chroma-mcp
 * with an optional collection override.
 *
 * Wraps `kubecfg.upsertNode` so it rides the same validation path as
 * hand-editing the kubeconfig — the `.refine()` validator on
 * `ClusterNodeSchema` catches bad provider/missing-rag combinations.
 */
function runAddRag(args: string[]): number {
  let name: string | undefined;
  let provider: 'chroma' | 'pgvector' | undefined;
  let endpoint: string | undefined;
  let collection: string | undefined;
  let embedderNode: string | undefined;
  let embedderModel: string | undefined;
  let passwordEnv: string | undefined;
  let passwordRef: string | undefined;
  const extraArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const [flag, inline] = splitFlag(arg);
    const takeValue = (): string | undefined =>
      inline ?? (args[i + 1] && !args[i + 1]!.startsWith('-') ? args[++i] : undefined);
    if (!flag.startsWith('-')) {
      if (name === undefined) {
        name = flag;
        continue;
      }
      process.stderr.write(`node add-rag: unexpected positional ${flag}\n`);
      return 1;
    }
    switch (flag) {
      case '--provider': {
        const v = takeValue();
        if (v !== 'chroma' && v !== 'pgvector') {
          process.stderr.write(
            `node add-rag: --provider must be 'chroma' or 'pgvector' (got ${v ?? '<empty>'})\n`,
          );
          return 1;
        }
        provider = v;
        break;
      }
      case '--endpoint':
        endpoint = takeValue();
        break;
      case '--collection':
        collection = takeValue();
        break;
      case '--embedder-node':
        embedderNode = takeValue();
        break;
      case '--embedder-model':
        embedderModel = takeValue();
        break;
      case '--password-env':
        passwordEnv = takeValue();
        break;
      case '--password-ref':
        passwordRef = takeValue();
        break;
      case '--extra-arg': {
        // Extra args frequently begin with `--` (e.g.
        // `--persist-directory`), so we accept the next argv slot
        // unconditionally rather than stopping at a dash.
        const v = inline ?? (i + 1 < args.length ? args[++i] : undefined);
        if (v !== undefined) extraArgs.push(v);
        break;
      }
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        return 0;
      default:
        process.stderr.write(`node add-rag: unknown flag ${flag}\n`);
        return 1;
    }
  }

  if (!name) {
    process.stderr.write('node add-rag: missing <name>\n');
    return 1;
  }
  if (!provider) {
    process.stderr.write('node add-rag: --provider is required\n');
    return 1;
  }
  if (!endpoint) {
    process.stderr.write('node add-rag: --endpoint is required\n');
    return 1;
  }
  if ((embedderNode === undefined) !== (embedderModel === undefined)) {
    process.stderr.write(
      'node add-rag: --embedder-node and --embedder-model must be set together\n',
    );
    return 1;
  }
  if (passwordEnv && passwordRef) {
    process.stderr.write(
      'node add-rag: pass only one of --password-env / --password-ref\n',
    );
    return 1;
  }

  const binding: Record<string, unknown> = {
    provider,
    endpoint,
    extraArgs,
  };
  if (collection) binding.collection = collection;
  if (embedderNode && embedderModel) {
    binding.embedder = { node: embedderNode, model: embedderModel };
  }
  if (passwordEnv) {
    binding.auth = { tokenEnv: passwordEnv };
  } else if (passwordRef) {
    binding.auth = { tokenRef: passwordRef };
  }

  const cfgPath = kubecfg.defaultConfigPath();
  const cfg = kubecfg.loadConfig(cfgPath);
  const ctx = kubecfg.currentContext(cfg);
  let next;
  try {
    next = kubecfg.upsertNode(cfg, ctx.cluster, {
      name,
      endpoint: '',
      kind: 'rag',
      rag: configSchema.RagBindingSchema.parse(binding),
    });
  } catch (err) {
    process.stderr.write(
      `node add-rag: invalid binding: ${(err as Error).message}\n`,
    );
    return 1;
  }
  kubecfg.saveConfig(next, cfgPath);
  process.stdout.write(
    `added rag node '${name}' (${provider}) to context '${ctx.name}'\n`,
  );
  return 0;
}
