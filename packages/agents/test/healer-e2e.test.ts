import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  createDefaultToolClient,
  startHealerLoop,
  type JournalEntry,
  type JournalPlanFailedEntry,
  type JournalTickEntry,
  type JournalTransitionEntry,
} from '../src/index.js';

/**
 * Cross-cutting end-to-end test for the healer loop.
 *
 * Boots the REAL in-proc toolClient (`createDefaultToolClient`), which
 * mounts `buildMcpServer` + `buildNovaMcpServer` over
 * `InMemoryTransport.createLinkedPair()` — no mocks on either MCP
 * surface. Runs one healer tick against a seeded tempdir fleet whose
 * single gateway points at a closed port so `nova.ops.healthcheck`
 * legitimately reports it unhealthy.
 *
 * Coverage this test uniquely contributes on top of the unit suite:
 *   1. The real in-proc MCP boot pipeline works (both servers start +
 *      handshake + listTools).
 *   2. The real `nova.ops.healthcheck` envelope (content:[{type,text}]
 *      wrapping the gateway/provider probe payload) round-trips through
 *      `probeFleetViaNova` without schema drift.
 *   3. The real `nova.operator.plan` envelope round-trips through
 *      `askPlanner`.
 *
 * Design note on the planner step.
 * `createDefaultToolClient()` does not pass `plannerTools` into
 * `buildNovaMcpServer`, so the planner's allowlist is empty. With the
 * canned stub executor (default until the LLM binding ships in N.4.3),
 * `runPlanner` deterministically returns
 *   `{ok: false, reason: 'disallowed-tool'}`
 * which the loop journals as a `plan-failed` entry. That is both
 * deterministic and still exercises the envelope parsing in
 * `askPlanner` end-to-end — precisely the gap the unit tests (which
 * mock the toolClient) leave uncovered. No LLM key, no network, no
 * flaky timing.
 *
 * Cleanup: disposes the toolClient, restores env, and rms the tempdir
 * in `afterEach` so re-runs (and concurrent test files) do not leak.
 */

let runtimeDir = '';
let auditDir = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-healer-e2e-'));
  auditDir = mkdtempSync(join(tmpdir(), 'llamactl-healer-e2e-audit-'));

  const kubeconfigPath = join(runtimeDir, 'config');
  const siriusProvidersPath = join(runtimeDir, 'sirius-providers.yaml');
  const embersynthConfigPath = join(runtimeDir, 'embersynth.yaml');

  // One gateway pointing at a closed port so the real healthcheck
  // legitimately reports unhealthy without any network mocking.
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
  writeFileSync(
    siriusProvidersPath,
    stringifyYaml({
      providers: [
        {
          name: 'sirius-unreachable',
          kind: 'openai',
          baseUrl: 'http://127.0.0.1:1/v1',
        },
      ],
    }),
  );
  // Embersynth config has to exist (empty is fine) so nova's overview
  // tools do not complain — the healthcheck tool itself doesn't read it,
  // but keeping the fixture self-consistent avoids surprising
  // cross-tool reads if the harness grows later.
  writeFileSync(embersynthConfigPath, stringifyYaml({ nodes: [], profiles: [] }));

  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: runtimeDir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(runtimeDir, 'preset-overrides.tsv'),
    LLAMACTL_MCP_AUDIT_DIR: auditDir,
    LLAMACTL_CONFIG: kubeconfigPath,
    LLAMACTL_PROVIDERS_FILE: siriusProvidersPath,
    LLAMACTL_EMBERSYNTH_CONFIG: embersynthConfigPath,
    LLAMACTL_HEALER_JOURNAL: join(runtimeDir, 'healer-journal.jsonl'),
  });
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  rmSync(runtimeDir, { recursive: true, force: true });
  rmSync(auditDir, { recursive: true, force: true });
});

describe('healer e2e: real in-proc MCP + healthcheck + planner', () => {
  test('one tick journals facade-sourced tick, unknown→unhealthy transition, and plan-failed', async () => {
    const handle = await createDefaultToolClient();
    try {
      const journalPath = join(runtimeDir, 'healer-journal.jsonl');
      const loop = startHealerLoop({
        kubeconfigPath: join(runtimeDir, 'config'),
        siriusProvidersPath: join(runtimeDir, 'sirius-providers.yaml'),
        // Short but non-zero — the healthcheck probe itself uses its
        // own default timeout; this is the healer-tick timeout.
        timeoutMs: 500,
        once: true,
        toolClient: handle.client,
        mode: 'auto',
        severityThreshold: 2,
        journalPath,
      });
      await loop.done;

      const body = readFileSync(journalPath, 'utf8').trim();
      expect(body.length).toBeGreaterThan(0);
      const entries: JournalEntry[] = body
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as JournalEntry);

      // (1) Real facade path produced a tick entry tagged `source: 'nova'`.
      const ticks = entries.filter(
        (e): e is JournalTickEntry => e.kind === 'tick',
      );
      expect(ticks).toHaveLength(1);
      const tick = ticks[0]!;
      expect(tick.source).toBe('nova');
      expect(tick.report.unhealthy).toBeGreaterThanOrEqual(1);
      // The gateway probe round-tripped through probeFleetViaNova with
      // the exact fields the normalizer expects.
      const gatewayProbe = tick.report.probes.find(
        (p) => p.kind === 'gateway' && p.name === 'sirius-primary',
      );
      expect(gatewayProbe).toBeDefined();
      expect(gatewayProbe?.state).toBe('unhealthy');

      // (2) First-seen gateway flips unknown→unhealthy — exactly one
      // transition entry for it.
      const transitions = entries.filter(
        (e): e is JournalTransitionEntry => e.kind === 'transition',
      );
      const gatewayTransition = transitions.find(
        (t) => t.resourceKind === 'gateway' && t.name === 'sirius-primary',
      );
      expect(gatewayTransition).toBeDefined();
      expect(gatewayTransition?.from).toBe('unknown');
      expect(gatewayTransition?.to).toBe('unhealthy');

      // (3) Real planner envelope round-tripped through askPlanner.
      // The canned stub executor + empty plannerTools deterministically
      // surfaces `{ok:false, reason:'disallowed-tool'}`, which the loop
      // writes as a plan-failed entry. That is the outcome we want the
      // test to pin: it proves the envelope parser handles the real
      // `{ok:false, ...}` shape and that no step executed.
      const planFailed = entries.find(
        (e): e is JournalPlanFailedEntry => e.kind === 'plan-failed',
      );
      expect(planFailed).toBeDefined();
      expect(planFailed?.transition.name).toBe('sirius-primary');
      expect(planFailed?.reason).toBe('disallowed-tool');
      expect(typeof planFailed?.message).toBe('string');

      // Belt and braces: no spurious executed/refused entries since
      // the plan failed before the gate.
      expect(entries.find((e) => e.kind === 'executed')).toBeUndefined();
      expect(entries.find((e) => e.kind === 'refused')).toBeUndefined();
      expect(entries.find((e) => e.kind === 'proposal')).toBeUndefined();
    } finally {
      await handle.dispose();
    }
  });
});
