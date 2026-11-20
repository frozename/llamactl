import { z } from "zod";

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

export const NodeRunInfraItemSchema = z
  .object({
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
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
    /** `replicas` reserved for the future "many instances of this
     *  service on this node" case (multi-embersynth / multi-sirius).
     *  v1 treats anything > 1 as an error at apply time. */
    replicas: z.number().int().positive().default(1),
  })
  .refine((item) => (item.tarballUrl === undefined) === (item.sha256 === undefined), {
    message: "tarballUrl + sha256 must be set together or both omitted",
  });
export type NodeRunInfraItem = z.infer<typeof NodeRunInfraItemSchema>;

/**
 * Residency tuning for a NodeRun. `safetyMarginRatio` is applied to computed
 * admission budgets by apply, the reconciler, the router views and apply, and
 * the residencyPlan budget (Part of #519). `switchCooldownSeconds` is enforced:
 * residencyPlan and residencyApplyProfile refuse with `Cooldown` within that
 * many seconds of the node's last succeeded profile switch recorded in the
 * node-local residency store. `minResidencySeconds` is enforced: residencyPlan
 * and residencyApplyProfile refuse with `MinResidency` while a victim's
 * node-local residency_states row has been `ready` for fewer than that many
 * seconds; 0 disables. It also feeds the ranker's `cooldownUntil` signal
 * through createSharedUnifiedProxy when nonzero (Part of #518). `idleEvictSeconds` is
 * operator-only: validated, persisted and reported advisory by the residencyStatus
 * idleEviction section (only on the serving node), and acted on only when the
 * operator runs `residency evict-idle`, which stops a still-idle resident behind
 * the `llamactl.io/idle-evicted-at` hold; the runtime never evicts on its own.
 * `residentPreference` and `coldLoadPenaltyMs` are ranking-only (Part of
 * #519): rankRouteCandidates (packages/core/src/routing/ranking.ts) applies them
 * through the unified proxy's `residencyPolicy` option. createSharedUnifiedProxy
 * (packages/remote/src/proxy/create-proxy.ts) passes the serving node's NodeRun
 * policy (selected by LLAMACTL_NODE_NAME) and a resident set built from ready
 * residency_states rows; this applies under LLAMACTL_UNIFIED_PROXY=1 and both
 * keys are inert at 0.
 * budget.memoryGiB overrides any computed budget.
 */
export const ResidencyPolicySchema = z
  .object({
    /** operator-only: validated, persisted and reported advisory by the
     * residencyStatus idleEviction section; acted on only when the operator runs
     * residency evict-idle, which stops a still-idle resident behind the
     * llamactl.io/idle-evicted-at hold; the runtime never evicts on its own
     * (Part of #519) */
    idleEvictSeconds: z.number().int().nonnegative().optional(),
    /** enforced: refuses residencyPlan and residencyApplyProfile with
     *  MinResidency while a victim's ready lifecycle row is younger than this;
     *  0 disables. Also feeds the ranker's `cooldownUntil` signal through
     *  createSharedUnifiedProxy when nonzero (Part of #518) */
    minResidencySeconds: z.number().int().nonnegative().optional(),
    /** enforced: refuses residencyPlan and residencyApplyProfile with Cooldown
     *  within this many seconds of the node's last succeeded profile switch
     *  recorded in the node-local residency store; 0 disables (Part of #519) */
    switchCooldownSeconds: z.number().int().nonnegative().optional(),
    /** defaults to 0.75; sizes the computed admission budget when
     *  spec.budget is unset */
    safetyMarginRatio: z.number().gt(0).lte(1).optional(),
    /** #519: wired by createSharedUnifiedProxy into
     *  rankRouteCandidates via the unified proxy's residencyPolicy option;
     *  ready residency-store rows feed the resident deploymentIds */
    residentPreference: z.number().nonnegative().optional(),
    /** #519: wired by createSharedUnifiedProxy into
     *  rankRouteCandidates via the unified proxy's residencyPolicy option;
     *  ready residency-store rows feed the resident deploymentIds */
    coldLoadPenaltyMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type NodeRunResidency = z.infer<typeof ResidencyPolicySchema>;

export const NodeRunSpecSchema = z
  .object({
    node: z.string().min(1),
    budget: z
      .object({
        memoryGiB: z.number().positive(),
      })
      .optional(),
    residency: ResidencyPolicySchema.optional(),
    infra: z.array(NodeRunInfraItemSchema).default([]),
  })
  .refine(
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
    { message: "spec.infra entries must have unique `pkg` names (multi-replica is future work)" },
  );
export type NodeRunSpec = z.infer<typeof NodeRunSpecSchema>;

export const NodeRunConditionSchema = z.object({
  type: z.string(),
  status: z.enum(["True", "False", "Unknown"]),
  reason: z.string().optional(),
  message: z.string().optional(),
  lastTransitionTime: z.string(),
});

export const NodeRunStatusSchema = z.object({
  phase: z.enum(["Pending", "Converged", "Drift", "Failed"]),
  /** Echo of the last reconciled spec.infra. Useful for `describe`
   *  when the manifest was edited between reconciles. */
  observedInfra: z
    .array(
      z.object({
        pkg: z.string(),
        version: z.string(),
        active: z.boolean(),
      }),
    )
    .default([]),
  lastTransitionTime: z.string(),
  conditions: z.array(NodeRunConditionSchema).default([]),
});
export type NodeRunStatus = z.infer<typeof NodeRunStatusSchema>;

export const NodeRunMetadataSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-z0-9][-a-z0-9]{0,62}$/,
      "name must be lowercase alphanumeric with dashes, max 63 chars",
    ),
  labels: z.record(z.string(), z.string()).default({}),
});

export const NodeRunSchema = z.object({
  apiVersion: z.literal("llamactl/v1"),
  kind: z.literal("NodeRun"),
  metadata: NodeRunMetadataSchema,
  spec: NodeRunSpecSchema,
  status: NodeRunStatusSchema.optional(),
});
export type NodeRun = z.infer<typeof NodeRunSchema>;
