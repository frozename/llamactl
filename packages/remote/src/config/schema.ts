import { z } from 'zod';

export const GpuFactsSchema = z.object({
  kind: z.enum(['metal', 'cuda', 'rocm', 'cpu']),
  name: z.string().optional(),
  memoryMB: z.number().optional(),
});

export const NodeFactsSchema = z.object({
  profile: z.enum(['mac-mini-16g', 'balanced', 'macbook-pro-48g']),
  memBytes: z.number().nullable(),
  os: z.string(),
  arch: z.string(),
  platform: z.string(),
  llamaCppBuildId: z.string().nullable(),
  gpu: GpuFactsSchema.nullable(),
  versions: z.object({
    llamactl: z.string(),
    bun: z.string(),
    llamaCppSrcRev: z.string().nullable(),
  }),
  startedAt: z.string(),
});

export const ClusterNodeSchema = z.object({
  name: z.string().min(1),
  endpoint: z.string().min(1),
  certificateFingerprint: z.string().optional(),
  certificate: z.string().optional(),
  facts: NodeFactsSchema.partial().optional(),
});

export const ClusterSchema = z.object({
  name: z.string().min(1),
  nodes: z.array(ClusterNodeSchema).default([]),
});

export const ContextSchema = z.object({
  name: z.string().min(1),
  cluster: z.string().min(1),
  user: z.string().min(1),
  defaultNode: z.string().min(1).default('local'),
});

export const UserSchema = z.object({
  name: z.string().min(1),
  tokenRef: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
}).refine((u) => u.tokenRef !== undefined || u.token !== undefined, {
  message: 'user must have either tokenRef or token',
});

export const ConfigSchema = z.object({
  apiVersion: z.literal('llamactl/v1'),
  kind: z.literal('Config'),
  currentContext: z.string().min(1),
  contexts: z.array(ContextSchema).default([]),
  clusters: z.array(ClusterSchema).default([]),
  users: z.array(UserSchema).default([]),
});

export type GpuFacts = z.infer<typeof GpuFactsSchema>;
export type NodeFacts = z.infer<typeof NodeFactsSchema>;
export type ClusterNode = z.infer<typeof ClusterNodeSchema>;
export type Cluster = z.infer<typeof ClusterSchema>;
export type Context = z.infer<typeof ContextSchema>;
export type User = z.infer<typeof UserSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export const LOCAL_NODE_NAME = 'local';
export const LOCAL_NODE_ENDPOINT = 'inproc://local';

export function freshConfig(): Config {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'Config',
    currentContext: 'default',
    contexts: [
      { name: 'default', cluster: 'home', user: 'me', defaultNode: LOCAL_NODE_NAME },
    ],
    clusters: [
      { name: 'home', nodes: [{ name: LOCAL_NODE_NAME, endpoint: LOCAL_NODE_ENDPOINT }] },
    ],
    users: [{ name: 'me', token: 'inproc-local' }],
  };
}
