/**
 * `llamactl init` — first-run onboarding.
 *
 * Picks a runtime (auto-detect via docker/k8s availability), asks
 * which quickstart template to seed (chroma-only / pgvector /
 * chroma+workload), writes the manifest to
 * `~/.llamactl/composites/<name>.yaml`, and optionally applies it.
 *
 * Interactive prompts appear only when stdin is a TTY. In scripts /
 * CI, every decision has a flag override:
 *   --runtime=docker|kubernetes|auto
 *   --template=chroma-only|pgvector-with-embedder|chroma-plus-workload
 *   --name=<composite-name>                 (default: 'quickstart')
 *   --no-apply                              (write only)
 *   --force                                  (overwrite existing)
 *   --yes / -y                               (non-interactive; use defaults)
 *
 * Flow:
 *   1. Detect runtimes → surface recommendation.
 *   2. Prompt (if TTY) for runtime + template + name + apply.
 *   3. Load the template YAML from `templates/composites/<kind>.yaml`
 *      relative to the repo (follows the compiled-binary install
 *      layout when present; falls back to the source tree in dev).
 *   4. Rewrite metadata.name + spec.runtime per the picks.
 *   5. Write to `~/.llamactl/composites/<name>.yaml`. Overwrite
 *      check gated behind `--force` when the file exists.
 *   6. If `--apply`, invoke `compositeApply` via the router's
 *      in-proc caller so we don't depend on a running agent HTTP
 *      surface. On failure, surface the component that broke.
 */
import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline/promises';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type RuntimeKind = 'docker' | 'kubernetes';
type TemplateKey =
  | 'chroma-only'
  | 'pgvector-with-embedder'
  | 'chroma-plus-workload';

const TEMPLATE_ORDER: readonly TemplateKey[] = [
  'chroma-only',
  'pgvector-with-embedder',
  'chroma-plus-workload',
];

interface InitArgs {
  help: boolean;
  yes: boolean;
  force: boolean;
  noApply: boolean;
  runtime: RuntimeKind | 'auto';
  template: TemplateKey | null;
  name: string;
}

export async function runInit(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const isTty = Boolean(process.stdin.isTTY) && !args.yes;
  const rl = isTty ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    await greet();

    const runtimes = await detectRuntimes();
    const runtime = await pickRuntime(args, runtimes, rl);
    const template = await pickTemplate(args, rl);
    const composite = loadTemplate(template);
    const rewritten = applyRewrites(composite, {
      name: args.name,
      runtime,
    });

    const targetDir = defaultCompositesDir();
    const targetPath = join(targetDir, `${args.name}.yaml`);
    mkdirSync(targetDir, { recursive: true });

    if (existsSync(targetPath) && !args.force) {
      process.stderr.write(
        `composite '${args.name}' already exists at ${targetPath}; pass --force to overwrite\n`,
      );
      return 1;
    }
    writeFileSync(targetPath, rewritten, 'utf8');
    process.stdout.write(`✓ wrote composite to ${targetPath}\n`);

    const shouldApply = await confirmApply(args, rl);
    if (!shouldApply) {
      process.stdout.write(
        `\nNext: review the manifest, then run\n  llamactl composite apply -f ${targetPath}\n`,
      );
      return 0;
    }

    const applyResult = await applyComposite(targetPath);
    if (!applyResult.ok) {
      process.stderr.write(
        `\n✗ apply failed: ${applyResult.message ?? 'unknown error'}\n`,
      );
      return 1;
    }
    process.stdout.write(`\n✓ composite '${args.name}' applied\n`);
    return 0;
  } finally {
    rl?.close();
  }
}

// ---- steps ---------------------------------------------------------------

async function greet(): Promise<void> {
  process.stdout.write(
    'llamactl init — onboarding wizard for a brand-new install.\n',
  );
  process.stdout.write(
    "I'll pick a runtime, seed a quickstart composite, and (optionally) apply it.\n\n",
  );
}

