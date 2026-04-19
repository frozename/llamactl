/**
 * demo-failover — N.5 golden-path demo. Deterministic simulation of
 * the healer observing a gateway transition from healthy → unhealthy,
 * recording the change to its journal. Uses an injected fetch so the
 * demo never hits a live HTTP target; state changes come from swapping
 * the fetch stub between ticks.
 *
 * Run with:
 *   bun run packages/agents/demos/demo-failover.ts
 *
 * Teardown restores env + removes the tempdir.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { probeFleet, stateTransitions, type ProbeReport } from '../src/healer/probe.js';
import { appendHealerJournal } from '../src/healer/journal.js';

const NARRATIVE = `\
N.5 golden-path demo — failover (healer observation)
====================================================

What you're watching: the healer loop's probe-and-journal phase.
Tick 1 probes two gateways, both respond 200, journal records a
"tick" entry with zero unhealthy + zero transitions. Between ticks,
we flip the fake fetch so sirius-b returns 500. Tick 2 probes the
same gateways, journal records a "transition" entry (healthy →
unhealthy for sirius-b) plus a new "tick" entry.

Healer remediation (promote local, flip embersynth profile) is a
separate follow-up slice; this demo proves the observability layer.
`;

function banner(text: string): void {
  process.stdout.write(`\n─── ${text} ${'─'.repeat(Math.max(0, 60 - text.length))}\n`);
}

function seedTempFleet(): {
  kubeconfigPath: string;
  providersPath: string;
  journalPath: string;
  restore: () => void;
} {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-demo-failover-'));
  const kubeconfigPath = join(runtimeDir, 'kubeconfig');
  const providersPath = join(runtimeDir, 'sirius-providers.yaml');
  const journalPath = join(runtimeDir, 'healer-journal.jsonl');

  // Two gateway nodes. The fake fetch uses their baseUrls as the
  // health-check target so we can fail one without touching the
  // other.
  writeFileSync(
    kubeconfigPath,
    stringifyYaml({
      apiVersion: 'llamactl/v1',
      kind: 'Config',
      currentContext: 'default',
      contexts: [{ name: 'default', cluster: 'home', user: 'me' }],
      clusters: [
        {
          name: 'home',
          nodes: [
            {
              name: 'sirius-a',
              endpoint: '',
              kind: 'gateway',
              cloud: { provider: 'sirius', baseUrl: 'http://demo-a.local/v1' },
            },
            {
              name: 'sirius-b',
              endpoint: '',
              kind: 'gateway',
              cloud: { provider: 'sirius', baseUrl: 'http://demo-b.local/v1' },
            },
          ],
        },
      ],
      users: [{ name: 'me', token: 'local' }],
    }),
  );
  // Empty sirius providers file (probeFleet tolerates absence, but
  // we create it so the shape is deterministic).
  writeFileSync(providersPath, stringifyYaml({ providers: [] }));

  return {
    kubeconfigPath,
    providersPath,
    journalPath,
    restore: () => {
      rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}

function fakeFetchFactory(downHosts: Set<string>): typeof globalThis.fetch {
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const hostname = new URL(url).hostname;
    if (downHosts.has(hostname)) {
      return new Response('internal error', { status: 500 });
    }
    return new Response('ok', { status: 200 });
  };
  // Cast through unknown — typeof globalThis.fetch carries a
  // `preconnect` sibling we don't need for the probe.
  return impl as unknown as typeof globalThis.fetch;
}

function readJournal(
  path: string,
): Array<{ kind: string; ts: string; [k: string]: unknown }> {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function runTick(
  opts: {
    kubeconfigPath: string;
    siriusProvidersPath: string;
    journalPath: string;
    fetch: typeof globalThis.fetch;
    previous: ProbeReport | null;
    label: string;
  },
): Promise<ProbeReport> {
  banner(`Tick: ${opts.label}`);
  const report = await probeFleet({
    kubeconfigPath: opts.kubeconfigPath,
    siriusProvidersPath: opts.siriusProvidersPath,
    fetch: opts.fetch,
  });
  const transitions = stateTransitions(opts.previous, report);
  process.stdout.write(
    `  probes: ${report.probes.length}  unhealthy: ${report.unhealthy}  transitions: ${transitions.length}\n`,
  );
  for (const t of transitions) {
    process.stdout.write(`    ! transition ${t.name} (${t.kind}): ${t.from} → ${t.to}\n`);
  }
  for (const p of report.probes) {
    const tag = p.state === 'healthy' ? '✓' : '✗';
    process.stdout.write(
      `    ${tag} ${p.name.padEnd(12)} ${p.baseUrl.padEnd(32)} status=${p.status} latency=${p.latencyMs}ms\n`,
    );
  }
  // Same journal shape startHealerLoop writes — one transition line
  // per state change plus one tick summary.
  for (const t of transitions) {
    appendHealerJournal(
      {
        kind: 'transition',
        ts: report.ts,
        name: t.name,
        resourceKind: t.kind,
        from: t.from,
        to: t.to,
      },
      opts.journalPath,
    );
  }
  appendHealerJournal({ kind: 'tick', ts: report.ts, report }, opts.journalPath);
  return report;
}

async function main(): Promise<void> {
  process.stdout.write(NARRATIVE);
  const seeded = seedTempFleet();
  banner('Fleet seeded (2 sirius gateways, no real hosts)');
  process.stdout.write(`  kubeconfig: ${seeded.kubeconfigPath}\n`);
  process.stdout.write(`  providers:  ${seeded.providersPath}\n`);
  process.stdout.write(`  journal:    ${seeded.journalPath}\n`);

  try {
    // Tick 1 — both gateways healthy. `previous` is null so the
    // stateTransitions helper treats first-observed state as baseline,
    // NOT as a transition (matches startHealerLoop's own behavior).
    const tick1 = await runTick({
      kubeconfigPath: seeded.kubeconfigPath,
      siriusProvidersPath: seeded.providersPath,
      journalPath: seeded.journalPath,
      fetch: fakeFetchFactory(new Set()),
      previous: null,
      label: 'all healthy',
    });

    // Tick 2 — sirius-b dies between ticks. Feed tick1 as previous so
    // only the actual flip records as a transition.
    await runTick({
      kubeconfigPath: seeded.kubeconfigPath,
      siriusProvidersPath: seeded.providersPath,
      journalPath: seeded.journalPath,
      fetch: fakeFetchFactory(new Set(['demo-b.local'])),
      previous: tick1,
      label: 'sirius-b down',
    });

    banner('Journal entries written');
    const entries = readJournal(seeded.journalPath);
    for (const e of entries) {
      if (e.kind === 'tick') {
        const r = e.report as { probes: Array<{ name: string; state: string }> };
        const summary = r.probes
          .map((p) => `${p.name}=${p.state === 'healthy' ? '✓' : '✗'}`)
          .join(' ');
        process.stdout.write(`  [${e.ts}] tick: ${summary}\n`);
      } else if (e.kind === 'transition') {
        process.stdout.write(
          `  [${e.ts}] transition: ${e.name} (${e.resourceKind}) ${e.from} → ${e.to}\n`,
        );
      } else {
        process.stdout.write(`  [${e.ts}] ${e.kind}: ${JSON.stringify(e)}\n`);
      }
    }

    banner('Result');
    const transitions = entries.filter((e) => e.kind === 'transition');
    const ticks = entries.filter((e) => e.kind === 'tick');
    process.stdout.write(
      `  ticks=${ticks.length}  transitions=${transitions.length}\n`,
    );
    // Expected journal content:
    //   tick 1 — 2 bootstrap transitions (unknown → healthy for each
    //            gateway; matches stateTransitions semantics when the
    //            prior report is null)
    //   tick 2 — 1 real transition: sirius-b healthy → unhealthy
    // Total: 2 ticks, 3 transitions, one of which is the real failover.
    const realFailover = transitions.find(
      (t) => t.name === 'sirius-b' && t.from === 'healthy' && t.to === 'unhealthy',
    );
    const ok = ticks.length === 2 && transitions.length === 3 && realFailover !== undefined;
    process.stdout.write(`  ok=${ok}\n`);
    if (!ok) process.exitCode = 1;
  } finally {
    seeded.restore();
    banner('Teardown complete');
  }
}

main().catch((err) => {
  console.error('demo-failover crashed:', err);
  process.exitCode = 1;
});
