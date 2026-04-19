import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { reconcileNodeRunsOnce } from '../src/workload/noderun-reconciler.js';
import {
  NodeRunSchema,
  type NodeRun,
} from '../src/workload/noderun-schema.js';
import { saveNodeRun } from '../src/workload/noderun-store.js';
import type { NodeRunInfraClient } from '../src/workload/noderun-apply.js';
import type { InstalledInfra } from '../src/infra/layout.js';
import type { InstallResult } from '../src/infra/install.js';

let dir = '';

function sampleManifest(name: string, node: string, pkg = 'llama-cpp'): NodeRun {
  return NodeRunSchema.parse({
    apiVersion: 'llamactl/v1',
    kind: 'NodeRun',
    metadata: { name },
    spec: {
      node,
      infra: [{ pkg, version: 'b4500' }],
    },
  });
}

function mockClient(live: InstalledInfra[] = []): NodeRunInfraClient {
  let after = live;
  let queried = false;
  return {
    infraList: {
      async query() {
        // After the first query (pre-apply), flip to post-apply state
        // simulating installs.
        if (!queried) {
          queried = true;
          return live;
        }
        return after;
      },
    },
    infraInstall: {
      async mutate(input) {
        const result: InstallResult = {
          ok: true,
          state: 'installed',
          versionDir: `/fake/${input.pkg}/${input.version}`,
          activated: true,
        };
        after = [
          ...after,
          { pkg: input.pkg, versions: [input.version], active: input.version },
        ];
        return result;
      },
    },
    infraActivate: {
      async mutate() {
        return { ok: true as const };
      },
    },
    infraUninstall: {
      async mutate() {
        return { ok: true as const, mode: 'package' as const, removed: true };
      },
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llamactl-noderun-reconciler-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('reconcileNodeRunsOnce', () => {
  test('empty dir → empty reports + errors: 0', async () => {
    const result = await reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: () => mockClient(),
      getArtifactResolver: () =>
        async () => ({ tarballUrl: 'https://x', sha256: 'a'.repeat(64) }),
    });
    expect(result.reports).toEqual([]);
    expect(result.errors).toBe(0);
  });

  test('reconciles every NodeRun manifest and persists new status', async () => {
    saveNodeRun(sampleManifest('local-fleet', 'local'), dir);
    saveNodeRun(sampleManifest('gpu1-fleet', 'gpu1'), dir);
    const calls: string[] = [];
    const result = await reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: (node) => {
        calls.push(node);
        return mockClient();
      },
      getArtifactResolver: () =>
        async () => ({ tarballUrl: 'https://x', sha256: 'a'.repeat(64) }),
    });
    expect(result.reports).toHaveLength(2);
    expect(result.errors).toBe(0);
    expect(calls.sort()).toEqual(['gpu1', 'local']);
    // Status persisted back to disk.
    const local = parseYaml(readFileSync(join(dir, 'local-fleet.yaml'), 'utf8')) as NodeRun;
    expect(local.status?.phase).toBe('Converged');
  });

  test('filter narrows to a subset', async () => {
    saveNodeRun(sampleManifest('a', 'nodeA'), dir);
    saveNodeRun(sampleManifest('b', 'nodeB'), dir);
    const result = await reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: () => mockClient(),
      getArtifactResolver: () =>
        async () => ({ tarballUrl: 'https://x', sha256: 'a'.repeat(64) }),
      filter: (m) => m.metadata.name === 'a',
    });
    expect(result.reports.map((r) => r.name)).toEqual(['a']);
  });

  test('onReport fires per manifest, in order', async () => {
    saveNodeRun(sampleManifest('a', 'nodeA'), dir);
    saveNodeRun(sampleManifest('b', 'nodeB'), dir);
    const names: string[] = [];
    await reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: () => mockClient(),
      getArtifactResolver: () =>
        async () => ({ tarballUrl: 'https://x', sha256: 'a'.repeat(64) }),
      onReport: (r) => names.push(r.manifestName),
    });
    // listNodeRuns returns alphabetical order.
    expect(names).toEqual(['a', 'b']);
  });

  test('client throws → surfaces as phase:Failed + errors:1 without tearing down the loop', async () => {
    saveNodeRun(sampleManifest('a', 'down-node'), dir);
    saveNodeRun(sampleManifest('b', 'good-node'), dir);
    const result = await reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: (node) => {
        if (node === 'down-node') {
          throw new Error('node unreachable');
        }
        return mockClient();
      },
      getArtifactResolver: () =>
        async () => ({ tarballUrl: 'https://x', sha256: 'a'.repeat(64) }),
    });
    expect(result.errors).toBe(1);
    expect(result.reports).toHaveLength(2);
    const failed = result.reports.find((r) => r.name === 'a')!;
    expect(failed.phase).toBe('Failed');
    expect(failed.error).toMatch(/node unreachable/);
    const ok = result.reports.find((r) => r.name === 'b')!;
    expect(ok.phase).toBe('Converged');
  });
});
