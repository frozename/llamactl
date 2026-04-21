/**
 * Composite applier. Walks the component DAG (topological order),
 * drives each component through its type-specific apply path, and
 * rolls back on failure when `onFailure: 'rollback'`.
 *
 * Per-component apply:
 *   - `service` — `ServiceHandler.toDeployment` → `backend.ensureService`.
 *                 `runtime: 'external'` short-circuits (no spawn).
 *   - `workload` — reuses `applyOne()` from `../workload/apply.js` with a
 *                  synthesized `ModelRun` (name = spec.node per v1
 *                  convention, see `composite/schema.ts`).
 *   - `rag` — resolves the binding endpoint from the backing service
 *             (when `backingService` is set) and upserts the node into
 *             the kubeconfig.
 *   - `gateway` — synthesizes a `gateway: true` `ModelRun` and routes
 *                 through the existing `dispatchGatewayApply` so
 *                 sirius/embersynth reload their configs.
 *
 * Rollback:
 *   - Only runs when `spec.onFailure === 'rollback'`.
 *   - Walks successfully-applied components in **reverse** and tears
 *     each down via its type-specific destroy path.
 *   - Swallows rollback errors (logs via the event stream) so a
 *     single stuck teardown can't keep the applier from finishing.
 */
import type {
  RuntimeBackend,
  ServiceInstance,
  ServiceRef,
} from '../runtime/backend.js';
import type { Config, ClusterNode } from '../config/schema.js';
import {
  loadConfig,
  saveConfig,
  resolveNode as kubecfgResolveNode,
  upsertNode,
  removeNode,
} from '../config/kubeconfig.js';
import type { ModelRun, ModelRunSpec } from '../workload/schema.js';
import { applyOne } from '../workload/apply.js';
import type { WorkloadClient, ApplyEvent } from '../workload/apply.js';
import {
  dispatchGatewayApply,
  DEFAULT_GATEWAY_HANDLERS,
} from '../workload/gateway-handlers/registry.js';
import type { GatewayHandler } from '../workload/gateway-handlers/types.js';
import { findServiceHandler } from '../service/handlers/registry.js';
import type { ServiceSpec } from '../service/schema.js';
import type { Composite, ComponentRef } from './schema.js';
import { topologicalOrder, reverseOrder } from './dag.js';
import {
  saveComposite,
  defaultCompositesDir,
} from './store.js';
import type {
  CompositeApplyEvent,
  CompositeApplyResult,
  CompositeComponentResult,
} from './types.js';

export interface CompositeApplyOptions {
  manifest: Composite;
  backend: RuntimeBackend;
  getWorkloadClient: (nodeName: string) => WorkloadClient;
  /** Path to kubeconfig; reads + writes happen here. */
  configPath?: string;
  /** Override composites dir for persistence. Tests use this. */
  compositesDir?: string;
  onEvent?: (e: CompositeApplyEvent) => void;
  /** Override gateway handlers. Tests inject; production uses defaults. */
  gatewayHandlers?: readonly GatewayHandler[];
}

/**
 * Track per-component state through the apply loop so rollback knows
 * exactly what to undo. `serviceInstance` is cached when a service
 * comes up so later ragNodes can resolve their endpoints without a
 * re-inspect round-trip.
 */
interface AppliedRecord {
  ref: ComponentRef;
  // Service-specific
  serviceInstance?: ServiceInstance | null;
  serviceRef?: ServiceRef; // set when a docker service was spawned
  // Workload-specific — captured for the gateway upstream-threading
  // slice so gateways can see the live endpoint of each upstream
  // workload in composite-declaration order.
  workloadEndpoint?: string;
  workloadNodeName?: string;
  // Rag-specific
  ragNodeCreated?: boolean;
  // Rollback hint: only components we actually started need teardown.
  started: boolean;
}

