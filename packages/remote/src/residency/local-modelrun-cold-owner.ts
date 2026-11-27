import type { ColdEngineDispatch } from "@llamactl/core/residency/engine-forwarder";
import type { LocalRoute } from "@llamactl/core/workloadRuntime";

import { formatHostForUrl } from "@llamactl/core/engines";
import { isAbsolute } from "node:path";

import type {
  ReadyColdDeployment,
  TrustedColdOwner,
  TrustedColdPin,
} from "./cold-owner-admission.js";

import { type ModelRun, ModelRunMetadataSchema, ModelRunSchema } from "../workload/schema.js";
import { loadWorkloadByName } from "../workload/store.js";
import { buildDeclaredModelEntries } from "./catalog.js";

type Declaration = ColdEngineDispatch["declaration"];
type Endpoint = Readonly<{ host: string; port: number }>;

export interface LocalModelRunColdPlan<Launch> {
  launch: Launch;
  effectiveSpecDigest: string;
  /** Artifact rel and SHA-256 established from authoritative local artifact evidence. */
  artifactRel: string;
  artifactRevision: string;
  policyRevision: string;
  /** Actual context cap after compiling the pinned invocation. */
  contextTokens: number;
  endpoint: Endpoint;
}

export interface LocalModelRunResidentProof {
  effectiveSpecDigest: string;
  artifactRevision: string;
  policyRevision: string;
  contextTokens: number;
  endpoint: Endpoint;
  pid: number;
  runtimeGeneration: string;
}

export interface LocalModelRunReadyRoute extends Pick<
  LocalRoute,
  "workload" | "model" | "kind" | "engine" | "pid" | "host" | "port"
> {
  runtimeGeneration: string;
}

type LaunchOutcome =
  | { kind: "ready"; runtimeGeneration: string }
  | { kind: "refused" | "uncertain" };

interface CompiledColdPlan<Launch> {
  plan: Readonly<LocalModelRunColdPlan<Launch>>;
  pin: Readonly<TrustedColdPin>;
  mayActivate: boolean;
}

export interface LocalModelRunColdOwnerOptions<Launch> {
  ownerNodeId: string;
  /** The authenticated owner's name in its local workload store. */
  workloadNodeId?: string;
  workloadsDir?: string;
  readModelRun?: (workload: string) => unknown;
  /** Fresh local declarations, including every claimant to an ambiguous alias. */
  readDeclarations(): readonly Readonly<Declaration>[];
  compile(manifest: Readonly<ModelRun>): Readonly<LocalModelRunColdPlan<Launch>> | undefined;
  /** Check stillCurrent under the managed mutation lock before any side effects. */
  launchManaged(
    plan: Readonly<LocalModelRunColdPlan<Launch>>,
    gate: {
      pin: Readonly<TrustedColdPin>;
      signal: AbortSignal;
      stillCurrent: () => boolean;
    },
  ): Promise<LaunchOutcome>;
  /** A confirmed generation from the local managed residency authority. */
  readResident(workload: string): Readonly<LocalModelRunResidentProof> | undefined;
  /** Current positively ready routes for the alias, with their verified generation. */
  readReadyRoutes(model: string): readonly Readonly<LocalModelRunReadyRoute>[];
}

const REVISION = /^sha256:[0-9a-f]{64}$/;
const SPEC_DIGEST = /^[0-9a-f]{64}$/;

function launchable(entry: Readonly<Declaration>): boolean {
  return (
    entry.reason === undefined &&
    (entry.state === "loading" || (entry.state === "cold" && entry.autoLoadEligible))
  );
}

function modelRunFor(value: unknown, workload: string, node: string): ModelRun | undefined {
  const parsed = ModelRunSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { metadata, spec } = parsed.data;
  if (metadata.name !== workload || spec.node !== node || !spec.enabled) return undefined;
  if (spec.gateway || spec.workers.length > 0 || spec.resources?.expectedMemoryGiB === undefined) {
    return undefined;
  }
  const rel = spec.target.value;
  if (
    spec.target.kind !== "rel" ||
    isAbsolute(rel) ||
    rel.includes("\\") ||
    rel.split("/").some((part) => part === "." || part === ".." || part === "")
  ) {
    return undefined;
  }
  return parsed.data;
}

