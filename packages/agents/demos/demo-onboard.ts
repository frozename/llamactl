/**
 * demo-onboard — N.5 golden-path demo. Scripted, reproducible run of
 * the onboard-new-gpu-node runbook against a fresh disposable fleet.
 * Demonstrates the full mutation path (dry-run preview → wet run →
 * embersynth.sync) instead of audit-fleet's read-only tour.
 *
 * Run with:
 *   bun run packages/agents/demos/demo-onboard.ts
 *
 * Seeds a tempdir fleet (one local agent), builds a fake bootstrap
 * blob pointing at an unreachable host (we never probe the new node
 * here — the runbook scope doesn't reach that far), runs
 * onboard-new-gpu-node both dry and wet, and prints the state
 * transition the operator would see.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { runRunbook } from '../src/index.js';

/**
 * Local copy of the bootstrap blob shape + encoder so this demo
 * doesn't pull in @llamactl/remote. Must stay byte-compatible with
 * the encoder in packages/remote/src/config/agent-config.ts.
 */
function encodeBootstrap(blob: {
  url: string;
  fingerprint: string;
  token: string;
  certificate: string;
}): string {
  return Buffer.from(JSON.stringify(blob), 'utf8').toString('base64url');
}

const NARRATIVE = `\
N.5 golden-path demo — onboard-new-gpu-node
===========================================

What you're watching: the mutation path for a Nova-driven agent
onboarding. Same runbook a \`llamactl runbook run
onboard-new-gpu-node --params '{...}'\` invocation fires, but narrated.

Steps the runbook drives (each maps to one @llamactl/mcp tool call):
  1. llamactl.node.add  (dryRun=true)  — decode + preview
  2. llamactl.node.add  (dryRun=false) — commit the kubeconfig entry
  3. llamactl.node.ls                  — confirm the node is visible
  4. llamactl.embersynth.sync          — rewire routing to include the new node
`;

function banner(text: string): void {
  process.stdout.write(`\n─── ${text} ${'─'.repeat(Math.max(0, 60 - text.length))}\n`);
}

function seedTempFleet(): {
  runtimeDir: string;
  auditDir: string;
  kubeconfigPath: string;
  embersynthPath: string;
  restore: () => void;
} {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-demo-onboard-runtime-'));
  const auditDir = mkdtempSync(join(tmpdir(), 'llamactl-demo-onboard-audit-'));
  const kubeconfigPath = join(runtimeDir, 'config');
  const embersynthPath = join(runtimeDir, 'embersynth.yaml');

  // Start with only the local agent so we can observe a real
  // before/after node count.
  writeFileSync(
    kubeconfigPath,
    stringifyYaml({
      apiVersion: 'llamactl/v1',
      kind: 'Config',
      currentContext: 'default',
      contexts: [{ name: 'default', cluster: 'home', user: 'me', defaultNode: 'local' }],
      clusters: [
        {
          name: 'home',
          nodes: [{ name: 'local', endpoint: 'inproc://local' }],
        },
      ],
      users: [{ name: 'me', token: 'local' }],
    }),
  );

  const originalEnv = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: runtimeDir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(runtimeDir, 'preset-overrides.tsv'),
    LLAMACTL_MCP_AUDIT_DIR: auditDir,
    LLAMACTL_EMBERSYNTH_CONFIG: embersynthPath,
    LLAMACTL_CONFIG: kubeconfigPath,
  });

  return {
    runtimeDir,
    auditDir,
    kubeconfigPath,
    embersynthPath,
    restore: () => {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, originalEnv);
      rmSync(runtimeDir, { recursive: true, force: true });
      rmSync(auditDir, { recursive: true, force: true });
    },
  };
}

