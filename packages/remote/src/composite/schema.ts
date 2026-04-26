/**
 * Composite — a declarative multi-component manifest that bundles
 * supporting services (chroma, pgvector, …), llama.cpp workloads,
 * RAG-node bindings, and gateway registrations into a single unit.
 * The applier orders components via an explicit dependency DAG and
 * rolls back on failure (Phase 4).
 *
 * v1 scope: schema + validation + dependency DAG + storage. The
 * applier itself lives in Phase 4. This file only describes the
 * data — every field must round-trip YAML → parse → YAML without
 * loss, and every cross-component reference must resolve inside
 * the manifest it was declared in.
 */
import { z } from 'zod';
import { ProviderConfigCommonSchema } from '../workload/gateway-catalog/schema.js';
import { ModelRunSpecSchema } from '../workload/schema.js';
import { RagBindingSchema } from '../config/schema.js';
import { RagPipelineSpecSchema } from '../rag/pipeline/schema.js';
import { ServiceSpecSchema } from '../service/schema.js';

/**
 * ComponentRef — names a component by (kind, name) inside this
 * composite. Used by the dependency DAG and the status block. Names
 * are scoped to their declaring manifest; cross-composite references
 * are not supported in v1.
 */
export const ComponentRefSchema = z.object({
  kind: z.enum(['service', 'workload', 'rag', 'gateway', 'pipeline']),
  name: z.string().min(1),
});
export type ComponentRef = z.infer<typeof ComponentRefSchema>;

/**
 * Depends-on edge — `from` depends on `to`, i.e. `to` must reach a
 * Ready state before `from` applies. The applier topologically sorts
 * on these edges and rejects cycles.
 */
export const DependencyEdgeSchema = z.object({
  from: ComponentRefSchema,
  to: ComponentRefSchema,
});
export type DependencyEdge = z.infer<typeof DependencyEdgeSchema>;

/**
 * Gateway entry inside a composite — a thin wrapper that names the
 * node the gateway registers against plus which upstream workloads
 * it should front. At apply time the existing gateway-handler flow
 * (dispatchGatewayApply) consumes `providerConfig` per-provider; we
 * keep it free-form here so new providers don't require a schema
 * bump on the composite side.
 */
export const GatewayCompositeEntrySchema = z.object({
  name: z.string().min(1),
  node: z.string().min(1),
  provider: z.enum(['sirius', 'embersynth', 'agent-gateway']),
  upstreamWorkloads: z.array(z.string().min(1)).default([]),
  providerConfig: ProviderConfigCommonSchema.optional(),
});
export type GatewayCompositeEntry = z.infer<typeof GatewayCompositeEntrySchema>;

/**
 * RAG-node entry inside a composite — wraps the existing
 * RagBindingSchema with the node-name it registers under in the
 * kubeconfig. When `backingService` is set, the applier auto-wires
 * `binding.endpoint` from the backing service's resolvedEndpoint at
 * apply time (so operators don't hand-write ports that change).
 */
export const RagNodeCompositeEntrySchema = z.object({
  name: z.string().min(1),
  node: z.string().min(1),
  binding: RagBindingSchema,
  backingService: z.string().optional(),
});
export type RagNodeCompositeEntry = z.infer<typeof RagNodeCompositeEntrySchema>;

/**
 * Pipeline entry inside a composite — wraps the existing
 * `RagPipelineSpec` with a composite-scoped name. The applier
 * synthesises a full `RagPipeline` manifest at apply time and
 * registers it through the same path operator-authored manifests
 * use, plus an `ownership` marker so destroy can reverse it cleanly.
 */
export const PipelineCompositeEntrySchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      'pipeline name must be lowercase-alphanumeric-hyphens',
    ),
  spec: RagPipelineSpecSchema,
});
export type PipelineCompositeEntry = z.infer<typeof PipelineCompositeEntrySchema>;