function localEndpoint(endpoint: Endpoint): string | undefined {
  if (endpoint.host !== "127.0.0.1" && endpoint.host !== "::1") return undefined;
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
    return undefined;
  }
  return `http://${formatHostForUrl(endpoint.host)}:${String(endpoint.port)}`;
}

function declaredEndpointMatches(manifest: ModelRun, endpoint: Endpoint): boolean {
  const declared = manifest.spec.endpoint;
  return (
    (declared?.host === undefined || declared.host === endpoint.host) &&
    (declared?.port === undefined || declared.port === endpoint.port)
  );
}

function qualifiedPlan<Launch>(
  manifest: ModelRun,
  plan: Readonly<LocalModelRunColdPlan<Launch>> | undefined,
): plan is Readonly<LocalModelRunColdPlan<Launch>> {
  return (
    plan?.artifactRel === manifest.spec.target.value &&
    REVISION.test(plan.artifactRevision) &&
    REVISION.test(plan.policyRevision) &&
    SPEC_DIGEST.test(plan.effectiveSpecDigest) &&
    Number.isSafeInteger(plan.contextTokens) &&
    plan.contextTokens > 0 &&
    declaredEndpointMatches(manifest, plan.endpoint)
  );
}

function samePin(a: Readonly<TrustedColdPin>, b: Readonly<TrustedColdPin>): boolean {
  return (
    a.model === b.model &&
    a.workload === b.workload &&
    a.ownerNodeId === b.ownerNodeId &&
    a.deploymentId === b.deploymentId &&
    a.artifactRevision === b.artifactRevision &&
    a.policyRevision === b.policyRevision &&
    a.endpoint === b.endpoint &&
    a.pretokenizedCompletion === b.pretokenizedCompletion
  );
}

function residentMatches<Launch>(
  proof: Readonly<LocalModelRunResidentProof>,
  pin: Readonly<TrustedColdPin>,
  plan: Readonly<LocalModelRunColdPlan<Launch>>,
): boolean {
  return (
    proof.effectiveSpecDigest === plan.effectiveSpecDigest &&
    proof.contextTokens === plan.contextTokens &&
    proof.artifactRevision === pin.artifactRevision &&
    proof.policyRevision === pin.policyRevision &&
    localEndpoint(proof.endpoint) === pin.endpoint &&
    Number.isSafeInteger(proof.pid) &&
    proof.pid > 0 &&
    proof.runtimeGeneration.trim().length > 0
  );
}

function routeMatches(
  route: Readonly<LocalModelRunReadyRoute>,
  pin: Readonly<TrustedColdPin>,
  proof: Readonly<LocalModelRunResidentProof>,
): boolean {
  return (
    route.model === pin.model &&
    route.workload === pin.workload &&
    route.kind === "ModelRun" &&
    route.engine === "llamacpp" &&
    route.pid === proof.pid &&
    route.runtimeGeneration === proof.runtimeGeneration &&
    localEndpoint(route) === pin.endpoint
  );
}

function currentDeclaration(
  entries: readonly Readonly<Declaration>[],
  ownerNodeId: string,
  model: string,
  workload: string,
): Readonly<Declaration> | undefined {
  const matches = entries.filter((entry) => entry.id === model);
  const [entry] = matches;
  return matches.length === 1 &&
    entry?.workload === workload &&
    entry.kind === "ModelRun" &&
    entry.ownerNodeId === ownerNodeId &&
    (launchable(entry) || (entry.state === "ready" && entry.reason === undefined))
    ? entry
    : undefined;
}

function compile<Launch>(
  opts: LocalModelRunColdOwnerOptions<Launch>,
  model: string,
  workload: string,
): CompiledColdPlan<Launch> | undefined {
  if (!ModelRunMetadataSchema.shape.name.safeParse(workload).success) return undefined;
  try {
    const declaration = currentDeclaration(
      opts.readDeclarations(),
      opts.ownerNodeId,
      model,
      workload,
    );
    if (declaration === undefined) return undefined;
    const workloadNodeId = opts.workloadNodeId ?? "local";
    const stored =
      opts.readModelRun === undefined
        ? loadWorkloadByName(workload, opts.workloadsDir)
        : opts.readModelRun(workload);
    const manifest = modelRunFor(stored, workload, workloadNodeId);
    if (manifest === undefined) return undefined;
    const declared = buildDeclaredModelEntries({
      nodeName: workloadNodeId,
      modelHosts: [],
      modelRuns: [manifest],
      liveModelIds: new Set<string>(),
    });
    if (!declared.some((entry) => entry.id === model)) return undefined;
    const plan = opts.compile(manifest);
    if (!qualifiedPlan(manifest, plan)) return undefined;
    const endpoint = localEndpoint(plan.endpoint);
    if (endpoint === undefined) return undefined;
    return {
      plan,
      mayActivate: launchable(declaration),
      pin: Object.freeze({
        model,
        workload,
        ownerNodeId: opts.ownerNodeId,
        deploymentId: `deploy/${opts.ownerNodeId}/ModelRun/${workload}/${plan.effectiveSpecDigest}/${String(plan.contextTokens)}`,
        artifactRevision: plan.artifactRevision,
        policyRevision: plan.policyRevision,
        endpoint,
        pretokenizedCompletion: true,
      }),
    };
  } catch {
    return undefined;
  }
}