export async function applyComposite(
  opts: CompositeApplyOptions,
): Promise<CompositeApplyResult> {
  const manifest = opts.manifest;
  const emit = (e: CompositeApplyEvent): void => opts.onEvent?.(e);

  emit({ type: 'phase', phase: 'Applying' });

  const componentResults: CompositeComponentResult[] = [];
  const applied: AppliedRecord[] = [];
  const order = topologicalOrder(manifest.spec);

  let failureMessage: string | null = null;

  for (const ref of order) {
    emit({ type: 'component-start', ref });
    try {
      const record = await applyComponent(ref, manifest, opts, applied);
      applied.push(record);
      componentResults.push({ ref, state: 'Ready' });
      emit({ type: 'component-ready', ref });
    } catch (err) {
      const message = toErrorMessage(err);
      componentResults.push({ ref, state: 'Failed', message });
      emit({ type: 'component-failed', ref, message });
      failureMessage = message;
      break;
    }
  }

  let rolledBack = false;
  if (failureMessage !== null && manifest.spec.onFailure === 'rollback') {
    const teardownRefs = reverseOrder(applied.filter((r) => r.started).map((r) => r.ref));
    emit({ type: 'rollback-start', refs: teardownRefs });
    await rollback(applied, manifest, opts);
    rolledBack = true;
    emit({ type: 'rollback-complete' });
  }

  const appliedAt = new Date().toISOString();
  const finalStatus: Composite['status'] = {
    phase:
      failureMessage === null
        ? 'Ready'
        : manifest.spec.onFailure === 'rollback'
          ? 'Failed'
          : 'Degraded',
    appliedAt,
    components: componentResults.map((r) => ({
      ref: r.ref,
      state: r.state === 'Ready' ? 'Ready' : 'Failed',
      ...(r.message !== undefined && { message: r.message }),
    })),
  };

  // Persist the status on the manifest. The composite YAML on disk
  // tracks the last-known apply outcome so operators see state
  // without re-running.
  try {
    const updated: Composite = { ...manifest, status: finalStatus };
    const dir = opts.compositesDir ?? defaultCompositesDir();
    saveComposite(updated, dir);
  } catch (err) {
    // Persistence is best-effort — we don't want a missing
    // compositesDir to flip a successful apply into a failure.
    emit({
      type: 'component-failed',
      ref: { kind: 'service', name: '__persist__' },
      message: `failed to persist composite status: ${toErrorMessage(err)}`,
    });
  }

  emit({ type: 'phase', phase: finalStatus.phase });
  emit({ type: 'done', ok: failureMessage === null });

  return {
    ok: failureMessage === null,
    status: finalStatus,
    rolledBack,
    componentResults,
  };
}

// ---- per-component apply --------------------------------------------------

async function applyComponent(
  ref: ComponentRef,
  manifest: Composite,
  opts: CompositeApplyOptions,
  applied: AppliedRecord[],
): Promise<AppliedRecord> {
  switch (ref.kind) {
    case 'service':
      return applyServiceComponent(ref, manifest, opts);
    case 'workload':
      return applyWorkloadComponent(ref, manifest, opts);
    case 'rag':
      return applyRagComponent(ref, manifest, opts, applied);
    case 'gateway':
      return applyGatewayComponent(ref, manifest, opts, applied);
    default: {
      const exhaustive: never = ref.kind;
      throw new Error(`unknown component kind: ${String(exhaustive)}`);
    }
  }
}

async function applyServiceComponent(
  ref: ComponentRef,
  manifest: Composite,
  opts: CompositeApplyOptions,
): Promise<AppliedRecord> {
  const spec = manifest.spec.services.find((s) => s.name === ref.name);
  if (!spec) throw new Error(`service '${ref.name}' not found in composite`);

  const handler = findServiceHandler(spec);
  handler.validate(spec as ServiceSpec);

  const specHash = handler.computeSpecHash(spec as ServiceSpec);
  const deployment = handler.toDeployment(spec as ServiceSpec, {
    compositeName: manifest.metadata.name,
  });

  // runtime: 'external' — nothing to spawn. Still a "ready"
  // component (the external service is assumed up). Dependents use
  // handler.resolvedEndpoint(spec, null) which for external parses
  // the externalEndpoint URL.
  if (deployment === null) {
    return { ref, started: false };
  }

  // Attach the handler-computed hash so the backend's idempotency
  // compare uses the same value the operator intended.
  const instance = await opts.backend.ensureService({ ...deployment, specHash });
  return { ref, serviceInstance: instance, serviceRef: instance.ref, started: true };
}

