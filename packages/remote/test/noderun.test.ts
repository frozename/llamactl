import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  NodeRunSchema,
  type NodeRun,
} from '../src/workload/noderun-schema.js';
import {
  deleteNodeRun,
  listNodeRuns,
  loadNodeRunByName,
  saveNodeRun,
} from '../src/workload/noderun-store.js';
import {
  applyNodeRun,
  planNodeRun,
  type NodeRunInfraClient,
} from '../src/workload/noderun-apply.js';
import type { InstalledInfra } from '../src/infra/layout.js';
import type { InstallResult } from '../src/infra/install.js';

let dir = '';

function seedManifestOnDisk(manifest: unknown, name: string): string {
  const path = join(dir, `${name}.yaml`);
  writeFileSync(path, stringifyYaml(manifest), 'utf8');
  return path;
}

function sampleManifest(overrides: Partial<NodeRun['spec']> = {}): NodeRun {
  return NodeRunSchema.parse({
    apiVersion: 'llamactl/v1',
    kind: 'NodeRun',
    metadata: { name: 'gpu1-fleet' },
    spec: {
      node: 'gpu1',
      infra: [
        { pkg: 'llama-cpp', version: 'b4500' },
        { pkg: 'embersynth', version: '0.2.0', service: true, env: { EMBERSYNTH_PORT: '7777' } },
      ],
      ...overrides,
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llamactl-noderun-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('NodeRun schema', () => {
  test('parses a well-formed manifest', () => {
    const m = sampleManifest();
    expect(m.spec.node).toBe('gpu1');
    expect(m.spec.infra).toHaveLength(2);
    expect(m.spec.infra[1]!.service).toBe(true);
    expect(m.spec.infra[1]!.env).toEqual({ EMBERSYNTH_PORT: '7777' });
    expect(m.spec.infra[0]!.replicas).toBe(1);
  });

  test('rejects duplicate pkg entries', () => {
    expect(() =>
      NodeRunSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'NodeRun',
        metadata: { name: 'x' },
        spec: {
          node: 'gpu1',
          infra: [
            { pkg: 'llama-cpp', version: 'b4500' },
            { pkg: 'llama-cpp', version: 'b4501' },
          ],
        },
      }),
    ).toThrow(/unique/);
  });

  test('rejects tarballUrl without sha256 and vice versa', () => {
    const base = {
      apiVersion: 'llamactl/v1',
      kind: 'NodeRun',
      metadata: { name: 'x' },
      spec: {
        node: 'gpu1',
        infra: [{ pkg: 'llama-cpp', version: 'b4500', tarballUrl: 'https://...' }],
      },
    };
    expect(() => NodeRunSchema.parse(base)).toThrow(/tarballUrl/);
  });

  test('rejects invalid metadata.name', () => {
    expect(() =>
      NodeRunSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'NodeRun',
        metadata: { name: 'BadName' },
        spec: { node: 'gpu1', infra: [] },
      }),
    ).toThrow(/lowercase alphanumeric/);
  });
});

describe('NodeRun store', () => {
  test('save + load round-trips', () => {
    const m = sampleManifest();
    saveNodeRun(m, dir);
    const loaded = loadNodeRunByName(m.metadata.name, dir);
    expect(loaded.spec.node).toBe('gpu1');
    expect(loaded.spec.infra[1]!.pkg).toBe('embersynth');
  });

  test('listNodeRuns filters by kind — ignores ModelRun peers', () => {
    saveNodeRun(sampleManifest(), dir);
    // Drop a ModelRun peer in the same dir; it should NOT show up.
    seedManifestOnDisk(
      {
        apiVersion: 'llamactl/v1',
        kind: 'ModelRun',
        metadata: { name: 'some-model' },
        spec: {
          node: 'local',
          target: { kind: 'rel', value: 'foo/bar.gguf' },
        },
      },
      'some-model',
    );
    const rows = listNodeRuns(dir);
    expect(rows.map((r) => r.metadata.name)).toEqual(['gpu1-fleet']);
  });

  test('deleteNodeRun returns false when absent, true when it removes a file', () => {
    expect(deleteNodeRun('nope', dir)).toBe(false);
    saveNodeRun(sampleManifest(), dir);
    expect(deleteNodeRun('gpu1-fleet', dir)).toBe(true);
    expect(listNodeRuns(dir)).toEqual([]);
  });
});

