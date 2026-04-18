import { describe, test, expect, afterAll } from 'bun:test';
import {
  config as kubecfg,
  makePinnedFetch,
  type ClusterNode,
  type PinnedFetch,
} from '@llamactl/remote';
import { makeCluster, type Cluster } from '../../remote/test/helpers';

let cluster: Cluster | null = null;

afterAll(async () => {
  await cluster?.cleanup();
});

/**
 * End-to-end smoke test for the Electron main dispatcher router.
 *
 * The dispatcher's job is to route every renderer call based on the
 * kubeconfig's currently-selected default node:
 *   - local endpoint → fall through to baseRouter.createCaller({})
 *   - remote endpoint → forward via pinned-TLS tRPC client
 *   - control-plane-only procedure → always local, regardless of selection
 *
 * Since the cluster agent runs in the same Bun process as the test, we
 * can't rely on response-content differences to prove forwarding.
 * Instead, wrap the pinned-fetch factory with a spy that records every
 * outbound URL. Fetches mean forwarding happened; no fetches means the
 * local caller ran.
 */
describe('Electron dispatcher router', () => {
  function spyFactory(urls: string[]) {
    return (node: ClusterNode): PinnedFetch => {
      const inner = makePinnedFetch(node);
      return async (input, init) => {
        urls.push(typeof input === 'string' ? input : String(input));
        return inner(input, init);
      };
    };
  }

  test('forwards query to remote when that node is default', async () => {
    const c = cluster ?? (await makeCluster({ nodes: [{ name: 'remote1' }] }));
    cluster = c;
    process.env['LLAMACTL_CONFIG'] = c.clusterConfigPath;
    kubecfg.saveConfig(
      kubecfg.setDefaultNode(kubecfg.loadConfig(c.clusterConfigPath), 'remote1'),
      c.clusterConfigPath,
    );
    const urls: string[] = [];
    const { buildDispatcherRouter } = await import('../electron/trpc/dispatcher');
    const dispatcher = buildDispatcherRouter(spyFactory(urls));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caller = (dispatcher as any).createCaller({});
    const res = await caller.env();
    expect(res).toBeTruthy();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toContain(c.nodes[0]!.url);
    expect(urls[0]).toContain('/trpc/env');
  }, 15_000);

  test('falls through locally when default is local', async () => {
    const c = cluster ?? (await makeCluster({ nodes: [{ name: 'remote1' }] }));
    cluster = c;
    process.env['LLAMACTL_CONFIG'] = c.clusterConfigPath;
    kubecfg.saveConfig(
      kubecfg.setDefaultNode(kubecfg.loadConfig(c.clusterConfigPath), 'local'),
      c.clusterConfigPath,
    );
    const urls: string[] = [];
    const { buildDispatcherRouter } = await import('../electron/trpc/dispatcher');
    const dispatcher = buildDispatcherRouter((node) => {
      const inner = makePinnedFetch(node);
      return async (input, init) => {
        urls.push(typeof input === 'string' ? input : String(input));
        return inner(input, init);
      };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caller = (dispatcher as any).createCaller({});
    const res = await caller.env();
    expect(res).toBeTruthy();
    expect(urls.length).toBe(0);
  }, 15_000);

  test('forwards subscription events from remote', async () => {
    const c = cluster ?? (await makeCluster({ nodes: [{ name: 'remote1' }] }));
    cluster = c;
    process.env['LLAMACTL_CONFIG'] = c.clusterConfigPath;
    kubecfg.saveConfig(
      kubecfg.setDefaultNode(kubecfg.loadConfig(c.clusterConfigPath), 'remote1'),
      c.clusterConfigPath,
    );
    const urls: string[] = [];
    const { buildDispatcherRouter } = await import('../electron/trpc/dispatcher');
    const dispatcher = buildDispatcherRouter(spyFactory(urls));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caller = (dispatcher as any).createCaller({});

    // serverLogs runs tailServerLog against the agent's empty log dir
    // and completes quickly with no lines when follow is false.
    const iterable = (await caller.serverLogs({
      lines: 0,
      follow: false,
    })) as AsyncIterable<unknown>;
    const events: unknown[] = [];
    for await (const ev of iterable) events.push(ev);
    // Proves the forwarding path reached the agent's SSE endpoint.
    expect(urls.some((u) => u.includes('/trpc/serverLogs'))).toBe(true);
    // The remote agent has no server.log, so zero events is fine — we
    // just care that the stream completed without throwing.
    expect(Array.isArray(events)).toBe(true);
  }, 15_000);

  test('UI active-node override takes precedence over kubeconfig', async () => {
    const c = cluster ?? (await makeCluster({ nodes: [{ name: 'remote1' }] }));
    cluster = c;
    process.env['LLAMACTL_CONFIG'] = c.clusterConfigPath;
    // Kubeconfig says LOCAL, override says REMOTE → dispatcher must
    // forward (override wins).
    kubecfg.saveConfig(
      kubecfg.setDefaultNode(kubecfg.loadConfig(c.clusterConfigPath), 'local'),
      c.clusterConfigPath,
    );
    const urls: string[] = [];
    const { buildDispatcherRouter } = await import('../electron/trpc/dispatcher');
    const dispatcher = buildDispatcherRouter(spyFactory(urls));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caller = (dispatcher as any).createCaller({});
    const mod = await import('../electron/trpc/dispatcher');
    await caller.uiSetActiveNode({ name: 'remote1' });
    try {
      await caller.env();
      expect(urls.some((u) => u.includes(c.nodes[0]!.url))).toBe(true);
    } finally {
      mod.__resetActiveNodeOverrideForTests();
    }
  }, 15_000);

  test('control-plane-only procedures bypass dispatch', async () => {
    const c = cluster ?? (await makeCluster({ nodes: [{ name: 'remote1' }] }));
    cluster = c;
    process.env['LLAMACTL_CONFIG'] = c.clusterConfigPath;
    kubecfg.saveConfig(
      kubecfg.setDefaultNode(kubecfg.loadConfig(c.clusterConfigPath), 'remote1'),
      c.clusterConfigPath,
    );
    const urls: string[] = [];
    const { buildDispatcherRouter } = await import('../electron/trpc/dispatcher');
    const dispatcher = buildDispatcherRouter((node) => {
      const inner = makePinnedFetch(node);
      return async (input, init) => {
        urls.push(typeof input === 'string' ? input : String(input));
        return inner(input, init);
      };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caller = (dispatcher as any).createCaller({});

    // nodeList must come from the control plane even when the remote
    // node is selected — the remote agent doesn't host a kubeconfig
    // with this cluster's registered nodes.
    const list = await caller.nodeList();
    const names = list.nodes.map((n: { name: string }) => n.name);
    expect(names).toContain('local');
    expect(names).toContain('remote1');
    expect(urls.length).toBe(0);
  }, 15_000);
});
