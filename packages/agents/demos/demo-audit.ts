/**
 * demo-audit — N.5 golden-path demo. Scripted, reproducible run of
 * the audit-fleet runbook against a fresh disposable fleet. Prints a
 * narrated transcript so operators can see exactly what the harness
 * does when a real MCP client drives the full read surface.
 *
 * Run with:
 *   bun run packages/agents/demos/demo-audit.ts
 *
 * The demo scopes every write under a tempdir and restores the
 * original env at teardown — safe to run against a machine with an
 * existing ~/.llamactl state.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { runRunbook } from '../src/index.js';

const NARRATIVE = `\
N.5 golden-path demo — audit-fleet
==================================

What you're watching: the same end-to-end path a real Nova agent
takes when it calls \`llamactl runbook run audit-fleet\`. Zero mocks.
Zero real disk writes outside a tempdir. Zero network I/O.

Steps the runbook drives in order (each maps to one @llamactl/mcp
tool call):
  1. llamactl.node.ls          — cluster + every registered node
  2. llamactl.promotions.list  — current preset promotions
  3. llamactl.workload.list    — declarative ModelRun manifests
  4. llamactl.server.status    — control plane's llama-server lifecycle
  5. llamactl.bench.compare    — joined catalog + bench table
`;

interface StepPrinted {
  tool: string;
  durationMs: number;
  ok: boolean;
  bytes: number;
}

function banner(text: string): void {
  process.stdout.write(`\n─── ${text} ${'─'.repeat(Math.max(0, 60 - text.length))}\n`);
}

function seedTempFleet(): {
  runtimeDir: string;
  auditDir: string;
  restore: () => void;
} {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-demo-audit-runtime-'));
  const auditDir = mkdtempSync(join(tmpdir(), 'llamactl-demo-audit-audit-'));

  // Minimal kubeconfig: one local agent + one cloud gateway stub so
  // node.ls has something interesting to report.
  writeFileSync(
    join(runtimeDir, 'config'),
    stringifyYaml({
      apiVersion: 'llamactl/v1',
      kind: 'Config',
      currentContext: 'default',
      contexts: [{ name: 'default', cluster: 'home', user: 'me', defaultNode: 'local' }],
      clusters: [
        {
          name: 'home',
          nodes: [
            { name: 'local', endpoint: 'inproc://local' },
            {
              name: 'sirius-primary',
              endpoint: '',
              kind: 'gateway',
              cloud: { provider: 'sirius', baseUrl: 'http://127.0.0.1:1/v1' },
            },
          ],
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
    LLAMACTL_EMBERSYNTH_CONFIG: join(runtimeDir, 'embersynth.yaml'),
    LLAMACTL_CONFIG: join(runtimeDir, 'config'),
  });

  return {
    runtimeDir,
    auditDir,
    restore: () => {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, originalEnv);
      rmSync(runtimeDir, { recursive: true, force: true });
      rmSync(auditDir, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  process.stdout.write(NARRATIVE);

  const { runtimeDir, auditDir, restore } = seedTempFleet();
  banner('Fleet seeded');
  process.stdout.write(`  runtime:  ${runtimeDir}\n`);
  process.stdout.write(`  audit:    ${auditDir}\n`);
  process.stdout.write(`  kubeconfig: ${join(runtimeDir, 'config')}\n`);

  try {
    banner('Running audit-fleet');
    const printed: StepPrinted[] = [];
    const startedAt = Date.now();
    let lastTick = startedAt;
    const result = await runRunbook(
      'audit-fleet',
      {},
      {
        log: (msg: string) => {
          // Each runbook step logs at its boundaries; render timing
          // by delta from the previous log call so the transcript
          // shows per-step cost.
          const now = Date.now();
          const delta = now - lastTick;
          lastTick = now;
          process.stdout.write(`  [+${String(delta).padStart(4)}ms] ${msg}\n`);
        },
      },
    );
    const totalMs = Date.now() - startedAt;

    // Summarise each step without dumping every byte — the full result
    // is available on `result.summary`.
    for (const step of result.steps) {
      const bytes = Buffer.byteLength(JSON.stringify(step.result), 'utf8');
      printed.push({
        tool: step.tool,
        durationMs: 0,
        ok: true,
        bytes,
      });
    }

    banner('Step tape');
    for (const p of printed) {
      process.stdout.write(
        `  ${p.tool.padEnd(32)} ok=${String(p.ok).padEnd(5)} bytes=${p.bytes}\n`,
      );
    }

    banner('Aggregated fleet snapshot');
    const summary = result.summary as {
      cluster: string | null;
      nodes: Array<{ name: string; kind: string; endpoint?: string }>;
      promotions: unknown[];
      workloads: unknown[];
      installedAndBenched: unknown[];
    };
    process.stdout.write(`  cluster:          ${summary.cluster ?? '(none)'}\n`);
    process.stdout.write(`  nodes:            ${summary.nodes.length}\n`);
    for (const n of summary.nodes) {
      process.stdout.write(
        `    - ${n.name.padEnd(18)} ${n.kind.padEnd(10)} ${n.endpoint ?? ''}\n`,
      );
    }
    process.stdout.write(`  promotions:       ${summary.promotions.length}\n`);
    process.stdout.write(`  workloads:        ${summary.workloads.length}\n`);
    process.stdout.write(`  installed+bench:  ${summary.installedAndBenched.length}\n`);

    banner('Result');
    process.stdout.write(
      `  ok=${result.ok}  steps=${result.steps.length}  total=${totalMs}ms\n`,
    );
    if (!result.ok) {
      process.stdout.write(`  error: ${result.error ?? '(no message)'}\n`);
      process.exitCode = 1;
    }
  } finally {
    restore();
    banner('Teardown complete');
  }
}

main().catch((err) => {
  console.error('demo-audit crashed:', err);
  process.exitCode = 1;
});