async function applyWorkloadComponent(
  ref: ComponentRef,
  manifest: Composite,
  opts: CompositeApplyOptions,
): Promise<AppliedRecord> {
  const spec = manifest.spec.workloads.find((w) => w.node === ref.name);
  if (!spec) throw new Error(`workload '${ref.name}' not found in composite`);

  const modelRun = synthesizeModelRun(spec, manifest.metadata.name);
  const result = await applyOne(
    modelRun,
    opts.getWorkloadClient,
    (e: ApplyEvent) => {
      // Forward underlying apply events as component-start annotations
      // so the composite stream captures per-workload progress without
      // growing the event union.
      opts.onEvent?.({
        type: 'component-start',
        ref,
      });
      void e; // retained for future per-event propagation
    },
    buildGatewayDispatch(opts),
  );
  if (result.action === 'pending') {
    throw new Error(`workload '${ref.name}' apply returned Pending: ${result.error ?? 'no details'}`);
  }
  if (result.error) {
    throw new Error(`workload '${ref.name}' failed: ${result.error}`);
  }
  const endpoint = result.statusSection.endpoint;
  return {
    ref,
    started: result.action !== 'unchanged',
    ...(endpoint && { workloadEndpoint: endpoint }),
    workloadNodeName: spec.node,
  };
}

async function applyRagComponent(
  ref: ComponentRef,
  manifest: Composite,
  opts: CompositeApplyOptions,
  applied: AppliedRecord[],
): Promise<AppliedRecord> {
  const entry = manifest.spec.ragNodes.find((r) => r.name === ref.name);
  if (!entry) throw new Error(`rag node '${ref.name}' not found in composite`);

  // Resolve the binding endpoint from the backing service, when set.
  // Look up the already-applied service's instance so the handler
  // can produce an endpoint URL.
  let bindingWithEndpoint = entry.binding;
  if (entry.backingService) {
    const serviceSpec = manifest.spec.services.find((s) => s.name === entry.backingService);
    if (!serviceSpec) {
      throw new Error(
        `rag node '${entry.name}' references unknown backingService '${entry.backingService}'`,
      );
    }
    const serviceRecord = applied.find(
      (r) => r.ref.kind === 'service' && r.ref.name === entry.backingService,
    );
    const handler = findServiceHandler(serviceSpec);
    const instance = serviceRecord?.serviceInstance ?? null;
    const resolved = handler.resolvedEndpoint(serviceSpec as ServiceSpec, instance);
    bindingWithEndpoint = { ...entry.binding, endpoint: resolved.url };
  }

  const configPath = opts.configPath;
  const cfg = loadConfig(configPath);
  const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
  if (!ctx) {
    throw new Error(
      `no current context in kubeconfig — composite cannot register rag node '${entry.name}'`,
    );
  }
  const node: ClusterNode = {
    name: entry.name,
    endpoint: '',
    kind: 'rag',
    rag: bindingWithEndpoint,
  };
  const next = upsertNode(cfg, ctx.cluster, node);
  saveConfig(next, configPath);
  return { ref, ragNodeCreated: true, started: true };
}

