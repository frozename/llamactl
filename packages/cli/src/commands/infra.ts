import { getNodeClient } from '../dispatcher.js';

const USAGE = `llamactl infra — install + manage infra packages on nodes

USAGE:
  llamactl infra list                                    [--node <n>]
  llamactl infra install <pkg> --version=<v>             --tarball-url=<url> --sha256=<hex>
                                                         [--node <n>] [--no-activate]
                                                         [--force]
  llamactl infra activate <pkg> --version=<v>            [--node <n>]
  llamactl infra uninstall <pkg> [--version=<v>]         [--node <n>]
  llamactl infra current <pkg>                           [--node <n>]

All subcommands route through the global --node flag — the operation
executes on that node's agent. Default node is the current context's
default (usually \`local\`).

EXAMPLES:
  llamactl infra list --node gpu1
  llamactl infra install llama-cpp --version=b4500 \\
      --tarball-url=https://.../llama-cpp-b4500-darwin-arm64.tar.gz \\
      --sha256=abcd... --node=gpu1
  llamactl infra activate llama-cpp --version=b4500 --node=gpu1
  llamactl infra uninstall llama-cpp --version=b4500 --node=gpu1
`;

interface InstallArgs {
  pkg: string;
  version: string;
  tarballUrl: string;
  sha256: string;
  activate: boolean;
  skipIfPresent: boolean;
}

function parseKv(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq < 0) {
      // Boolean-style flag.
      out.set(arg.slice(2), '');
      continue;
    }
    out.set(arg.slice(2, eq), arg.slice(eq + 1));
  }
  return out;
}

function positionalArgs(argv: string[]): string[] {
  return argv.filter((a) => !a.startsWith('--'));
}

async function runList(): Promise<number> {
  const client = getNodeClient();
  const rows = await client.infraList.query();
  if (rows.length === 0) {
    process.stdout.write('no infra packages installed\n');
    return 0;
  }
  for (const row of rows) {
    const versions = row.versions.join(',');
    const active = row.active ?? '—';
    process.stdout.write(`${row.pkg}\tversions=${versions || '(none)'}\tactive=${active}\n`);
  }
  return 0;
}

async function runInstall(argv: string[]): Promise<number> {
  const [pkg] = positionalArgs(argv);
  if (!pkg) {
    process.stderr.write('infra install: pkg name required\n');
    return 1;
  }
  const kv = parseKv(argv);
  const required: Array<keyof InstallArgs> = ['version', 'tarballUrl', 'sha256'];
  const args: Partial<InstallArgs> = {
    pkg,
    version: kv.get('version'),
    tarballUrl: kv.get('tarball-url'),
    sha256: kv.get('sha256'),
    activate: !kv.has('no-activate'),
    skipIfPresent: !kv.has('force'),
  };
  for (const field of required) {
    if (!args[field]) {
      process.stderr.write(`infra install: --${field === 'tarballUrl' ? 'tarball-url' : field} is required\n`);
      return 1;
    }
  }
  const client = getNodeClient();
  const result = await client.infraInstall.mutate({
    pkg,
    version: args.version!,
    tarballUrl: args.tarballUrl!,
    sha256: args.sha256!,
    activate: args.activate!,
    skipIfPresent: args.skipIfPresent!,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

async function runActivate(argv: string[]): Promise<number> {
  const [pkg] = positionalArgs(argv);
  if (!pkg) {
    process.stderr.write('infra activate: pkg name required\n');
    return 1;
  }
  const kv = parseKv(argv);
  const version = kv.get('version');
  if (!version) {
    process.stderr.write('infra activate: --version is required\n');
    return 1;
  }
  const client = getNodeClient();
  const result = await client.infraActivate.mutate({ pkg, version });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

async function runUninstall(argv: string[]): Promise<number> {
  const [pkg] = positionalArgs(argv);
  if (!pkg) {
    process.stderr.write('infra uninstall: pkg name required\n');
    return 1;
  }
  const kv = parseKv(argv);
  const version = kv.get('version');
  const client = getNodeClient();
  const result = await client.infraUninstall.mutate(
    version ? { pkg, version } : { pkg },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function runCurrent(argv: string[]): Promise<number> {
  const [pkg] = positionalArgs(argv);
  if (!pkg) {
    process.stderr.write('infra current: pkg name required\n');
    return 1;
  }
  const client = getNodeClient();
  const resolved = await client.infraCurrent.query({ pkg });
  if (!resolved) {
    process.stdout.write(`${pkg}: not installed\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(resolved)}\n`);
  return 0;
}

export async function runInfra(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  switch (sub) {
    case 'list':
      return runList();
    case 'install':
      return runInstall(rest);
    case 'activate':
      return runActivate(rest);
    case 'uninstall':
      return runUninstall(rest);
    case 'current':
      return runCurrent(rest);
    default:
      process.stderr.write(`infra: unknown subcommand ${sub}\n\n${USAGE}`);
      return 1;
  }
}
