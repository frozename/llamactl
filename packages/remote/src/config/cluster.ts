import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * ~/.llamactl/cluster.yaml
 *
 * peers:
 *   - id: mac-mini
 *     endpoint: https://macmini.ai:7843
 *     caPemPath: ~/.llamactl/certs/mac-mini-ca.pem
 */
export interface PeerNode {
  id: string;
  endpoint: string;
  caPemPath?: string;
}

export interface ClusterConfig {
  peers: PeerNode[];
}

const PeerNodeSchema = z.object({
  id: z.string().min(1),
  endpoint: z.string().min(1),
  caPemPath: z.string().min(1).optional(),
});

const ClusterConfigSchema = z.object({
  peers: z.array(PeerNodeSchema).default([]),
});

export function defaultClusterConfigPath(): string {
  return join(homedir(), '.llamactl', 'cluster.yaml');
}

export function readClusterConfig(path: string = defaultClusterConfigPath()): ClusterConfig {
  if (!existsSync(path)) return { peers: [] };
  const raw = readFileSync(path, 'utf8');
  const parsed = parseYaml(raw);
  return ClusterConfigSchema.parse(parsed ?? {});
}
