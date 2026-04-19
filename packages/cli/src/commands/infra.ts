import { infraSpec } from '@llamactl/remote';
import { getNodeClient } from '../dispatcher.js';

type InfraPlatformKind = infraSpec.InfraPlatformKind;
const ALLOWED_PLATFORMS: InfraPlatformKind[] = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
];

function platformFromNodeFacts(facts: {
  os?: string;
  arch?: string;
}): InfraPlatformKind | null {
  const os = facts.os;
  const arch = facts.arch;
  if (os === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (os === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (os === 'linux' && arch === 'x64') return 'linux-x64';
  if (os === 'linux' && arch === 'arm64') return 'linux-arm64';
  return null;
}

const USAGE = `llamactl infra — install + manage infra packages on nodes

USAGE:
  llamactl infra list                                    [--node <n>]
  llamactl infra install <pkg> --version=<v>             [--node <n>]
                                                         [--target-platform=<p>]
                                                         [--packages-dir=<path>]
                                                         [--no-activate] [--force]
  llamactl infra install <pkg> --version=<v>             --tarball-url=<url> --sha256=<hex>
                                                         [--node <n>] [--no-activate]
                                                         [--force]
  llamactl infra activate <pkg> --version=<v>            [--node <n>]
  llamactl infra uninstall <pkg> [--version=<v>]         [--node <n>]
  llamactl infra current <pkg>                           [--node <n>]
  llamactl infra list-specs [--packages-dir=<path>]
  llamactl infra service write-unit <pkg>  [--env=<K=V>] [--node <n>]
  llamactl infra service <start|stop|reload|status> <pkg> [--node <n>]

When --tarball-url + --sha256 are omitted, central looks up the pkg
spec under <LLAMACTL_INFRA_PACKAGES_DIR or DEV_STORAGE/packages or
~/.llamactl/packages>/<pkg>.yaml and derives the artifact for the
target node's os/arch (or --target-platform override). All
subcommands route through the global --node flag — the operation
executes on that node's agent. Default node is the current context's
default (usually 'local').

EXAMPLES:
  # Spec-driven (recommended)
  llamactl infra install llama-cpp --version=b4500 --node=gpu1

  # Ad-hoc override
  llamactl infra install llama-cpp --version=b4500 \\
      --tarball-url=https://.../llama-cpp-b4500-darwin-arm64.tar.gz \\
      --sha256=abcd... --node=gpu1

  llamactl infra list-specs
  llamactl infra activate llama-cpp --version=b4500 --node=gpu1
  llamactl infra uninstall llama-cpp --version=b4500 --node=gpu1
`;

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

async function resolveFromSpec(
  pkg: string,
  version: string,
  platformOverride: InfraPlatformKind | null,
  packagesDir: string | undefined,
  client: ReturnType<typeof getNodeClient>,
): Promise<{ tarballUrl: string; sha256: string } | { error: string }> {
  let spec;
  try {
    spec = infraSpec.loadInfraPackageSpec(pkg, packagesDir);
  } catch (err) {
    return { error: (err as Error).message };
  }
  let platform = platformOverride;
  if (!platform) {
    // Ask the node for its os/arch; derive the platform key.
    const facts = await client.nodeFacts.query();
    platform = platformFromNodeFacts(facts);
    if (!platform) {
      return {
        error: `infra install: could not derive target platform from node facts (os=${facts.os}, arch=${facts.arch}). Pass --target-platform=<p>.`,
      };
    }
  }
  const resolved = infraSpec.resolveInfraArtifact(spec, version, platform);
  if (!resolved.ok) {
    return { error: `infra install: ${resolved.message}` };
  }
  return {
    tarballUrl: resolved.artifact.url,
    sha256: resolved.artifact.sha256,
  };
}

async function runInstall(argv: string[]): Promise<number> {
  const [pkg] = positionalArgs(argv);
  if (!pkg) {
    process.stderr.write('infra install: pkg name required\n');
    return 1;
  }
  const kv = parseKv(argv);
  const version = kv.get('version');
  if (!version) {
    process.stderr.write('infra install: --version is required\n');
    return 1;
  }
  const client = getNodeClient();

  // Two paths:
  //   (a) explicit --tarball-url + --sha256 — legacy/ad-hoc path.
  //   (b) otherwise, resolve from ~/.llamactl/packages/<pkg>.yaml
  //       against the node's os/arch (or a --target-platform override).
  let tarballUrl = kv.get('tarball-url');
  let sha256 = kv.get('sha256');
  if (!tarballUrl || !sha256) {
    const platformArg = kv.get('target-platform');
    if (platformArg && !ALLOWED_PLATFORMS.includes(platformArg as InfraPlatformKind)) {
      process.stderr.write(
        `infra install: --target-platform must be one of ${ALLOWED_PLATFORMS.join(', ')}\n`,
      );
      return 1;
    }
    const packagesDir = kv.get('packages-dir');
    const resolved = await resolveFromSpec(
      pkg,
      version,
      (platformArg as InfraPlatformKind | undefined) ?? null,
      packagesDir,
      client,
    );
    if ('error' in resolved) {
      process.stderr.write(`${resolved.error}\n`);
      return 1;
    }
    tarballUrl = resolved.tarballUrl;
    sha256 = resolved.sha256;
  }

  const activate = !kv.has('no-activate');
  const skipIfPresent = !kv.has('force');
  const result = await client.infraInstall.mutate({
    pkg,
    version,
    tarballUrl,
    sha256,
    activate,
    skipIfPresent,
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

async function runService(argv: string[]): Promise<number> {
  const [action, pkg, ...rest] = argv;
  if (!action || !pkg) {
    process.stderr.write(
      'infra service: usage: llamactl infra service <start|stop|reload|status|write-unit> <pkg> [--node <n>]\n',
    );
    return 1;
  }
  if (action === 'write-unit') {
    const kv = parseKv(rest);
    // --env=KEY=VALUE can be repeated; parseKv collapses to one. Use
    // positional repetition if operators need multiple — deferred.
    const envEntries: Record<string, string> = {};
    if (kv.has('env')) {
      const val = kv.get('env') ?? '';
      const eq = val.indexOf('=');
      if (eq > 0) envEntries[val.slice(0, eq)] = val.slice(eq + 1);
    }
    const client = getNodeClient();
    const result = await client.infraServiceWriteUnit.mutate({ pkg, env: envEntries });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (action !== 'start' && action !== 'stop' && action !== 'reload' && action !== 'status') {
    process.stderr.write(`infra service: unknown action ${action}\n`);
    return 1;
  }
  const client = getNodeClient();
  const result = await client.infraServiceLifecycle.mutate({
    pkg,
    action,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

function runListSpecs(argv: string[]): number {
  const kv = parseKv(argv);
  const dir = kv.get('packages-dir');
  const specs = infraSpec.listInfraPackageSpecs(dir);
  if (specs.length === 0) {
    const resolved = dir ?? infraSpec.defaultInfraPackagesDir();
    process.stdout.write(`no specs under ${resolved}\n`);
    return 0;
  }
  for (const s of specs) {
    const versions = s.versions.join(',');
    const def = s.default ? `default=${s.default}` : 'default=(unset)';
    process.stdout.write(`${s.name}\tversions=${versions}\t${def}\t${s.path}\n`);
  }
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
    case 'list-specs':
      return runListSpecs(rest);
    case 'service':
      return runService(rest);
    default:
      process.stderr.write(`infra: unknown subcommand ${sub}\n\n${USAGE}`);
      return 1;
  }
}