/** Bind the cold queue to the local store and explicitly injected managed owner. */
export function createLocalModelRunColdOwner<Launch>(
  opts: LocalModelRunColdOwnerOptions<Launch>,
): TrustedColdOwner {
  // Cold admission uses one pinned object throughout a batch. Preserve its exact
  // generation across awaits even if the same workload and endpoint are replaced.
  const confirmed = new WeakMap<Readonly<TrustedColdPin>, string>();

  function resolve(pin: Readonly<TrustedColdPin>): CompiledColdPlan<Launch> | undefined {
    const current = compile(opts, pin.model, pin.workload);
    return current !== undefined && samePin(current.pin, pin) ? current : undefined;
  }

  function readyGeneration(pin: Readonly<TrustedColdPin>): string | undefined {
    try {
      const plan = resolve(pin)?.plan;
      if (plan === undefined) return undefined;
      const proof = opts.readResident(pin.workload);
      if (proof === undefined || !residentMatches(proof, pin, plan)) return undefined;
      const generation = confirmed.get(pin);
      if (generation !== undefined && generation !== proof.runtimeGeneration) return undefined;
      const routes = opts.readReadyRoutes(pin.model);
      const [route] = routes;
      return routes.length === 1 && route !== undefined && routeMatches(route, pin, proof)
        ? proof.runtimeGeneration
        : undefined;
    } catch {
      return undefined;
    }
  }

  function canStart(pin: Readonly<TrustedColdPin>, signal: AbortSignal): boolean {
    try {
      return (
        !signal.aborted &&
        resolve(pin)?.mayActivate === true &&
        opts.readResident(pin.workload) === undefined &&
        opts.readReadyRoutes(pin.model).length === 0
      );
    } catch {
      return false;
    }
  }

  async function activate(
    pin: Readonly<TrustedColdPin>,
    signal: AbortSignal,
  ): Promise<"ready" | "refused" | "uncertain"> {
    if (signal.aborted) return "refused";
    const existing = readyGeneration(pin);
    if (existing !== undefined) {
      confirmed.set(pin, existing);
      return "ready";
    }

    const plan = resolve(pin)?.plan;
    if (plan === undefined || !canStart(pin, signal)) return "refused";
    const locked = { checked: false };
    const stillCurrent = (): boolean => {
      locked.checked = canStart(pin, signal);
      return locked.checked;
    };
    try {
      const result = await opts.launchManaged(plan, { pin, signal, stillCurrent });
      if (result.kind !== "ready") return result.kind;
      if (!locked.checked || readyGeneration(pin) !== result.runtimeGeneration) return "uncertain";
      confirmed.set(pin, result.runtimeGeneration);
      return "ready";
    } catch {
      return "uncertain";
    }
  }

  return {
    pin(entry): TrustedColdPin | undefined {
      if (
        entry.kind !== "ModelRun" ||
        entry.ownerNodeId !== opts.ownerNodeId ||
        !launchable(entry)
      ) {
        return undefined;
      }
      return compile(opts, entry.id, entry.workload)?.pin;
    },
    activate,
    ready(pin, signal): Promise<ReadyColdDeployment | undefined> {
      const runtimeGeneration = signal.aborted ? undefined : readyGeneration(pin);
      return Promise.resolve(
        runtimeGeneration === undefined ? undefined : { pin, runtimeGeneration },
      );
    },
    stillOwns(deployment): boolean {
      return readyGeneration(deployment.pin) === deployment.runtimeGeneration;
    },
  };
}