interface DetectedRuntimes {
  docker: boolean;
  kubernetes: boolean;
}

async function detectRuntimes(): Promise<DetectedRuntimes> {
  let docker = false;
  let kubernetes = false;
  try {
    const { createDockerBackend } = await import('@llamactl/remote');
    const b = createDockerBackend();
    await b.ping();
    docker = true;
  } catch {
    docker = false;
  }
  try {
    const { KubernetesBackend } = await import('@llamactl/remote');
    const b = new KubernetesBackend();
    await b.ping();
    kubernetes = true;
  } catch {
    kubernetes = false;
  }
  return { docker, kubernetes };
}

async function pickRuntime(
  args: InitArgs,
  detected: DetectedRuntimes,
  rl: ReadlineInterface | null,
): Promise<RuntimeKind> {
  if (args.runtime === 'docker' || args.runtime === 'kubernetes') {
    return args.runtime;
  }
  // auto: Docker is the default — k8s is opt-in. We only offer the
  // choice when BOTH runtimes are reachable AND we're in a TTY
  // interactive session. Otherwise just pick docker silently; k8s
  // stays available via --runtime=kubernetes or
  // spec.runtime:kubernetes at composite author time.
  if (detected.docker && detected.kubernetes && rl) {
    const ans = await rl.question(
      'Both Docker and Kubernetes are reachable. Which runtime? [docker/kubernetes] (docker): ',
    );
    const pick = ans.trim().toLowerCase();
    if (pick === 'k8s' || pick === 'kubernetes') return 'kubernetes';
    return 'docker';
  }
  if (detected.docker) {
    return 'docker';
  }
  if (detected.kubernetes) {
    // Only reachable runtime is k8s — surface that as the pick.
    process.stdout.write('Runtime: kubernetes (only reachable runtime)\n');
    return 'kubernetes';
  }
  // Docker didn't answer — k8s didn't either. Init goes ahead with
  // docker as the default; the manifest won't apply until Docker is
  // up, but we want to let the operator finish authoring the YAML.
  process.stdout.write(
    'Runtime: docker (default — neither runtime answered; run `llamactl doctor` after install).\n',
  );
  return 'docker';
}

async function pickTemplate(
  args: InitArgs,
  rl: ReadlineInterface | null,
): Promise<TemplateKey> {
  if (args.template) return args.template;
  if (!rl) return 'chroma-only';

  process.stdout.write('\nAvailable quickstart templates:\n');
  TEMPLATE_ORDER.forEach((key, i) => {
    process.stdout.write(`  ${i + 1}) ${key}${templateBlurb(key)}\n`);
  });
  const ans = await rl.question('Pick a template [1]: ');
  const n = Number.parseInt(ans.trim(), 10);
  if (Number.isFinite(n) && n >= 1 && n <= TEMPLATE_ORDER.length) {
    return TEMPLATE_ORDER[n - 1]!;
  }
  return 'chroma-only';
}

function templateBlurb(key: TemplateKey): string {
  switch (key) {
    case 'chroma-only':
      return '       — chroma + one rag node (simplest)';
    case 'pgvector-with-embedder':
      return ' — pgvector + rag node + delegated embedder';
    case 'chroma-plus-workload':
      return '  — chroma + a llama-server workload';
  }
}