/**
 * CompositeSpec — the authoring surface. Each list defaults to `[]`
 * so a minimal composite (one service, nothing else) stays terse.
 * Cross-component validation lives on the outer `CompositeSchema`
 * refine below.
 */
/**
 * Runtime backend for this composite's services. `'docker'` targets
 * the local Docker socket (v1 default, every operator has this);
 * `'kubernetes'` targets a cluster resolved from the operator's
 * kubeconfig. When unset, the router falls back to the
 * `LLAMACTL_RUNTIME_BACKEND` env var, then finally `'docker'`.
 */
export const CompositeRuntimeSchema = z.enum(['docker', 'kubernetes']);
export type CompositeRuntime = z.infer<typeof CompositeRuntimeSchema>;

export const CompositeSpecSchema = z.object({
  services: z.array(ServiceSpecSchema).default([]),
  workloads: z.array(ModelRunSpecSchema).default([]),
  ragNodes: z.array(RagNodeCompositeEntrySchema).default([]),
  gateways: z.array(GatewayCompositeEntrySchema).default([]),
  pipelines: z.array(PipelineCompositeEntrySchema).default([]),
  dependencies: z.array(DependencyEdgeSchema).default([]),
  onFailure: z.enum(['rollback', 'leave-partial']).default('rollback'),
  runtime: CompositeRuntimeSchema.optional(),
});
export type CompositeSpec = z.infer<typeof CompositeSpecSchema>;

export const CompositeStatusComponentSchema = z.object({
  ref: ComponentRefSchema,
  state: z.enum(['Pending', 'Applying', 'Ready', 'Failed']),
  message: z.string().optional(),
});
export type CompositeStatusComponent = z.infer<
  typeof CompositeStatusComponentSchema
>;

export const CompositeStatusSchema = z.object({
  phase: z.enum(['Pending', 'Applying', 'Ready', 'Degraded', 'Failed']),
  appliedAt: z.string().optional(),
  components: z.array(CompositeStatusComponentSchema).default([]),
});
export type CompositeStatus = z.infer<typeof CompositeStatusSchema>;

export const CompositeMetadataSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9-]+$/,
      'composite name must be lowercase-alphanumeric-hyphens',
    ),
  labels: z.record(z.string(), z.string()).optional(),
});
export type CompositeMetadata = z.infer<typeof CompositeMetadataSchema>;

/**
 * Collect every declared component as a ref set keyed by kind. Used
 * both by the refine check below and by the DAG utilities in
 * `./dag.ts` (re-exported there to avoid the import cycle).
 */
function collectComponentNames(spec: CompositeSpec): {
  service: Set<string>;
  workload: Set<string>;
  rag: Set<string>;
  gateway: Set<string>;
  pipeline: Set<string>;
} {
  return {
    service: new Set(spec.services.map((s) => s.name)),
    workload: new Set(spec.workloads.map((w) => w.node /* placeholder */)),
    rag: new Set(spec.ragNodes.map((r) => r.name)),
    gateway: new Set(spec.gateways.map((g) => g.name)),
    pipeline: new Set(spec.pipelines.map((p) => p.name)),
  };
}

/**
 * Workloads identify themselves via `metadata.name` on the full
 * ModelRun manifest, but inside a CompositeSpec we only embed
 * ModelRunSpec (no metadata). So for composite-scoped uniqueness /
 * dependency references, the workload's identifier is its
 * `spec.node` + index position. To keep refs stable, we require
 * each workload to carry a synthesizable identifier — since the
 * existing ModelRunSpec doesn't include a name field, composites
 * identify workloads by their `node` value. That matches the v1
 * one-workload-per-node contract in ModelRunSpec.
 *
 * If a future phase widens ModelRunSpec with multiple workloads per
 * node, this mapping needs to switch to a named-key in the spec.
 */
function workloadName(w: z.infer<typeof ModelRunSpecSchema>): string {
  return w.node;
}