async function runOnce(
  tag: string,
  params: { name: string; bootstrap: string },
  dryRun: boolean,
): Promise<{
  ok: boolean;
  stepsCount: number;
  tape: string[];
  error?: string;
  summary?: unknown;
}> {
  banner(`${tag}: onboard-new-gpu-node (dryRun=${dryRun})`);
  const startedAt = Date.now();
  let lastTick = startedAt;
  const result = await runRunbook('onboard-new-gpu-node', params, {
    dryRun,
    log: (msg: string) => {
      const now = Date.now();
      const delta = now - lastTick;
      lastTick = now;
      process.stdout.write(`  [+${String(delta).padStart(4)}ms] ${msg}\n`);
    },
  });
  const totalMs = Date.now() - startedAt;
  const tape: string[] = [];
  for (const step of result.steps) {
    tape.push(
      `  ${step.tool.padEnd(28)} dryRun=${String(step.dryRun).padEnd(5)} ok=${String(
        (step.result as { ok?: boolean }).ok !== false,
      )}`,
    );
  }
  if (tape.length > 0) {
    process.stdout.write(tape.join('\n') + '\n');
  }
  process.stdout.write(`  total=${totalMs}ms\n`);
  const out: {
    ok: boolean;
    stepsCount: number;
    tape: string[];
    error?: string;
    summary?: unknown;
  } = {
    ok: result.ok,
    stepsCount: result.steps.length,
    tape,
  };
  if (result.error) out.error = result.error;
  if (result.summary !== undefined) out.summary = result.summary;
  return out;
}

async function main(): Promise<void> {
  process.stdout.write(NARRATIVE);

  const seeded = seedTempFleet();
  banner('Fleet seeded (1 local agent only)');
  process.stdout.write(`  runtime:    ${seeded.runtimeDir}\n`);
  process.stdout.write(`  kubeconfig: ${seeded.kubeconfigPath}\n`);
  process.stdout.write(`  embersynth: ${seeded.embersynthPath} (absent before onboarding)\n`);

  // Build a fake bootstrap blob the runbook will accept. Points at a
  // dead port so we never accidentally probe a real host; the runbook
  // scope is kubeconfig + embersynth, not reachability.
  const bootstrap = encodeBootstrap({
    url: 'https://127.0.0.1:59999',
    fingerprint: 'sha256:' + 'a'.repeat(64),
    token: 'fake-token-for-demo',
    certificate: '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n',
  });

  try {
    // First: dry-run. Should decode the blob and preview the entry
    // without mutating kubeconfig or touching embersynth.
    const dry = await runOnce(
      'Step 1',
      { name: 'gpu1-demo', bootstrap },
      true,
    );

    const embersynthBeforeWet = existsSync(seeded.embersynthPath);

    // Second: wet run. Commits the node, then runs embersynth sync.
    const wet = await runOnce(
      'Step 2',
      { name: 'gpu1-demo', bootstrap },
      false,
    );

    banner('State transition');
    process.stdout.write(
      `  dry-run steps:       ${dry.stepsCount} (preview only, no writes)\n`,
    );
    process.stdout.write(`  wet-run steps:       ${wet.stepsCount}\n`);
    process.stdout.write(
      `  embersynth before:   ${embersynthBeforeWet ? 'exists' : 'absent'}\n`,
    );
    process.stdout.write(
      `  embersynth after:    ${existsSync(seeded.embersynthPath) ? 'exists' : 'absent'}\n`,
    );
    if (wet.summary) {
      const s = wet.summary as { cluster?: string; totalNodes?: number; endpoint?: string };
      process.stdout.write(`  cluster:             ${s.cluster ?? '(none)'}\n`);
      process.stdout.write(`  total nodes after:   ${s.totalNodes ?? '?'}\n`);
      process.stdout.write(`  new node endpoint:   ${s.endpoint ?? '(not reported)'}\n`);
    }

    banner('Result');
    process.stdout.write(
      `  dry-run ok=${dry.ok}   wet-run ok=${wet.ok}\n`,
    );
    if (!dry.ok || !wet.ok) {
      process.stdout.write(`  dry error: ${dry.error ?? '(none)'}\n`);
      process.stdout.write(`  wet error: ${wet.error ?? '(none)'}\n`);
      process.exitCode = 1;
    }
  } finally {
    seeded.restore();
    banner('Teardown complete');
  }
}

main().catch((err) => {
  console.error('demo-onboard crashed:', err);
  process.exitCode = 1;
});
