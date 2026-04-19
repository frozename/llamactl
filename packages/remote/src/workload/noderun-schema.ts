import { z } from 'zod';

/**
 * NodeRun — declarative "this node should run this set of infra".
 * Peer of ModelRun; consumed by the same `llamactl apply -f` CLI.
 *
 * Reconciler flow (Phase I.4):
 *   1. List manifests under ~/.llamactl/workloads/ (mixed kinds OK).
 *   2. For each NodeRun, call the target node's `infraList`.
 *   3. Diff desired `spec.infra` against observed; issue
 *      `infraInstall`/`infraActivate`/`infraUninstall` as needed.
 *   4. Persist the new status back into the manifest file.
 *
 * Service-package lifecycle (embersynth, sirius) layers on top via
 * the service adapters in a follow-up commit — this schema carries
 * the `service`, `env`, `replicas` fields ahead of time so the
 * manifest shape stays stable when they light up.
 */

export const NodeRunInfraItemSchema = z.object({
  /** Package name — must have a matching spec under
   *  ~/.llamactl/packages/<pkg>.yaml for the reconciler to resolve
   *  (url, sha256). Ad-hoc `tarballUrl`/`sha256` entries bypass the
   *  spec lookup. */
  pkg: z.string().min(1),
  version: z.string().min(1),
  /** Whether this entry runs as a supervised service or a bare
   *  binary. Default false — matches InfraVersionSpec. */
  service: z.boolean().default(false),
  /** Environment variables threaded into the service launchd plist /
   *  systemd unit. Ignored for non-service packages. */
  env: z.record(z.string(), z.string()).default({}),
  /** Ad-hoc artifact override. When both set, the reconciler skips
   *  the spec lookup for this entry and pushes the tarball directly. */
  tarballUrl: z.string().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  /** `replicas` reserved for the future "many instances of this
   *  service on this node" case (multi-embersynth / multi-sirius).
   *  v1 treats anything > 1 as an error at apply time. */
  replicas: z.number().int().positive().default(1),
}).refine(
  (item) => (item.tarballUrl == null) === (item.sha256 == null),
  { message: 'tarballUrl + sha256 must be set together or both omitted' },
);
export type NodeRunInfraItem = z.infer<typeof NodeRunInfraItemSchema>;

export const NodeRunSpecSchema = z.object({
  node: z.string().min(1),
  infra: z.array(NodeRunInfraItemSchema).default([]),
}).refine(
  (spec) => {
    // One entry per pkg. Multi-replica / multi-instance support comes
    // later; for v1, duplicate pkg entries are a manifest error the
    // reconciler shouldn't silently deduplicate.
    const names = new Set<string>();
    for (const item of spec.infra) {
      if (names.has(item.pkg)) return false;
      names.add(item.pkg);
    }
    return true;
  },
  { message: 'spec.infra entries must have unique `pkg` names (multi-replica is future work)' },
);
export type NodeRunSpec = z.infer<typeof NodeRunSpecSchema>;

export const NodeRunConditionSchema = z.object({
  type: z.string(),
  status: z.enum(['True', 'False', 'Unknown']),
  reason: z.string().optional(),
  message: z.string().optional(),
  lastTransitionTime: z.string(),
});

export const NodeRunStatusSchema = z.object({
  phase: z.enum(['Pending', 'Converged', 'Drift', 'Failed']),
  /** Echo of the last reconciled spec.infra. Useful for `describe`
   *  when the manifest was edited between reconciles. */
  observedInfra: z.array(
    z.object({
      pkg: z.string(),
      version: z.string(),
      active: z.boolean(),
    }),
  ).default([]),
  lastTransitionTime: z.string(),
  conditions: z.array(NodeRunConditionSchema).default([]),
});
export type NodeRunStatus = z.infer<typeof NodeRunStatusSchema>;

export const NodeRunMetadataSchema = z.object({
  name: z.string().regex(/^[a-z0-9][-a-z0-9]{0,62}$/,
    'name must be lowercase alphanumeric with dashes, max 63 chars'),
  labels: z.record(z.string(), z.string()).default({}),
});

export const NodeRunSchema = z.object({
  apiVersion: z.literal('llamactl/v1'),
  kind: z.literal('NodeRun'),
  metadata: NodeRunMetadataSchema,
  spec: NodeRunSpecSchema,
  status: NodeRunStatusSchema.optional(),
});
export type NodeRun = z.infer<typeof NodeRunSchema>;
