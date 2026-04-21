import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { getNodeClient } from '../dispatcher.js';

const USAGE = `Usage: llamactl composite <subcommand>

Subcommands:
  apply -f <manifest.yaml> [--dry-run]
      Apply a Composite manifest. With --dry-run, prints the topological
      order + any implied edges (rag→backingService, gateway→upstream)
      without touching runtime state.
  destroy <name> [--dry-run] [--purge-volumes]
      Tear down a composite in reverse-topological order. --purge-volumes
      also removes any backing docker volumes attached to its services.
  list
      List every persisted composite with its phase and component count.
  get <name>
      Print the stored manifest for <name> as YAML.
  status <name>
      Stream CompositeApplyEvents from the last known / in-flight apply.
`;

export async function runComposite(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'apply':
      return runApply(rest);
    case 'destroy':
      return runDestroy(rest);
    case 'list':
    case 'ls':
      return runList(rest);
    case 'get':
      return runGet(rest);
    case 'status':
      return runStatus(rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return sub === undefined ? 1 : 0;
    default:
      process.stderr.write(`Unknown composite subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}

// ---- apply ---------------------------------------------------------

interface ApplyFlags {
  file: string;
  dryRun: boolean;
}

function parseApplyFlags(args: string[]): ApplyFlags | { error: string } {
  let file = '';
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-f' || arg === '--file') {
      file = args[++i] ?? '';
    } else if (arg.startsWith('--file=')) {
      file = arg.slice('--file='.length);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '-h' || arg === '--help') {
      return { error: 'help' };
    } else if (arg.startsWith('-')) {
      return { error: `Unknown flag: ${arg}` };
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
  }
  if (!file) return { error: 'composite apply: -f <manifest.yaml> is required' };
  return { file, dryRun };
}

async function runApply(args: string[]): Promise<number> {
  const parsed = parseApplyFlags(args);
  if ('error' in parsed) {
    const stream = parsed.error === 'help' ? process.stdout : process.stderr;
    stream.write(parsed.error === 'help' ? USAGE : `${parsed.error}\n\n${USAGE}`);
    return parsed.error === 'help' ? 0 : 1;
  }
  const manifestPath = resolvePath(parsed.file);
  if (!existsSync(manifestPath)) {
    process.stderr.write(`composite apply: file not found: ${manifestPath}\n`);
    return 1;
  }
  const manifestYaml = readFileSync(manifestPath, 'utf8');

  const client = getNodeClient();
  let result: unknown;
  try {
    result = await client.compositeApply.mutate({
      manifestYaml,
      dryRun: parsed.dryRun,
    });
  } catch (err) {
    process.stderr.write(`composite apply: ${(err as Error).message}\n`);
    return 1;
  }

  if (parsed.dryRun) {
    const r = result as {
      dryRun: true;
      manifest: { metadata: { name: string } };
      order: Array<{ kind: string; name: string }>;
      impliedEdges: Array<{
        from: { kind: string; name: string };
        to: { kind: string; name: string };
      }>;
    };
    process.stdout.write(
      `dry-run composite/${r.manifest.metadata.name}\n`,
    );
    process.stdout.write(`  topological order (${r.order.length} components):\n`);
    if (r.order.length === 0) {
      process.stdout.write(`    (none)\n`);
    } else {
      r.order.forEach((ref, i) => {
        process.stdout.write(`    ${i + 1}. ${ref.kind}/${ref.name}\n`);
      });
    }
    if (r.impliedEdges.length > 0) {
      process.stdout.write(`  implied edges (${r.impliedEdges.length}):\n`);
      for (const edge of r.impliedEdges) {
        process.stdout.write(
          `    ${edge.from.kind}/${edge.from.name} → ${edge.to.kind}/${edge.to.name}\n`,
        );
      }
    }
    return 0;
  }

  const r = result as {
    dryRun: false;
    ok: boolean;
    status: {
      phase: 'Pending' | 'Applying' | 'Ready' | 'Degraded' | 'Failed';
      appliedAt?: string;
    };
    rolledBack: boolean;
    componentResults: Array<{
      ref: { kind: string; name: string };
      state: 'Ready' | 'Failed';
      message?: string;
    }>;
  };
  process.stdout.write(`composite phase: ${r.status.phase}\n`);
  if (r.componentResults.length > 0) {
    process.stdout.write(`components:\n`);
    for (const c of r.componentResults) {
      if (c.state === 'Ready') {
        process.stdout.write(`  ✓ ${c.ref.kind}/${c.ref.name}\n`);
      } else {
        process.stdout.write(
          `  ✗ ${c.ref.kind}/${c.ref.name} — ${c.message ?? 'failed'}\n`,
        );
      }
    }
  }
  if (r.rolledBack) {
    process.stdout.write(`rolledBack: true\n`);
  }
  return r.ok ? 0 : 1;
}

// ---- destroy -------------------------------------------------------

interface DestroyFlags {
  name: string;
  dryRun: boolean;
  purgeVolumes: boolean;
}

function parseDestroyFlags(args: string[]): DestroyFlags | { error: string } {
  let name = '';
  let dryRun = false;
  let purgeVolumes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--purge-volumes') {
      purgeVolumes = true;
    } else if (arg === '-h' || arg === '--help') {
      return { error: 'help' };
    } else if (arg.startsWith('-')) {
      return { error: `Unknown flag: ${arg}` };
    } else if (!name) {
      name = arg;
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
  }
  if (!name) return { error: 'composite destroy: <name> is required' };
  return { name, dryRun, purgeVolumes };
}

async function runDestroy(args: string[]): Promise<number> {
  const parsed = parseDestroyFlags(args);
  if ('error' in parsed) {
    const stream = parsed.error === 'help' ? process.stdout : process.stderr;
    stream.write(parsed.error === 'help' ? USAGE : `${parsed.error}\n\n${USAGE}`);
    return parsed.error === 'help' ? 0 : 1;
  }

  const client = getNodeClient();
  let result: unknown;
  try {
    result = await client.compositeDestroy.mutate({
      name: parsed.name,
      dryRun: parsed.dryRun,
      purgeVolumes: parsed.purgeVolumes,
    });
  } catch (err) {
    process.stderr.write(`composite destroy: ${(err as Error).message}\n`);
    return 1;
  }

  if (parsed.dryRun) {
    const r = result as {
      dryRun: true;
      name: string;
      wouldRemove: Array<{ kind: string; name: string }>;
    };
    process.stdout.write(`dry-run destroy composite/${r.name}\n`);
    process.stdout.write(`  would remove (reverse-topo, ${r.wouldRemove.length}):\n`);
    if (r.wouldRemove.length === 0) {
      process.stdout.write(`    (none)\n`);
    } else {
      r.wouldRemove.forEach((ref, i) => {
        process.stdout.write(`    ${i + 1}. ${ref.kind}/${ref.name}\n`);
      });
    }
    return 0;
  }

  const r = result as {
    dryRun: false;
    ok: boolean;
    removed: Array<{ kind: string; name: string }>;
    errors: Array<{ ref: { kind: string; name: string }; message: string }>;
  };
  process.stdout.write(`destroyed composite/${parsed.name}\n`);
  if (r.removed.length > 0) {
    process.stdout.write(`  removed (${r.removed.length}):\n`);
    for (const ref of r.removed) {
      process.stdout.write(`    ✓ ${ref.kind}/${ref.name}\n`);
    }
  }
  if (r.errors.length > 0) {
    process.stdout.write(`  errors (${r.errors.length}):\n`);
    for (const e of r.errors) {
      process.stdout.write(
        `    ✗ ${e.ref.kind}/${e.ref.name} — ${e.message}\n`,
      );
    }
  }
  return r.ok && r.errors.length === 0 ? 0 : 1;
}

// ---- list ----------------------------------------------------------

interface CompositeListRow {
  metadata: { name: string };
  spec: {
    services: unknown[];
    workloads: unknown[];
    ragNodes: unknown[];
    gateways: unknown[];
  };
  status?: {
    phase: 'Pending' | 'Applying' | 'Ready' | 'Degraded' | 'Failed';
    appliedAt?: string;
  };
}

async function runList(args: string[]): Promise<number> {
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`composite list: unknown argument ${arg}\n`);
    return 1;
  }

  const client = getNodeClient();
  let rows: CompositeListRow[];
  try {
    rows = (await client.compositeList.query()) as CompositeListRow[];
  } catch (err) {
    process.stderr.write(`composite list: ${(err as Error).message}\n`);
    return 1;
  }

  if (rows.length === 0) {
    process.stdout.write('No composites registered.\n');
    return 0;
  }

  const entries = rows.map((r) => ({
    name: r.metadata.name,
    phase: (r.status?.phase ?? 'Pending') as string,
    components: String(
      r.spec.services.length +
        r.spec.workloads.length +
        r.spec.ragNodes.length +
        r.spec.gateways.length,
    ),
    applied: r.status?.appliedAt ?? '-',
  }));
  const pad = (s: string, w: number): string =>
    s.length >= w ? s : s + ' '.repeat(w - s.length);
  const nameW = Math.max(4, ...entries.map((e) => e.name.length));
  const phaseW = Math.max(5, ...entries.map((e) => e.phase.length));
  const compsW = Math.max(10, ...entries.map((e) => e.components.length));
  process.stdout.write(
    `${pad('NAME', nameW)}  ${pad('PHASE', phaseW)}  ${pad('COMPONENTS', compsW)}  APPLIED\n`,
  );
  for (const e of entries) {
    process.stdout.write(
      `${pad(e.name, nameW)}  ${pad(e.phase, phaseW)}  ${pad(e.components, compsW)}  ${e.applied}\n`,
    );
  }
  return 0;
}

// ---- get -----------------------------------------------------------

async function runGet(args: string[]): Promise<number> {
  let name = '';
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return 0;
    }
    if (arg.startsWith('-')) {
      process.stderr.write(`composite get: unknown flag ${arg}\n`);
      return 1;
    }
    if (!name) name = arg;
    else {
      process.stderr.write(`composite get: unexpected argument ${arg}\n`);
      return 1;
    }
  }
  if (!name) {
    process.stderr.write('composite get: <name> is required\n');
    return 1;
  }

  const client = getNodeClient();
  let manifest: unknown;
  try {
    manifest = await client.compositeGet.query({ name });
  } catch (err) {
    process.stderr.write(`composite get: ${(err as Error).message}\n`);
    return 1;
  }
  if (manifest === null || manifest === undefined) {
    process.stderr.write(`composite '${name}' not found\n`);
    return 1;
  }
  process.stdout.write(stringifyYaml(manifest));
  return 0;
}

// ---- status --------------------------------------------------------

/** Exported for unit testing — maps one event to a single line of output. */
export function formatStatusEvent(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null;
  const ev = e as Record<string, unknown>;
  switch (ev.type) {
    case 'phase':
      return `→ phase: ${String(ev.phase)}`;
    case 'component-start': {
      const ref = ev.ref as { kind: string; name: string };
      return `  ▸ ${ref.kind}/${ref.name}: starting`;
    }
    case 'component-ready': {
      const ref = ev.ref as { kind: string; name: string };
      return `  ✓ ${ref.kind}/${ref.name}: ready`;
    }
    case 'component-failed': {
      const ref = ev.ref as { kind: string; name: string };
      return `  ✗ ${ref.kind}/${ref.name}: ${String(ev.message ?? 'failed')}`;
    }
    case 'rollback-start': {
      const refs = (ev.refs as unknown[]) ?? [];
      return `⇢ rolling back ${refs.length} components`;
    }
    case 'rollback-complete':
      return `⇠ rollback done`;
    case 'done':
      return `⏺ done (ok=${String(ev.ok)})`;
    default:
      return null;
  }
}

async function runStatus(args: string[]): Promise<number> {
  let name = '';
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return 0;
    }
    if (arg.startsWith('-')) {
      process.stderr.write(`composite status: unknown flag ${arg}\n`);
      return 1;
    }
    if (!name) name = arg;
    else {
      process.stderr.write(`composite status: unexpected argument ${arg}\n`);
      return 1;
    }
  }
  if (!name) {
    process.stderr.write('composite status: <name> is required\n');
    return 1;
  }

  const client = getNodeClient();
  // tRPC local-caller proxy returns an async iterable directly from
  // `.subscribe(input)` (see `proxyFromCaller` in remote/client).
  // Remote proxies expose the `{onData,onError,onComplete}` handler
  // shape. Branch so both paths emit the same lines + honour SIGINT.
  // Cast to relax the single-argument subscribe surface — the local
  // caller proxy accepts a single input and returns an AsyncGenerator.
  const subscribeFn = client.compositeStatus.subscribe as unknown as (
    ...args: unknown[]
  ) => unknown;
  let streamable: unknown;
  try {
    streamable = subscribeFn({ name });
  } catch (err) {
    process.stderr.write(`composite status: ${(err as Error).message}\n`);
    return 1;
  }

  // Local caller path: async iterable.
  if (
    streamable &&
    typeof streamable === 'object' &&
    Symbol.asyncIterator in (streamable as Record<PropertyKey, unknown>)
  ) {
    const iter = streamable as AsyncIterable<unknown>;
    let aborted = false;
    const abort = (): void => {
      aborted = true;
    };
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
    try {
      for await (const ev of iter) {
        if (aborted) break;
        const line = formatStatusEvent(ev);
        if (line !== null) process.stdout.write(`${line}\n`);
      }
    } catch (err) {
      process.stderr.write(`composite status: ${(err as Error).message}\n`);
      return 1;
    } finally {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
    }
    return 0;
  }

  // Remote path: handler-based subscription with unsubscribe().
  return new Promise<number>((resolve) => {
    let settled = false;
    const sub = subscribeFn(
      { name },
      {
        onData: (e: unknown) => {
          const line = formatStatusEvent(e);
          if (line !== null) process.stdout.write(`${line}\n`);
        },
        onError: (err: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`composite status: ${msg}\n`);
          resolve(1);
        },
        onComplete: () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(0);
        },
      },
    ) as { unsubscribe: () => void };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      sub.unsubscribe();
      cleanup();
      resolve(0);
    };
    const cleanup = (): void => {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
    };
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
  });
}