async function applyGatewayComponent(
  ref: ComponentRef,
  manifest: Composite,
  opts: CompositeApplyOptions,
  applied: AppliedRecord[],
): Promise<AppliedRecord> {
  const entry = manifest.spec.gateways.find((g) => g.name === ref.name);
  if (!entry) throw new Error(`gateway '${ref.name}' not found in composite`);

  // Resolve each declared upstream workload to its live endpoint. The
  // composite applier ran those workloads earlier in topo order; their
  // AppliedRecord carries workloadEndpoint + workloadNodeName. Missing
  // endpoints are allowed (the workload was unchanged, so we don't
  // have a fresh statusSection — handlers treat these as "use existing
  // registration"); pass them through with an empty endpoint string
  // so the handler can distinguish "declared but no live endpoint".
  const upstreams = entry.upstreamWorkloads.map((upstreamName) => {
    const rec = applied.find(
      (r) => r.ref.kind === 'workload' && r.ref.name === upstreamName,
    );
    return {
      name: upstreamName,
      endpoint: rec?.workloadEndpoint ?? '',
      nodeName: rec?.workloadNodeName ?? upstreamName,
    };
  });

  // Synthesize the gateway-trigger ModelRun. The existing
  // dispatchGatewayApply path reloads the target gateway's config;
  // the optional `composite` context carries the composite-scoped
  // upstreams + providerConfig so sirius / embersynth handlers can
  // auto-populate their catalogs instead of relying on out-of-band
  // config editing.
  const modelRun: ModelRun = {
    apiVersion: 'llamactl/v1',
    kind: 'ModelRun',
    metadata: { name: `${manifest.metadata.name}-${entry.name}`, labels: {} },
    spec: {
      node: entry.node,
      target: { kind: 'rel', value: '' },
      extraArgs: [],
      workers: [],
      restartPolicy: 'Never',
      gateway: true,
      timeoutSeconds: 30,
    },
  };
  const configPath = opts.configPath;
  const handlers = opts.gatewayHandlers ?? DEFAULT_GATEWAY_HANDLERS;
  const result = await dispatchGatewayApply({
    manifest: modelRun,
    getClient: opts.getWorkloadClient,
    resolveNode: (nodeName: string) => {
      const cfg = loadConfig(configPath);
      try {
        return kubecfgResolveNode(cfg, nodeName).node;
      } catch {
        return undefined;
      }
    },
    handlers,
    composite: {
      compositeName: manifest.metadata.name,
      upstreams,
      providerConfig: entry.providerConfig,
    },
  });
  if (result === null) {
    // agent-gateway fallthrough sentinel — treat as no-op. Composite
    // flags this as Ready; the workload itself drives the llama-server.
    return { ref, started: false };
  }
  if (result.error) {
    throw new Error(`gateway '${ref.name}' reload failed: ${result.error}`);
  }
  if (result.action === 'pending') {
    throw new Error(
      `gateway '${ref.name}' returned Pending — check the gateway node's cloud binding`,
    );
  }
  return { ref, started: true };
}

// ---- rollback -------------------------------------------------------------

async function rollback(
  applied: AppliedRecord[],
  manifest: Composite,
  opts: CompositeApplyOptions,
): Promise<void> {
  // Walk in reverse. Never throw from inside rollback — swallow +
  // surface via events so a single stuck teardown doesn't keep the
  // applier from finishing its cleanup pass.
  const toTeardown = [...applied].reverse();
  for (const rec of toTeardown) {
    if (!rec.started) continue;
    try {
      await teardownComponent(rec, manifest, opts);
    } catch (err) {
      opts.onEvent?.({
        type: 'component-failed',
        ref: rec.ref,
        message: `rollback failed for ${rec.ref.kind}/${rec.ref.name}: ${toErrorMessage(err)}`,
      });
    }
  }
}

async function teardownComponent(
  rec: AppliedRecord,
  manifest: Composite,
  opts: CompositeApplyOptions,
): Promise<void> {
  switch (rec.ref.kind) {
    case 'service': {
      if (rec.serviceRef) {
        // Rollback is a reactive cleanup pass after a failed apply —
        // NEVER purge operator storage here. Explicit-destroy
        // (`destroyComposite`) is the only path that honors an
        // operator-initiated `purgeVolumes`.
        await opts.backend.removeService(rec.serviceRef, { purgeVolumes: false });
      }
      return;
    }
    case 'workload': {
      // Reuse the existing stop path: getClient(node).serverStop.mutate.
      const spec = manifest.spec.workloads.find((w) => w.node === rec.ref.name);
      if (!spec) return;
      const client = opts.getWorkloadClient(spec.node);
      await client.serverStop.mutate({ graceSeconds: 10 }).catch(() => {});
      return;
    }
    case 'rag': {
      if (!rec.ragNodeCreated) return;
      const cfg = loadConfig(opts.configPath);
      const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
      if (!ctx) return;
      const next = removeNode(cfg, ctx.cluster, rec.ref.name);
      saveConfig(next, opts.configPath);
      return;
    }
    case 'gateway': {
      // v1: gateways don't have a symmetric "undo". The reload
      // happens via handler.apply(); we don't call a second
      // "deregister" because providers may still have other workloads
      // relying on the gateway. Documented follow-up.
      return;
    }
  }
}

