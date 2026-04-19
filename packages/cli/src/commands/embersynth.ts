import {
  config as kubecfg,
  embersynth as embersynthMod,
  resolveNodeKind,
} from '@llamactl/remote';

const USAGE = `llamactl embersynth — embersynth orchestrator integration

USAGE:
  llamactl embersynth init            [--path <file>]
  llamactl embersynth sync            [--path <file>]
  llamactl embersynth connect         <url> [--name <n>] [--api-key-ref <ref>]
  llamactl embersynth show            [--path <file>]
  llamactl embersynth promote-private <rel> [--path <file>]

init — generate a fresh \`embersynth.yaml\` from the current kubeconfig
  + sirius-providers. Nodes derive from llamactl agents and each sirius
  provider (with capability guesses per provider kind). Ships with the
  default auto/fast/private/vision profiles and matching
  \`syntheticModels\` (\`fusion-auto\`, \`fusion-vision\`, …). Refuses
  to overwrite an existing file; use \`sync\` for that.

sync — regenerate only the \`nodes:\` block. Preserves the user's
  hand-edited \`profiles:\` and \`syntheticModels:\`. Use after
  registering a new llamactl agent or sirius provider so embersynth's
  node registry catches up.

connect — register a running embersynth as a gateway node. Its
  synthetic models (from the YAML's \`syntheticModels\`) appear as
  \`<name>.fusion-<profile>\` nodes in llamactl's selector.

show — print the current \`embersynth.yaml\` contents.

promote-private — confirm that a model rel is routable under the
  \`fusion-private-first\` synthetic model: verifies the embersynth
  YAML exists, that the \`private-first\` profile is present with a
  \`private\` preferred tag, and that at least one agent node in the
  current cluster carries the \`private\` tag. Prints the resolved
  routing — read-only, does not mutate.

OPTIONS:
  --path <file>   Override the default path
                  (\`~/.llamactl/embersynth.yaml\` or \`$LLAMACTL_EMBERSYNTH_CONFIG\`).

EXAMPLES:
  llamactl embersynth init
  llamactl embersynth connect http://localhost:7777/v1
  llamactl embersynth sync
  llamactl embersynth show
`;

interface CommonOpts {
  path: string;
}

function parseCommonOpts(argv: string[]): { opts: CommonOpts; rest: string[] } | null {
  let path = embersynthMod.defaultEmbersynthConfigPath();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path') {
      const next = argv[++i];
      if (!next) {
        process.stderr.write(`--path requires a value\n`);
        return null;
      }
      path = next;
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(USAGE);
      return null;
    } else {
      rest.push(a as string);
    }
  }
  return { opts: { path }, rest };
}

async function runInit(argv: string[]): Promise<number> {
  const parsed = parseCommonOpts(argv);
  if (!parsed) return 0;
  const { path } = parsed.opts;
  const existing = embersynthMod.loadEmbersynthConfig(path);
  if (existing) {
    process.stderr.write(
      `${path} already exists. Use \`llamactl embersynth sync\` to refresh nodes while preserving profiles.\n`,
    );
    return 1;
  }
  const cfg = embersynthMod.generateEmbersynthConfig();
  embersynthMod.saveEmbersynthConfig(cfg, path);
  const synthList = embersynthMod.listSyntheticModelIds(cfg);
  process.stdout.write(
    `wrote ${path}\n` +
      `  nodes: ${cfg.nodes.length}\n` +
      `  profiles: ${cfg.profiles.length}\n` +
      `  synthetic models: ${synthList.join(', ') || '(none)'}\n` +
      `  start embersynth with \`--config ${path}\`.\n`,
  );
  return 0;
}

async function runSync(argv: string[]): Promise<number> {
  const parsed = parseCommonOpts(argv);
  if (!parsed) return 0;
  const { path } = parsed.opts;
  const existing = embersynthMod.loadEmbersynthConfig(path);
  const next = embersynthMod.generateEmbersynthConfig({
    existing,
  });
  embersynthMod.saveEmbersynthConfig(next, path);
  process.stdout.write(
    `synced ${path}\n` +
      `  nodes: ${next.nodes.length}\n` +
      `  profiles: ${next.profiles.length} (preserved)\n`,
  );
  return 0;
}

