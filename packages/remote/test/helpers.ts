import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auth,
  config as kubecfg,
  configSchema,
  createNodeClient,
  startAgentServer,
  tls,
  type NodeClient,
  type RunningAgent,
} from '../src/index.js';

export interface ClusterNodeHandle {
  name: string;
  url: string;
  port: number;
  fingerprint: string;
  runtimeDir: string;
  devStorage: string;
  /** Agent server (already running). */
  agent: RunningAgent;
  /** A dedicated client pointed at *this* node over HTTPS. */
  client: NodeClient;
  /** Stop the agent. Called by cluster.cleanup. */
  stop: () => Promise<void>;
}

export interface Cluster {
  nodes: ClusterNodeHandle[];
  /** Absolute path to a temp kubeconfig listing every node by name. */
  clusterConfigPath: string;
  /** Stops every agent and cleans up temp dirs. */
  cleanup: () => Promise<void>;
}

export interface MakeClusterOptions {
  /** Number of nodes or an array of per-node hints. */
  nodes: number | Array<{ name?: string }>;
}

/**
 * Spin up N in-process llamactl agents on 127.0.0.1 random ports, each
 * with its own hermetic runtime, and return a cluster handle with a
 * pre-written kubeconfig. Built on top of the CLI/core hermetic
 * `makeTempRuntime` idiom (packages/core/test/helpers.ts) but with the
 * additional agent-server + TLS cert plumbing.
 */
export async function makeCluster(opts: MakeClusterOptions): Promise<Cluster> {
  const specs: Array<{ name?: string }> = Array.isArray(opts.nodes)
    ? opts.nodes
    : Array.from({ length: opts.nodes }, () => ({}));

  const handles: ClusterNodeHandle[] = [];
  let cfg = configSchema.freshConfig();

  try {
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      const name = spec.name ?? `node${i + 1}`;
      const devStorage = mkdtempSync(join(tmpdir(), `llamactl-cluster-${name}-`));
      const runtimeDir = join(devStorage, 'ai-models', 'local-ai');
      const agentDir = join(devStorage, 'agent');
      const cert = await tls.generateSelfSignedCert({
        dir: agentDir,
        commonName: '127.0.0.1',
        hostnames: ['127.0.0.1', 'localhost'],
      });
      const token = auth.generateToken();
      const agent = startAgentServer({
        bindHost: '127.0.0.1',
        port: 0,
        tokenHash: token.hash,
        tls: { certPath: cert.certPath, keyPath: cert.keyPath },
        // Hermetic test clusters stay off the LAN — mDNS would
        // otherwise make every test run advertise itself.
        advertiseMdns: false,
      });
      cfg = kubecfg.upsertNode(cfg, 'home', {
        name,
        endpoint: agent.url,
        certificateFingerprint: cert.fingerprint,
        certificate: cert.certPem,
      });
      // Store the token inline on the 'me' user for simplicity. Since
      // there's only one user entry in a cluster.yaml produced by
      // freshConfig(), tests that need multi-user will have to extend
      // this helper — yagni.
      cfg = {
        ...cfg,
        users: cfg.users.map((u) =>
          u.name === 'me' ? { ...u, token: token.token } : u,
        ),
      };
      const client = createNodeClient(cfg, { nodeName: name });
      handles.push({
        name,
        url: agent.url,
        port: agent.port,
        fingerprint: cert.fingerprint,
        runtimeDir,
        devStorage,
        agent,
        client,
        stop: async () => {
          await agent.stop();
          rmSync(devStorage, { recursive: true, force: true });
        },
      });
    }
  } catch (err) {
    // Partial failure cleanup so tests don't leak Bun servers.
    for (const h of handles) await h.stop().catch(() => {});
    throw err;
  }

  const clusterConfigPath = join(
    mkdtempSync(join(tmpdir(), 'llamactl-cluster-config-')),
    'config',
  );
  kubecfg.saveConfig(cfg, clusterConfigPath);

  return {
    nodes: handles,
    clusterConfigPath,
    cleanup: async () => {
      for (const h of handles) await h.stop().catch(() => {});
      rmSync(clusterConfigPath, { force: true });
    },
  };
}