function loadTemplate(key: TemplateKey): string {
  const candidates = [
    // dev: repo-root templates/ dir alongside packages/.
    resolve(moduleDir(), '..', '..', '..', '..', 'templates', 'composites', `${key}.yaml`),
    // alternate dev layout: packages/cli run from repo root.
    resolve(process.cwd(), 'templates', 'composites', `${key}.yaml`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  throw new Error(
    `template '${key}' not found in any candidate path: ${candidates.join(', ')}`,
  );
}

function applyRewrites(
  yaml: string,
  opts: { name: string; runtime: RuntimeKind },
): string {
  // Flat string rewrites avoid pulling a YAML parser — templates
  // are operator-authored with stable formatting. Handles the two
  // knobs init actually changes: metadata.name and spec.runtime.
  return yaml
    .replace(/^(\s*name:\s*)quickstart\s*$/m, `$1${opts.name}`)
    .replace(/^(\s*runtime:\s*)(docker|kubernetes)\s*$/m, `$1${opts.runtime}`);
}

function defaultCompositesDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_COMPOSITES_DIR;
  if (override) return override;
  const base = env.LLAMACTL_HOME ?? join(homedir(), '.llamactl');
  return join(base, 'composites');
}

async function confirmApply(
  args: InitArgs,
  rl: ReadlineInterface | null,
): Promise<boolean> {
  if (args.noApply) return false;
  if (args.yes) return true;
  if (!rl) return false;
  const ans = await rl.question('\nApply this composite now? [y/N]: ');
  return /^(y|yes)$/i.test(ans.trim());
}

async function applyComposite(
  yamlPath: string,
): Promise<{ ok: boolean; message?: string }> {
  try {
    const { router } = await import('@llamactl/remote');
    const caller = router.createCaller({});
    const yaml = readFileSync(yamlPath, 'utf8');
    const result = await caller.compositeApply({
      manifestYaml: yaml,
      dryRun: false,
    });
    if (!result || result.dryRun !== false) {
      return { ok: false, message: 'expected a wet-run result' };
    }
    if (!result.ok) {
      const failed = result.componentResults.find(
        (r) => r.state === 'Failed',
      );
      return {
        ok: false,
        message: failed?.message ?? 'one or more components failed',
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

// ---- helpers -------------------------------------------------------------

function parseArgs(argv: string[]): InitArgs {
  const a: InitArgs = {
    help: false,
    yes: false,
    force: false,
    noApply: false,
    runtime: 'auto',
    template: null,
    name: 'quickstart',
  };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') a.help = true;
    else if (arg === '-y' || arg === '--yes') a.yes = true;
    else if (arg === '--force') a.force = true;
    else if (arg === '--no-apply') a.noApply = true;
    else if (arg.startsWith('--runtime=')) {
      const v = arg.slice('--runtime='.length) as RuntimeKind | 'auto';
      if (v === 'docker' || v === 'kubernetes' || v === 'auto') a.runtime = v;
    } else if (arg.startsWith('--template=')) {
      const v = arg.slice('--template='.length) as TemplateKey;
      if ((TEMPLATE_ORDER as readonly string[]).includes(v)) {
        a.template = v;
      }
    } else if (arg.startsWith('--name=')) {
      const v = arg.slice('--name='.length).trim();
      if (v.length > 0) a.name = v;
    }
  }
  return a;
}

function moduleDir(): string {
  // Handles both `bun run src/bin.ts` (file URL) and compiled binary.
  const url = import.meta.url;
  try {
    return dirname(fileURLToPath(url));
  } catch {
    return process.cwd();
  }
}

// Consumed via `templates/composites/<key>.yaml`. Keep platform() here to
// satisfy a future plat-specific hint without re-importing.
void platform;

const USAGE = `llamactl init — onboard a fresh install

Usage:
  llamactl init [--yes] [--force] [--no-apply]
                [--runtime=docker|kubernetes|auto]
                [--template=<key>] [--name=<composite>]

Flags:
  --yes, -y         Non-interactive: pick defaults, apply if no --no-apply.
  --force           Overwrite an existing composite YAML.
  --no-apply        Write the manifest but don't apply.
  --runtime=<k>     Force runtime instead of auto-detecting.
  --template=<key>  One of: ${TEMPLATE_ORDER.join(', ')}.
  --name=<name>     Composite name (default: 'quickstart').

Templates:
${TEMPLATE_ORDER.map((k) => `  ${k}${templateBlurb(k)}`).join('\n')}

Exit codes:
  0 — manifest written (and optionally applied)
  1 — bad args, file collision without --force, or apply failure
`;