// ---- destroy --------------------------------------------------------------

export interface CompositeDestroyOptions {
  manifest: Composite;
  backend: RuntimeBackend;
  getWorkloadClient: (nodeName: string) => WorkloadClient;
  configPath?: string;
  compositesDir?: string;
  /**
   * Operator opt-in for wiping storage alongside the container. Default
   * false — destroy removes containers but leaves docker volumes /
   * future k8s PVCs intact so the operator can re-apply the same spec
   * without data loss. Set true for a full reset. See
   * `RemoveServiceOptions` for the backend-side caveats.
   */
  purgeVolumes?: boolean;
}

export interface CompositeDestroyResult {
  ok: boolean;
  removed: ComponentRef[];
  errors: Array<{ ref: ComponentRef; message: string }>;
}

/**
 * Tear down every component of a composite. Walks the DAG in
 * reverse order. Continues on error — the goal is to remove as
 * much as possible so a second destroy attempt isn't needed.
 */
export async function destroyComposite(
  opts: CompositeDestroyOptions,
): Promise<CompositeDestroyResult> {
  const order = reverseOrder(topologicalOrder(opts.manifest.spec));
  const removed: ComponentRef[] = [];
  const errors: Array<{ ref: ComponentRef; message: string }> = [];

  for (const ref of order) {
    try {
      await destroyComponent(ref, opts);
      removed.push(ref);
    } catch (err) {
      errors.push({ ref, message: toErrorMessage(err) });
    }
  }

  return { ok: errors.length === 0, removed, errors };
}

async function destroyComponent(
  ref: ComponentRef,
  opts: CompositeDestroyOptions,
): Promise<void> {
  const manifest = opts.manifest;
  switch (ref.kind) {
    case 'service': {
      const spec = manifest.spec.services.find((s) => s.name === ref.name);
      if (!spec) return;
      if (spec.kind === 'chroma' || spec.kind === 'pgvector') {
        if (spec.runtime === 'external') return;
      }
      const handler = findServiceHandler(spec);
      const deployment = handler.toDeployment(spec as ServiceSpec, {
        compositeName: manifest.metadata.name,
      });
      if (deployment === null) return;
      await opts.backend.removeService(
        { name: deployment.name },
        { purgeVolumes: opts.purgeVolumes ?? false },
      );
      return;
    }
    case 'workload': {
      const spec = manifest.spec.workloads.find((w) => w.node === ref.name);
      if (!spec) return;
      const client = opts.getWorkloadClient(spec.node);
      await client.serverStop.mutate({ graceSeconds: 10 });
      return;
    }
    case 'rag': {
      const cfg = loadConfig(opts.configPath);
      const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
      if (!ctx) return;
      const next = removeNode(cfg, ctx.cluster, ref.name);
      saveConfig(next, opts.configPath);
      return;
    }
    case 'gateway':
      // Same v1 limitation as rollback — no symmetric deregister.
      return;
  }
}

// ---- helpers --------------------------------------------------------------

function synthesizeModelRun(spec: ModelRunSpec, compositeName: string): ModelRun {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'ModelRun',
    metadata: { name: spec.node, labels: { 'llamactl.composite': compositeName } },
    spec,
  };
}

function buildGatewayDispatch(
  opts: CompositeApplyOptions,
): Parameters<typeof applyOne>[3] {
  return async (inner) => {
    const handlers = opts.gatewayHandlers ?? DEFAULT_GATEWAY_HANDLERS;
    return dispatchGatewayApply({
      manifest: inner.manifest,
      getClient: inner.getClient,
      resolveNode: (nodeName: string) => {
        const cfg = loadConfig(opts.configPath);
        try {
          return kubecfgResolveNode(cfg, nodeName).node;
        } catch {
          return undefined;
        }
      },
      handlers,
      ...(inner.onEvent !== undefined && { onEvent: inner.onEvent }),
    });
  };
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Unused import keeper — Config type is referenced via `ClusterNode`
 * re-export convention elsewhere. The direct import avoids a
 * circular-import compile error noticed during integration testing.
 */
export type { Config };