describe('planNodeRun (pure diff)', () => {
  test('desired pkgs missing → install actions; nothing live → no uninstalls', () => {
    const spec = sampleManifest().spec;
    const actions = planNodeRun(spec, []);
    const installs = actions.filter((a) => a.type === 'install');
    expect(installs.map((a) => a.pkg).sort()).toEqual(['embersynth', 'llama-cpp']);
    for (const a of installs) {
      if (a.type === 'install') expect(a.reason).toBe('missing');
    }
    expect(actions.some((a) => a.type === 'uninstall-pkg')).toBe(false);
  });

  test('version mismatch vs. side-by-side installed version', () => {
    const spec = sampleManifest({
      infra: [{ pkg: 'llama-cpp', version: 'b4500', service: false, env: {}, replicas: 1 }],
    }).spec;
    // Live: different active, but the desired version IS installed side-by-side.
    const live: InstalledInfra[] = [
      { pkg: 'llama-cpp', versions: ['b4499', 'b4500'], active: 'b4499' },
    ];
    const actions = planNodeRun(spec, live);
    const types = actions.map((a) => a.type).sort();
    expect(types).toContain('activate');
    expect(types).toContain('uninstall-version');
  });

  test('version not installed at all → install action', () => {
    const spec = sampleManifest({
      infra: [{ pkg: 'llama-cpp', version: 'b4500', service: false, env: {}, replicas: 1 }],
    }).spec;
    const live: InstalledInfra[] = [
      { pkg: 'llama-cpp', versions: ['b4000'], active: 'b4000' },
    ];
    const actions = planNodeRun(spec, live);
    const install = actions.find((a) => a.type === 'install');
    expect(install).toBeTruthy();
    if (install && install.type === 'install') expect(install.reason).toBe('version-mismatch');
    const uninstall = actions.find((a) => a.type === 'uninstall-version');
    expect(uninstall).toBeTruthy();
  });

  test('already-current → skip, no other actions for that pkg', () => {
    const spec = sampleManifest({
      infra: [{ pkg: 'llama-cpp', version: 'b4500', service: false, env: {}, replicas: 1 }],
    }).spec;
    const live: InstalledInfra[] = [
      { pkg: 'llama-cpp', versions: ['b4500'], active: 'b4500' },
    ];
    const actions = planNodeRun(spec, live);
    expect(actions).toEqual([
      { type: 'skip', pkg: 'llama-cpp', version: 'b4500', reason: 'already-current' },
    ]);
  });

  test('live pkg not in desired → uninstall-pkg', () => {
    const spec = sampleManifest({
      infra: [{ pkg: 'llama-cpp', version: 'b4500', service: false, env: {}, replicas: 1 }],
    }).spec;
    const live: InstalledInfra[] = [
      { pkg: 'llama-cpp', versions: ['b4500'], active: 'b4500' },
      { pkg: 'obsolete-pkg', versions: ['1.0'], active: '1.0' },
    ];
    const actions = planNodeRun(spec, live);
    const uninstall = actions.find(
      (a) => a.type === 'uninstall-pkg' && a.pkg === 'obsolete-pkg',
    );
    expect(uninstall).toBeTruthy();
  });
});

