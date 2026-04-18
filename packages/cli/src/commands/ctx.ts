import { readFileSync, existsSync } from 'node:fs';
import { config as kubecfg } from '@llamactl/remote';

const USAGE = `Usage: llamactl ctx <subcommand>

Subcommands:
  current             Print the current-context name.
  use <name>          Set the current-context.
  get                 Print the full kubeconfig YAML.
  nodes               List nodes in the current context (alias for 'node ls').
`;

export async function runCtx(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'current':
      return runCurrent(rest);
    case 'use':
      return runUse(rest);
    case 'get':
      return runGet(rest);
    case 'nodes':
      return (await import('./node.js')).runNode(['ls', ...rest]);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown ctx subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}

function runCurrent(args: string[]): number {
  if (args.length > 0) {
    process.stderr.write(`ctx current: unexpected argument ${args[0]}\n`);
    return 1;
  }
  const cfg = kubecfg.loadConfig();
  process.stdout.write(`${cfg.currentContext}\n`);
  return 0;
}

function runUse(args: string[]): number {
  const [name, ...rest] = args;
  if (!name || name.startsWith('-')) {
    process.stderr.write('ctx use: missing <name>\n');
    return 1;
  }
  if (rest.length > 0) {
    process.stderr.write(`ctx use: unexpected argument ${rest[0]}\n`);
    return 1;
  }
  const cfgPath = kubecfg.defaultConfigPath();
  const cfg = kubecfg.loadConfig(cfgPath);
  const found = cfg.contexts.find((c) => c.name === name);
  if (!found) {
    process.stderr.write(`ctx use: no context named '${name}'\n`);
    return 1;
  }
  const next = { ...cfg, currentContext: name };
  kubecfg.saveConfig(next, cfgPath);
  process.stdout.write(`switched to context '${name}'\n`);
  return 0;
}

function runGet(args: string[]): number {
  if (args.length > 0) {
    process.stderr.write(`ctx get: unexpected argument ${args[0]}\n`);
    return 1;
  }
  const cfgPath = kubecfg.defaultConfigPath();
  if (!existsSync(cfgPath)) {
    // Load will produce a fresh default; surface that but don't write
    // — `get` is a read-only view.
    const fresh = kubecfg.loadConfig(cfgPath);
    process.stdout.write(`# no config at ${cfgPath}; showing defaults\n`);
    process.stdout.write(`${JSON.stringify(fresh, null, 2)}\n`);
    return 0;
  }
  const raw = readFileSync(cfgPath, 'utf8');
  process.stdout.write(raw.endsWith('\n') ? raw : `${raw}\n`);
  return 0;
}