async function runShow(argv: string[]): Promise<number> {
  const parsed = parseCommonOpts(argv);
  if (!parsed) return 0;
  const { path } = parsed.opts;
  const existing = embersynthMod.loadEmbersynthConfig(path);
  if (!existing) {
    process.stderr.write(`${path} does not exist. Run \`llamactl embersynth init\` first.\n`);
    return 1;
  }
  process.stdout.write(JSON.stringify(existing, null, 2));
  process.stdout.write('\n');
  return 0;
}

async function runConnect(argv: string[]): Promise<number> {
  const url = argv[0];
  if (!url || url.startsWith('--')) {
    process.stderr.write(`embersynth connect: base URL is required\n\n${USAGE}`);
    return 1;
  }
  let name = 'embersynth';
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
    kind: 'gateway',
    cloud: {
      provider: 'embersynth',
      baseUrl,
      ...(apiKeyRef ? { apiKeyRef } : {}),
    },
  });
  kubecfg.saveConfig(cfg, cfgPath);
  process.stdout.write(
    `registered embersynth gateway as node '${name}' → ${baseUrl}\n` +
      `  synthetic models from \`${embersynthMod.defaultEmbersynthConfigPath()}\` will appear as ${name}.fusion-<profile>.\n`,
  );
  return 0;
}

async function runPromotePrivate(argv: string[]): Promise<number> {
  const rel = argv[0];
  if (!rel || rel.startsWith('--')) {
    process.stderr.write(`embersynth promote-private: <rel> is required\n\n${USAGE}`);
    return 1;
  }
  const parsed = parseCommonOpts(argv.slice(1));
  if (!parsed) return 0;
  const { path } = parsed.opts;

  const existing = embersynthMod.loadEmbersynthConfig(path);
  if (!existing) {
    process.stderr.write(
      `${path} does not exist. Run \`llamactl embersynth init\` first.\n`,
    );
    return 1;
  }

  const profile = existing.profiles.find((p) => p.id === 'private-first');
  if (!profile) {
    process.stderr.write(
      `private-first profile not found in ${path}. Run \`llamactl embersynth sync\` to seed defaults.\n`,
    );
    return 1;
  }
  const preferred = profile.preferredTags ?? [];
  if (!preferred.includes('private')) {
    process.stderr.write(
      `private-first profile is missing the "private" preferred tag. Edit ${path} or re-seed with \`sync\`.\n`,
    );
    return 1;
  }

  const cfg = kubecfg.loadConfig();
  const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
  const cluster = cfg.clusters.find((c) => c.name === ctx?.cluster);
  const agentNodes = (cluster?.nodes ?? []).filter((n) => resolveNodeKind(n) === 'agent');
  if (agentNodes.length === 0) {
    process.stderr.write(
      `no agent nodes registered. Run \`llamactl agent init\` on a host, then \`llamactl node add\` to register.\n`,
    );
    return 1;
  }

  // Cross-reference embersynth.yaml nodes with kubeconfig agents — we
  // care about the `private` tag on the embersynth side, which is what
  // the profile matches against at routing time.
  const privateAgents = existing.nodes.filter((n) => n.tags.includes('private'));
  if (privateAgents.length === 0) {
    process.stderr.write(
      `no nodes in ${path} carry the "private" tag. Re-run \`llamactl embersynth sync\` — agent nodes are tagged private by default.\n`,
    );
    return 1;
  }

  process.stdout.write(
    `model '${rel}' is routable under fusion-private-first.\n` +
      `  private-first profile: ${profile.label ?? profile.id} (${(profile.preferredTags ?? []).join(',')})\n` +
      `  eligible private-tagged nodes (${privateAgents.length}):\n` +
      privateAgents.map((n) => `    - ${n.id} → ${n.endpoint}`).join('\n') +
      `\n  request the model via: POST /v1/chat/completions { "model": "fusion-private-first", ... }\n` +
      `  embersynth routes to a private-tagged node first; falls back to others only when no private node is healthy.\n`,
  );
  return 0;
}

export async function runEmbersynth(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (sub === 'init') return runInit(argv.slice(1));
  if (sub === 'sync') return runSync(argv.slice(1));
  if (sub === 'show') return runShow(argv.slice(1));
  if (sub === 'connect') return runConnect(argv.slice(1));
  if (sub === 'promote-private') return runPromotePrivate(argv.slice(1));
  process.stderr.write(`unknown embersynth subcommand: ${sub}\n\n${USAGE}`);
  return 1;
}