describe('applyNodeRun (end-to-end against a mock client)', () => {
  function makeClient(
    overrides: Partial<NodeRunInfraClient> = {},
    liveBefore: InstalledInfra[] = [],
    liveAfter?: InstalledInfra[],
  ): { client: NodeRunInfraClient; calls: string[] } {
    const calls: string[] = [];
    let live = liveBefore;
    const after = liveAfter ?? liveBefore;
    let postApply = false;
    const client: NodeRunInfraClient = {
      infraList: {
        async query() {
          calls.push('infraList');
          const current = postApply ? after : live;
          if (!postApply) postApply = true;
          return current;
        },
      },
      infraInstall: {
        async mutate(input) {
          calls.push(`infraInstall:${input.pkg}@${input.version}`);
          return {
            ok: true,
            state: 'installed',
            versionDir: `/infra/${input.pkg}/${input.version}`,
            activated: input.activate ?? true,
          } as InstallResult;
        },
      },
      infraActivate: {
        async mutate(input) {
          calls.push(`infraActivate:${input.pkg}@${input.version}`);
          return { ok: true as const };
        },
      },
      infraUninstall: {
        async mutate(input) {
          const suffix = input.version ? `@${input.version}` : '';
          calls.push(`infraUninstall:${input.pkg}${suffix}`);
          return {
            ok: true as const,
            mode: input.version ? ('version' as const) : ('package' as const),
            removed: true,
          };
        },
      },
      ...overrides,
    };
    return { client, calls };
  }

  const FAKE_ARTIFACT = { tarballUrl: 'https://x', sha256: 'a'.repeat(64) };

  test('installs both desired pkgs when nothing is live', async () => {
    const manifest = sampleManifest();
    const { client, calls } = makeClient(
      {},
      [],
      [
        { pkg: 'llama-cpp', versions: ['b4500'], active: 'b4500' },
        { pkg: 'embersynth', versions: ['0.2.0'], active: '0.2.0' },
      ],
    );
    const result = await applyNodeRun(manifest, {
      client,
      resolveArtifact: async () => FAKE_ARTIFACT,
    });
    expect(result.outcomes.map((o) => o.ok)).toEqual([true, true]);
    expect(result.status.phase).toBe('Converged');
    expect(calls.filter((c) => c.startsWith('infraInstall')).sort()).toEqual([
      'infraInstall:embersynth@0.2.0',
      'infraInstall:llama-cpp@b4500',
    ]);
  });

  test('dry-run returns actions without calling mutation endpoints', async () => {
    const manifest = sampleManifest();
    const { client, calls } = makeClient();
    const result = await applyNodeRun(manifest, {
      client,
      resolveArtifact: async () => FAKE_ARTIFACT,
      dryRun: true,
    });
    expect(result.status.phase).toBe('Drift');
    expect(result.actions.length).toBeGreaterThan(0);
    // Only infraList was called — no mutations.
    expect(calls).toEqual(['infraList']);
  });

  test('all-current returns Converged with only skip actions', async () => {
    const manifest = sampleManifest();
    const { client } = makeClient(
      {},
      [
        { pkg: 'llama-cpp', versions: ['b4500'], active: 'b4500' },
        { pkg: 'embersynth', versions: ['0.2.0'], active: '0.2.0' },
      ],
    );
    const result = await applyNodeRun(manifest, {
      client,
      resolveArtifact: async () => FAKE_ARTIFACT,
    });
    expect(result.status.phase).toBe('Converged');
    expect(result.actions.every((a) => a.type === 'skip')).toBe(true);
  });

  test('failed install surfaces phase: Failed + condition carries the error', async () => {
    const manifest = sampleManifest({
      infra: [{ pkg: 'llama-cpp', version: 'b4500', service: false, env: {}, replicas: 1 }],
    });
    const { client } = makeClient(
      {
        infraInstall: {
          async mutate() {
            return {
              ok: false,
              reason: 'fetch-failed',
              error: 'DNS fail',
            } as InstallResult;
          },
        },
      },
    );
    const result = await applyNodeRun(manifest, {
      client,
      resolveArtifact: async () => FAKE_ARTIFACT,
    });
    expect(result.status.phase).toBe('Failed');
    expect(result.error).toContain('DNS fail');
    expect(result.status.conditions[0]!.status).toBe('False');
    expect(result.status.conditions[0]!.reason).toBe('partial-failure');
  });

  test('unwanted live pkg gets uninstalled', async () => {
    const manifest = sampleManifest({
      infra: [{ pkg: 'llama-cpp', version: 'b4500', service: false, env: {}, replicas: 1 }],
    });
    const { client, calls } = makeClient(
      {},
      [
        { pkg: 'llama-cpp', versions: ['b4500'], active: 'b4500' },
        { pkg: 'ghost-pkg', versions: ['1.0'], active: '1.0' },
      ],
    );
    const result = await applyNodeRun(manifest, {
      client,
      resolveArtifact: async () => FAKE_ARTIFACT,
    });
    expect(result.status.phase).toBe('Converged');
    expect(calls).toContain('infraUninstall:ghost-pkg');
  });
});