export const CompositeSchema = z
  .object({
    apiVersion: z.literal('llamactl/v1'),
    kind: z.literal('Composite'),
    metadata: CompositeMetadataSchema,
    spec: CompositeSpecSchema,
    status: CompositeStatusSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    const spec = manifest.spec;

    // 1. Unique component names per kind.
    const seen = {
      service: new Map<string, number>(),
      workload: new Map<string, number>(),
      rag: new Map<string, number>(),
      gateway: new Map<string, number>(),
      pipeline: new Map<string, number>(),
    } as const;
    for (const s of spec.services) {
      seen.service.set(s.name, (seen.service.get(s.name) ?? 0) + 1);
    }
    for (const w of spec.workloads) {
      const n = workloadName(w);
      seen.workload.set(n, (seen.workload.get(n) ?? 0) + 1);
    }
    for (const r of spec.ragNodes) {
      seen.rag.set(r.name, (seen.rag.get(r.name) ?? 0) + 1);
    }
    for (const g of spec.gateways) {
      seen.gateway.set(g.name, (seen.gateway.get(g.name) ?? 0) + 1);
    }
    for (const p of spec.pipelines) {
      seen.pipeline.set(p.name, (seen.pipeline.get(p.name) ?? 0) + 1);
    }
    for (const [kind, bag] of Object.entries(seen) as Array<
      [keyof typeof seen, Map<string, number>]
    >) {
      for (const [name, count] of bag) {
        if (count > 1) {
          ctx.addIssue({
            code: 'custom',
            message: `duplicate ${kind} component name: '${name}'`,
            path: ['spec', kind === 'rag' ? 'ragNodes' : `${kind}s`],
          });
        }
      }
    }

    // 2. Dependencies must reference real components.
    const names = collectComponentNames(spec);
    const pool: Record<ComponentRef['kind'], Set<string>> = {
      service: names.service,
      workload: names.workload,
      rag: names.rag,
      gateway: names.gateway,
      pipeline: names.pipeline,
    };
    for (let i = 0; i < spec.dependencies.length; i++) {
      const edge = spec.dependencies[i];
      if (!edge) continue;
      if (!pool[edge.from.kind].has(edge.from.name)) {
        ctx.addIssue({
          code: 'custom',
          message: `dependency.from references unknown ${edge.from.kind} '${edge.from.name}'`,
          path: ['spec', 'dependencies', i, 'from'],
        });
      }
      if (!pool[edge.to.kind].has(edge.to.name)) {
        ctx.addIssue({
          code: 'custom',
          message: `dependency.to references unknown ${edge.to.kind} '${edge.to.name}'`,
          path: ['spec', 'dependencies', i, 'to'],
        });
      }
    }

    // 3. ragNode.backingService must name a declared service.
    for (let i = 0; i < spec.ragNodes.length; i++) {
      const rn = spec.ragNodes[i];
      if (!rn) continue;
      if (rn.backingService && !names.service.has(rn.backingService)) {
        ctx.addIssue({
          code: 'custom',
          message: `ragNode '${rn.name}' references unknown backingService '${rn.backingService}'`,
          path: ['spec', 'ragNodes', i, 'backingService'],
        });
      }
    }

    // 4. gateway.upstreamWorkloads must name declared workloads.
    for (let i = 0; i < spec.gateways.length; i++) {
      const gw = spec.gateways[i];
      if (!gw) continue;
      for (let j = 0; j < gw.upstreamWorkloads.length; j++) {
        const up = gw.upstreamWorkloads[j];
        if (up && !names.workload.has(up)) {
          ctx.addIssue({
            code: 'custom',
            message: `gateway '${gw.name}' references unknown upstream workload '${up}'`,
            path: ['spec', 'gateways', i, 'upstreamWorkloads', j],
          });
        }
      }
    }
  });
export type Composite = z.infer<typeof CompositeSchema>;

/**
 * Helper exported for use by `./dag.ts` so both files agree on the
 * workload→name convention.
 */
export function workloadRefName(
  w: z.infer<typeof ModelRunSpecSchema>,
): string {
  return workloadName(w);
}