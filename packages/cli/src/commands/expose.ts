import {
  workloadApply,
  workloadSchema,
  workloadStore,
} from '@llamactl/remote';
import { getNodeClientByName, resolveEffectiveNodeName } from '../dispatcher.js';

const USAGE = `Usage: llamactl expose <target> [--node <name>]
                      [--name <workload>] [--extra-args="..."]
                      [--timeout=<s>] [--json]

Deploy a model on a node as a declarative workload and print the URL
an OpenAI-compatible client (ember synth, etc.) should use.

Equivalent to:
  1. write a minimal ModelRun manifest targeting <node>
  2. llamactl apply -f <manifest>
  3. print the advertisedEndpoint the node reports after startup

\`<target>\` is either a rel path (e.g. org/model-Q4_K_M.gguf) or a
preset alias (fast | balanced | best | vision | …) the target node
can resolve. When --node is omitted, uses the current-context's
defaultNode.

Flags:
  --node <n>         node to deploy on
  --name <w>         workload manifest name; defaults to a slug of target
  --extra-args="..." forwarded to llama-server verbatim
  --timeout=<s>      startServer timeout (default 60)
  --json             machine-readable output
`;

interface ExposeFlags {
  target: string;
  node: string;
  workloadName: string;
  extraArgs: string[];
  timeoutSeconds: number;
  json: boolean;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'expose';
}

function parseFlags(args: string[]): ExposeFlags | { error: string } {
  let target = '';
  let nodeFlag: string | null = null;
  let workloadName: string | null = null;
  let extraArgs: string[] = [];
  let timeoutSeconds = 60;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') { json = true; continue; }
    if (arg === '-h' || arg === '--help') return { error: 'help' };
    if (arg === '--node' || arg === '-n') {
      nodeFlag = args[++i] ?? '';
      if (!nodeFlag) return { error: 'expose: --node requires a value' };
      continue;
    }
    if (arg.startsWith('--node=')) { nodeFlag = arg.slice('--node='.length); continue; }
    if (arg === '--name') {
      workloadName = args[++i] ?? '';
      if (!workloadName) return { error: 'expose: --name requires a value' };
      continue;
    }
    if (arg.startsWith('--name=')) { workloadName = arg.slice('--name='.length); continue; }
    if (arg.startsWith('--extra-args=')) {
      const raw = arg.slice('--extra-args='.length);
      extraArgs = raw.trim().length > 0 ? raw.trim().split(/\s+/) : [];
      continue;
    }
    if (arg === '--extra-args') {
      const raw = args[++i] ?? '';
      extraArgs = raw.trim().length > 0 ? raw.trim().split(/\s+/) : [];
      continue;
    }
    if (arg.startsWith('--timeout=')) {
      const n = Number.parseInt(arg.slice('--timeout='.length), 10);
      if (!Number.isFinite(n) || n <= 0) {
        return { error: `expose: invalid --timeout: ${arg}` };
      }
      timeoutSeconds = n;
      continue;
    }
    if (arg.startsWith('-')) {
      return { error: `expose: unknown flag ${arg}` };
    }
    if (!target) { target = arg; continue; }
    return { error: `expose: unexpected positional ${arg}` };
  }

  if (!target) return { error: 'expose: missing <target>' };
  const node = nodeFlag ?? resolveEffectiveNodeName();
  const name = workloadName ?? slug(target);
  return { target, node, workloadName: name, extraArgs, timeoutSeconds, json };
}

export async function runExpose(args: string[]): Promise<number> {
  const parsed = parseFlags(args);
  if ('error' in parsed) {
    const stream = parsed.error === 'help' ? process.stdout : process.stderr;
    stream.write(USAGE);
    return parsed.error === 'help' ? 0 : 1;
  }

  const { target, node, workloadName, extraArgs, timeoutSeconds, json } = parsed;

  // A rel looks like "<repo-dir>/<file>.gguf"; anything else is treated
  // as a preset alias that the target node resolves locally.
  const targetKind: 'rel' | 'alias' =
    target.endsWith('.gguf') || target.includes('/') ? 'rel' : 'alias';

  const manifest: workloadSchema.ModelRun = {
    apiVersion: 'llamactl/v1',
    kind: 'ModelRun',
    metadata: { name: workloadName, labels: {} },
    spec: {
      node,
      target: { kind: targetKind, value: target },
      extraArgs,
      workers: [],
      restartPolicy: 'Always',
      timeoutSeconds,
      gateway: false,
    },
  };

  let result: workloadApply.ApplyResult;
  try {
    result = await workloadApply.applyOne(manifest, (n) => getNodeClientByName(n));
  } catch (err) {
    process.stderr.write(`expose: apply failed: ${(err as Error).message}\n`);
    return 1;
  }
  if (result.error) {
    process.stderr.write(`expose: ${result.error}\n`);
    return 1;
  }

  const persisted: workloadSchema.ModelRun = { ...manifest, status: result.statusSection };
  const savedPath = workloadStore.saveWorkload(persisted);

  // Pull the advertisedEndpoint off the live node for the printed URL.
  // applyOne populated statusSection.endpoint from the startServer
  // result, but that's the bind URL; we specifically want the
  // advertised one for ember synth.
  let advertised = result.statusSection.endpoint ?? null;
  try {
    const status = await getNodeClientByName(node).serverStatus.query();
    advertised = status.advertisedEndpoint ?? advertised;
  } catch {
    // Not fatal — fall back to whatever applyOne recorded.
  }
  const openaiUrl = advertised ? `${advertised}/v1` : null;

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          workload: workloadName,
          node,
          action: result.action,
          manifest: savedPath,
          advertisedEndpoint: advertised,
          openaiBaseUrl: openaiUrl,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.stdout.write(`${result.action} modelrun/${workloadName} on node ${node}\n`);
  process.stdout.write(`  manifest:  ${savedPath}\n`);
  if (result.statusSection.serverPid) {
    process.stdout.write(`  pid:       ${result.statusSection.serverPid}\n`);
  }
  if (advertised) process.stdout.write(`  endpoint:  ${advertised}\n`);
  if (openaiUrl) {
    process.stdout.write(`  openai:    ${openaiUrl}\n`);
    process.stdout.write('\n');
    process.stdout.write(
      `Point OpenAI-compatible clients (ember synth, etc.) at:\n  ${openaiUrl}\n`,
    );
  }
  return 0;
}
