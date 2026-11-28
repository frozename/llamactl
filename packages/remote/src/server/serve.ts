import type {
  AgentWorkerRpc,
  AgentWorkerRpcRelay,
  ExecutionAdmissionConfig,
  ManagedColdModelRuns,
} from "@llamactl/core/config/agent-config";

import { inferenceRpc, nodeFacts, openaiProxy } from "@llamactl/core";
import {
  createEngineScopeLauncher,
  type EngineScopeLauncher,
  getEngineScopeLauncher,
  setEngineScopeLauncher,
} from "@llamactl/core/engines/scope";
import { resolveEnv } from "@llamactl/core/env";
import {
  type ColdEngineForwarder,
  getLocalEngineForwarder,
  installLocalEngineForwarder,
} from "@llamactl/core/residency/engine-forwarder";
import {
  createResidencyLeases,
  getResidencyLeaseRegistry,
  type ResidencyLeases,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { hasManagedRuntimeMarker } from "@llamactl/core/residency/managed-runtime";
import {
  createSessionRefcounts,
  currentSessionRefcounts,
  type SessionRefcounts,
  setSessionRefcountRegistry,
} from "@llamactl/core/residency/sessions";
import { listLocalRoutes, migrateLegacySingletonRuntime } from "@llamactl/core/workloadRuntime";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { join } from "node:path";

import type { ResidencyApplyProfileResult } from "../residency/apply-profile.js";
import type { InferenceHolds } from "../residency/inference-holds.js";
import type { ManagedLaunchAdmission } from "../residency/managed-launch-admission.js";
import type { RequestAdmission } from "../residency/request-admission.js";
import type { ModelRun } from "../workload/schema.js";

import {
  createWorkerRpcHost,
  DEFAULT_SHARED_MAX_ACTIVE_PER_OWNER,
  type InferenceRpcContext,
  publishWorkerRpcHost,
  type WorkerRpcHostOptions,
} from "../inference/procedures.js";
import {
  createSharedUnifiedProxy,
  dispatchProxyRequest,
  publishUnifiedPeerSnapshots,
  type UnifiedProxy,
  unifiedProxyEnabled,
  type UnifiedProxyOptions,
} from "../proxy/create-proxy.js";
import { captureInference, scheduleCaptureExpiry } from "../request-capture/record.js";
import { CAPTURE_PATH, captureResponse, REQUEST_ID } from "../request-capture/store.js";
import { runProfileSwitchBootRecovery } from "../residency/boot-recovery.js";
import {
  declaredManifestSignature,
  type DeclaredWorkloadPhase,
  listDeclaredModels,
} from "../residency/catalog.js";
import {
  createOwnerActivity,
  type IdleProfileWindow,
  type OwnerActivity,
  type OwnerAdmissionPause,
} from "../residency/owner-activity.js";
import {
  createOwnerAdmission,
  type OwnerAdmission,
  type SelectOwnerTransport,
} from "../residency/owner-admission.js";
import { PEER_COLD_ROUTE, type PeerColdCredential } from "../residency/peer-cold.js";
import {
  createResidencyLeaseAuditSink,
  defaultResidencyStorePath,
  openResidencyOperationStore,
} from "../residency/store.js";
import {
  type AgentRouterContext,
  router as appRouter,
  directWorkloadProvenDown,
  runIdleProfileMutation,
} from "../router.js";
import { type FleetSnapshotRouteOptions, handleFleetSnapshotRoute } from "../routes/fleet.js";
import { existsSync, readFileSync } from "../safe-fs.js";
import { type SearchIngestStop, startSearchIngest } from "../search/ingest/lifecycle.js";
import {
  type ClientWebSocketConstructor,
  createTunnelClient,
  createTunnelRouterHandler,
  createTunnelServer,
  createTunnelSubscriptionHandler,
  type TunnelClient,
  type TunnelReq,
  type TunnelServer,
  type TunnelState,
} from "../tunnel/index.js";
import { isInferenceRpcProcedure } from "../tunnel/messages.js";
import { LOCAL_NODE_ID } from "../workload/modelhost-schema.js";
import { listWorkloads, saveWorkload } from "../workload/store.js";
import { handleAgentRollback, handleAgentUpdate } from "./agent-update.js";
import { type ArtifactsHandlerOptions, handleArtifact } from "./artifacts.js";
import {
  bearerNameFor,
  claimsForServiceCredential,
  createServiceTokenVerifier,
  extractBearer,
  type NamedBearerToken,
  PRIMARY_BEARER_NAME,
  relayPrincipalOf,
  SERVICE_TOKEN_HEADER,
  SERVICE_TOKEN_MAX_LENGTH,
  type ServiceCredentialBinding,
  unauthorizedResponse,
} from "./auth.js";
import { admitChatCompletions } from "./chat-admission.js";
import { type ManagedColdOwnerFactory, prepareColdOwnerMount } from "./cold-owner-mount.js";
import { handleInstallScript, type InstallScriptHandlerOptions } from "./install-script.js";
import { publishAgentMdns, type PublishedAgent } from "./mdns.js";
import {
  agentBearerLastUsedSeconds,
  agentBearerRequestsTotal,
  agentInfo,
  llamaServerUp,
  registry as metricsRegistry,
  observeAdmissionWait,
  openaiPathBucket,
  openaiRequestDurationSeconds,
  openaiRequestsTotal,
  openaiUpstreamErrorsTotal,
  setAgentRuntimeIdentity,
  setModelHostMetricsNode,
  setOwnerAdmissionMetricsReader,
  setRuntimeProcessMemoryReader,
  statusClass,
} from "./metrics.js";
import { preparePeerColdHandler } from "./peer-cold-mount.js";
import { startPeerSnapshotPoller } from "./peer-snapshot-poller.js";
import { defaultProcessMemoryReader, type ProcessMemoryReader } from "./process-memory.js";
import { handleRagChatCompletions } from "./rag-chat-endpoint.js";
import { handleRegister, type RegisterHandlerOptions } from "./register.js";
import { loadCert } from "./tls.js";
import { handleTunnelRelay } from "./tunnel-relay.js";

export interface StartAgentOptions {
  bindHost?: string; // default '127.0.0.1'
  port?: number; // default 0 (let OS pick)
  endpoint?: string; // default '/trpc'
  tokenHash: string; // SHA-256 hex of the expected bearer token
  /**
   * Named operator bearer tokens (#218), read on every request, so an
   * added or revoked token applies without a restart. Each authenticates
   * the authed API routes exactly as `tokenHash` does; the tunnel relay,
   * self-update and rollback stay primary-only, so their admitted hops are
   * audited under the primary's name 'default'.
   */
  bearerTokens?: () => readonly NamedBearerToken[] | undefined;
  /**
   * Per-request audit hook (#218), called once for each request the
   * bearer gate admits, with the matched token's name ('default' for
   * the primary, 'named:default' for a legacy named entry called
   * 'default'). It never receives the token, its hash or the query
   * string. When omitted, the agent writes one stderr line per admitted
   * request: `[agent] auth token=<name> <METHOD> <pathname>\n`. Passing
   * the hook replaces that line.
   */
  onAuthenticated?: (record: { tokenName: string; method: string; pathname: string }) => void;
  /**
   * The persisted per-token last-use store (#218), wired by `agent serve`
   * beside agent.yaml. Every bearer the gate admits is handed to `record`
   * under its audit label (never the token or its hash), and the
   * last-used gauge is seeded from `snapshot` at start so a restart does
   * not report every token as never used. Either half may throw: the
   * agent notes it on stderr and carries on — last use never fails a
   * request and never blocks boot.
   */
  bearerLastUsed?: {
    record: (label: string) => void;
    snapshot: () => Readonly<Record<string, string>>;
  };
  noAuth?: boolean;
  tls?: { certPath: string; keyPath: string }; // omit for plain HTTP (test-only)
  /**
   * Override Bun.serve's idleTimeout for the whole server. Tests set a
   * small value to exercise the per-request `server.timeout` bump on
   * proxied routes without waiting out the production 255s; leave unset.
   */
  idleTimeoutSeconds?: number;
  onRequest?: (url: URL) => void;
  /**
   * Labels attached to `llamactl_agent_info`. Defaults to a best-
   * effort guess from env; callers can override for deterministic
   * test output.
   */
  nodeName?: string;
  version?: string;
  /**
   * Advertise this agent over mDNS so other LAN nodes can discover
   * it. Defaults to true on a TLS-enabled agent (production), false
   * otherwise (hermetic test agents shouldn't pollute the network).
   */
  advertiseMdns?: boolean;
  /**
   * Poll cluster peers' /v1/fleet/snapshot and publish them to the openaiProxy
   * so peer models route through this proxy (with prefix-cache). Off by default
   * — only the production CLI (`agent serve`) enables it; hermetic test agents
   * must not make network calls to real peers.
   */
  peerSnapshotPoll?: boolean;
  peerSnapshotPollIntervalMs?: number;
  /**
   * Registers the #280 DF-07 declared-model source with openaiProxy:
   * agent-local workload manifests projected to DeclaredModelEntryV1.
   * Off by default — only `agent serve` with LLAMACTL_DECLARED_MODELS=1
   * enables it. The source is read fresh on every route miss and every
   * listing and never cached, because in-place manifest edits do not
   * bump the dir mtime.
   */
  declaredModels?: boolean;
  /** Authoritative owner evidence for negotiated peer GETs. Missing data publishes no proof. */
  peerDeclarationProvenance?: () => unknown;
  /**
   * Override paths for the /register handler. Production leaves this
   * unset so the handler uses ~/.llamactl/bootstrap-tokens and
   * ~/.llamactl/config; tests inject tempdirs.
   */
  registerOptions?: RegisterHandlerOptions;
  /** Tempdir injection for /install-agent.sh in tests. */
  installScriptOptions?: InstallScriptHandlerOptions;
  /** Tempdir injection for /artifacts/* in tests. */
  artifactsOptions?: ArtifactsHandlerOptions;
  /**
   * When set, agent mounts the reverse-tunnel upgrade handler at
   * `/tunnel` and the HTTP relay at `/tunnel-relay/<nodeName>`.
   * Agents that dial in use this agent as their central.
   * See packages/remote/src/tunnel/README or radiant-converging-knuth.md §I.3.
   */
  tunnelCentral?: {
    /** SHA-256 hex of the bearer tunnel clients present in their
     *  first hello frame. Distinct from tokenHash — tunnel bearers
     *  are a separate credential. */
    expectedBearerHash: string;
    /**
     * Central's relay-only credentials (P4.1), agent.yaml's
     * `workerRpcRelay` block, read on every relay request. Each admits
     * only relaying the worker-RPC procedures to nodes; the operator bearer
     * keeps relaying everything, as before.
     */
    workerRpcRelay?: () => AgentWorkerRpcRelay | undefined;
    onNodeConnect?: (nodeName: string) => void;
    onNodeDisconnect?: (nodeName: string, reason: string) => void;
  };
  /**
   * Override the JSONL audit journal path for tunnel events
   * (connect / disconnect / relay-call / relay-error / unauthorized
   * / replaced). Resolves to
   * `defaultTunnelJournalPath()` inside journal.ts when undefined
   * (honors `$LLAMACTL_TUNNEL_JOURNAL` and `$DEV_STORAGE`). Pass
   * through on both sides: `createTunnelServer` gets it for the WS
   * events, `handleTunnelRelay` gets it for the HTTP bridge events.
   */
  tunnelJournalPath?: string;
  /**
   * Override the JSONL fleet journal that `GET /v1/fleet/snapshot`
   * reads. Resolves to `defaultFleetJournalPath()` inside the route
   * when undefined (honors `$DEV_STORAGE`). Set this so the agent
   * serves the SAME journal the fleet-supervisor writes — otherwise,
   * when the agent and supervisor processes have different
   * `$DEV_STORAGE`, the route resolves a different (stale) default
   * path than the supervisor writes to. `agent serve --fleet-journal`
   * threads this through.
   */
  fleetJournalPath?: string;
  /**
   * When set, agent dials a central's /tunnel endpoint and bridges
   * inbound req frames to its own tRPC router. Use alongside or
   * independently of tunnelCentral — a given agent can be both
   * central (for NAT'd nodes that dial in) and a dialing node
   * (relative to a different central) if the fleet topology wants it.
   */
  tunnelDial?: {
    url: string;
    bearer: string;
    nodeName: string;
    /** Optional observer for connecting|ready|disconnected|stopped. */
    onStateChange?: (state: TunnelState) => void;
    /** Pass through to createTunnelClient; omit for production defaults. */
    initialAttemptTimeoutMs?: number;
    /** Test-only WebSocket constructor override. */
    WebSocketCtor?: ClientWebSocketConstructor;
  };
  /**
   * Serve the InferenceRpcV1 worker (P4.1). `workerId` is the node's
   * kubeconfig name, which the worker's deployment ids embed.
   * `settings` (agent.yaml's `workerRpc` block) is read on every RPC
   * call: a service credential is accepted, on the worker-RPC procedures only,
   * when it matches a binding, and the versions it lists that this build
   * speaks are advertised. Absent or listing no version, the RPC is not
   * advertised, as before. `stop()` drains active attempts for up to
   * `drainTimeoutMs` (default 15 s), then cancels the rest.
   */
  workerRpc?: {
    workerId: string;
    settings: () => AgentWorkerRpc | undefined;
    drainTimeoutMs?: number;
    /** Stands in for the engines, so a test can hold a backend's unwind after a cancel. */
    backends?: WorkerRpcHostOptions["backends"];
  };
  /**
   * Opt-in residency leases (#278 DF-05): `agent serve` sets it from
   * `LLAMACTL_RESIDENCY_LEASES`. When true, `startAgentServer` creates ONE
   * registry with `createResidencyLeases()`, passes that same instance to the
   * Worker RPC host, and installs it in the process-wide seam `proxyOpenAI`
   * reads only once the listener is up, so a failed bind never leaves an
   * orphan registry behind. `stop()` restores the seam's previous value after
   * the worker-RPC drain settles in-flight bodies. When unset (the production
   * default) the seam is never read or written, the host gets no
   * `residencyLeases`, and behaviour is identical.
   *
   * A throw anywhere after the Worker RPC host is published now
   * unpublishes it, restores the seam and stops the bound server.
   *
   * The #599 oMLX native client gets this published registry through
   * residency/engine-client.ts createAgentOmlxNativeClient (#282). No
   * production unload caller is wired yet: modelhost.ts has no native
   * load/unload path, and adding one is a separate activation step. Until
   * that lands, the lease acceptance is not enforced on any production
   * native unload.
   */
  residencyLeases?: boolean;
  /**
   * Opt-in session idle timeout in milliseconds (#520), passed unchanged to
   * `createSessionRefcounts` as `idleTimeoutMs`. Honored only when
   * `residencyLeases` is true. When set, `startAgentServer` builds a session
   * refcount registry and installs it through `setSessionRefcountRegistry`
   * beside the lease registry once the listener binds. `stop()` restores the
   * seam's previous value after the drain, so session state is in-memory and
   * does not carry over to a restarted agent.
   */
  residencySessionIdleMs?: number;
  /**
   * Opt-in engine scopes (#806 phase 3): `agent serve` sets it unless
   * LLAMACTL_ENGINE_SCOPE=off. When true on linux, `startAgentServer`
   * publishes a systemd user-scope launcher so agent-launched ModelHost and
   * ModelRun engines each run in their own transient scope; `stop()` and
   * startup rollback restore the seam's previous value. On other platforms
   * the handle is null and every launch stays a direct spawn.
   */
  engineScope?: boolean;
  /**
   * Opt-in request-admission gate (#281 DF-08), absent by default. When set,
   * `startAgentServer` holds an admission slot for the whole response lifetime
   * and refuses overload instead of queueing unbounded work upstream. Covered:
   * POST /v1/chat/completions, POST /v1/messages, POST /v1/responses and
   * generic POST /v1/completions, plus router chatComplete/chatStream on
   * inproc://local — both over /trpc and relayed through the tunnel client's
   * contextFor, which inject this instance into the router context. The
   * in-process RAG via-forward is covered by its outer HTTP slot. Worker RPC
   * streams share the cap too. Not counted: /v1/embeddings and RAG embedding
   * (a nested embedder would self-deadlock), /v1/rerank and the other generic
   * /v1/* POSTs and the planner local provider, which are deferred. One shared
   * instance and one limit cover everything admitted at this agent —
   * peer-routed and via/RAG included — under one ingress key and one
   * principal; physical per-node accounting comes later.
   */
  chatCompletionsAdmission?: RequestAdmission;
  /** Trusted host adapter for the two explicit agent start procedures. */
  managedLaunchAdmission?: ManagedLaunchAdmission;
  /** Explicit owner factory for authenticated local cold completion requests. */
  managedColdOwnerFactory?: ManagedColdOwnerFactory;
  managedColdModelRuns?: ManagedColdModelRuns;
  managedPeerColdCredentials?: readonly PeerColdCredential[];
  managedPeerColdGateway?: Required<Pick<UnifiedProxyOptions, "peers" | "peerCold">>;
  executionAdmission?: ExecutionAdmissionConfig;
  managedInferenceHolds?: InferenceHolds;
  selectManagedEngineTransport?: SelectOwnerTransport | undefined;
  selectManagedEngineReadiness?: Parameters<typeof installLocalEngineForwarder>[1];
  /** Trusted programmatic owner wiring. The host must verify that no ingress bypasses these admissions. */
  managedOwnerActivity?: { verifyExclusiveIngress: () => unknown };
  /**
   * Per-role runtime memory budget. Sets the identity (role + optional
   * memory budget) so the Prometheus gauges emit per-role series. When
   * omitted, the role defaults to "agent" and no budget/over-budget
   * series are emitted.
   */
  runtimeRole?: string;
  runtimeMemoryBudgetBytes?: number;
  /** Tests inject a deterministic reader; production uses the platform probe. */
  processMemoryReader?: ProcessMemoryReader;
}

export interface RunningAgent {
  url: string; // e.g. https://127.0.0.1:7843
  port: number;
  fingerprint: string | null;
  stop: () => Promise<void>;
  handleRequest?: (req: Request, address?: ClientAddress | null) => Promise<Response>;
  tryQuiesceOwnerAdmissions?: () => OwnerAdmissionPause | undefined;
  tryApplyIdleProfile?: (window: IdleProfileWindow) => Promise<ResidencyApplyProfileResult>;
  /** Present only when StartAgentOptions.tunnelCentral was set. */
  tunnelServer?: TunnelServer;
  /** Present only when StartAgentOptions.tunnelDial was set. */
  tunnelClient?: TunnelClient;
}

function synthesizeTransientWorkload(workloadName: string, statePath: string): void {
  if (!existsSync(statePath)) return;
  try {
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as {
      rel?: string;
      extraArgs?: string[];
      host?: string;
      port?: string | number;
      binary?: string;
    };
    if (typeof parsed.rel !== "string") return;
    const transient: ModelRun = {
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: { name: workloadName, labels: {}, annotations: {} },
      spec: {
        node: "local",
        enabled: true,
        target: { kind: "rel", value: parsed.rel },
        extraArgs: Array.isArray(parsed.extraArgs) ? parsed.extraArgs : [],
        workers: [],
        restartPolicy: "Never",
        timeoutSeconds: 60,
        ...(typeof parsed.host === "string" || typeof parsed.port === "number"
          ? {
              endpoint: {
                ...(typeof parsed.host === "string" ? { host: parsed.host } : {}),
                ...(typeof parsed.port === "number" ? { port: parsed.port } : {}),
              },
            }
          : {}),
        ...(typeof parsed.binary === "string" ? { binary: parsed.binary } : {}),
        gateway: false,
        allowExternalBind: false,
      },
    };
    saveWorkload(transient);
  } catch {
    // Best effort only; the migrated runtime files are the source of truth.
  }
}

interface ClientAddress {
  address: string;
  port?: number;
  family?: string;
}

function formatClientAddress(address: ClientAddress | null | undefined): string {
  if (!address) return "unknown";
  return typeof address.port === "number"
    ? `${address.address}:${String(address.port)}`
    : address.address;
}

function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  return (
    address === "127.0.0.1" ||
    address === "localhost" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

export function runStartupMigration(): void {
  try {
    const resolved = resolveEnv();
    const migration = migrateLegacySingletonRuntime(
      resolved,
      listWorkloads().map((w) => ({
        metadata: { name: w.metadata.name },
        spec: {
          node: w.spec.node,
          target: w.spec.target,
          ...(w.spec.endpoint !== undefined
            ? {
                endpoint: {
                  ...(w.spec.endpoint.host !== undefined ? { host: w.spec.endpoint.host } : {}),
                  ...(w.spec.endpoint.port !== undefined ? { port: w.spec.endpoint.port } : {}),
                },
              }
            : {}),
        },
      })),
    );
    if (migration.kind === "migrated") {
      process.stderr.write(
        `[migration] re-homed legacy runtime under workload '${migration.workload}'\n`,
      );
    } else if (migration.kind === "synthesized") {
      process.stderr.write(
        `[migration] no manifest matched legacy state; synthesized '${migration.workload}'\n`,
      );
      synthesizeTransientWorkload(
        migration.workload,
        join(resolved.LOCAL_AI_RUNTIME_DIR, "workloads", migration.workload, "llama-server.state"),
      );
    }
  } catch {
    // Best effort only. If the legacy runtime path is unavailable or
    // unwritable, the agent still needs to start and serve the current state.
  }
}

interface NoAuthGate {
  allowNoAuth(pathname: string, address: ClientAddress | null): boolean;
  logUnauthenticatedNoAuthRequest(req: Request, address: ClientAddress | null): void;
}

function makeNoAuthGate(noAuth: boolean, bindHost: string): NoAuthGate {
  let unauthenticatedNoAuthRequestCount = 0;
  return {
    allowNoAuth(pathname: string, address: ClientAddress | null): boolean {
      return (
        noAuth &&
        pathname.startsWith("/v1/") &&
        isLoopbackAddress(bindHost) &&
        isLoopbackAddress(address?.address)
      );
    },
    logUnauthenticatedNoAuthRequest(req: Request, address: ClientAddress | null): void {
      if (!noAuth || extractBearer(req)) return;
      unauthenticatedNoAuthRequestCount += 1;
      if ((unauthenticatedNoAuthRequestCount - 1) % 100 !== 0) return;
      process.stderr.write(
        `[agent] WARNING: serving unauthenticated request from ${formatClientAddress(address)}: ${req.method} ${new URL(req.url).pathname}\n`,
      );
    },
  };
}

/**
 * Records an admitted request under the name of the bearer that
 * authenticated it (#218): the per-token counter, the last-used gauge,
 * the persisted last-use store, then the audit sink — `onAuthenticated`
 * when given, else the default stderr line. The sink is wrapped so a
 * throwing hook never fails the request; on error a note without any
 * token is written instead.
 *
 * The privileged routes (self-update, rollback, operator tunnel-relay
 * hops) verify the primary bearer inside their own handlers, so they
 * reach this through `primaryBearerAuditor` and are recorded under
 * 'default'; named tokens stay refused there.
 */
function recordBearerUse(
  req: Request,
  pathname: string,
  name: string,
  opts: StartAgentOptions,
): void {
  agentBearerRequestsTotal.inc({ token: name });
  agentBearerLastUsedSeconds.set({ token: name }, Date.now() / 1000);
  try {
    opts.bearerLastUsed?.record(name);
  } catch {
    process.stderr.write(`[agent] bearer last-use record failed for token=${name}\n`);
  }
  try {
    if (opts.onAuthenticated) {
      opts.onAuthenticated({ tokenName: name, method: req.method, pathname });
    } else {
      process.stderr.write(`[agent] auth token=${name} ${req.method} ${pathname}\n`);
    }
  } catch {
    process.stderr.write(`[agent] auth sink failed for token=${name} ${req.method} ${pathname}\n`);
  }
}

/**
 * Run the shared bearer-auth gate for a route: no-auth-eligible
 * requests are logged and admitted; everything else must carry a
 * valid bearer — the primary one or one of the named tokens. Returns
 * the 401 response when the request must be rejected, null when it
 * may proceed. An admitted bearer request is recorded under its token
 * name unless `record` is false, which the RAG fallback passes so a
 * bearer check re-run there does not double-count.
 */
function authGateReject(
  req: Request,
  pathname: string,
  address: ClientAddress | null,
  opts: StartAgentOptions,
  gate: NoAuthGate,
  record = true,
): Response | null {
  if (gate.allowNoAuth(pathname, address)) {
    gate.logUnauthenticatedNoAuthRequest(req, address);
    return null;
  }
  const name = bearerNameFor(extractBearer(req), opts.tokenHash, opts.bearerTokens?.() ?? []);
  if (name === null) return unauthorizedResponse();
  if (record) recordBearerUse(req, pathname, name, opts);
  return null;
}

type ServingAgentOptions = StartAgentOptions & {
  trustedColdOwner?: ColdEngineForwarder | undefined;
  peerCold?: ReturnType<typeof preparePeerColdHandler>;
  peerColdGateway?: UnifiedProxy | undefined;
};

async function handleOpenAIRoute(
  req: Request,
  url: URL,
  address: ClientAddress | null,
  opts: ServingAgentOptions,
  gate: NoAuthGate,
  server: AgentFetchServer,
  record = true,
): Promise<Response> {
  const denied = authGateReject(req, url.pathname, address, opts, gate, record);
  if (denied) return denied;
  const pathLabel = openaiPathBucket(url.pathname);
  const endTimer = openaiRequestDurationSeconds.startTimer({ path: pathLabel });
  let status = 0;
  try {
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const includeDeclared = url.searchParams
        .getAll("include")
        .flatMap((v) => v.split(","))
        .some((v) => v.trim() === "declared");
      const full = await openaiProxy.listServingOpenAIModels();
      llamaServerUp.set(full.data.length > 0 ? 1 : 0);
      status = 200;
      return Response.json(openaiProxy.projectModelsResponseBody(full, includeDeclared));
    }
    server.timeout?.(req, proxiedRouteIdleSeconds());
    const forward = (): Promise<Response> =>
      opts.peerColdGateway !== undefined && unifiedProxyEnabled()
        ? opts.peerColdGateway.handleRequest(req, opts.trustedColdOwner)
        : dispatchProxyRequest(req, opts.trustedColdOwner);
    const res = record ? await captureInference(req, url.pathname, forward) : await forward();
    status = res.status;
    if (status === 502) openaiUpstreamErrorsTotal.inc();
    return res;
  } finally {
    endTimer();
    openaiRequestsTotal.inc({ path: pathLabel, status_class: statusClass(status) });
  }
}

interface AgentFetchServer {
  requestIP?: (req: Request) => ClientAddress | null;
  upgrade(req: Request, opts: { data: unknown }): boolean;
  timeout?(req: Request, seconds: number): void;
}

/**
 * A proxied inference call can legitimately sit silent past
 * Bun.serve's 255s idle ceiling — a non-streaming reply writes nothing
 * until the upstream finishes. Re-arming the request's idle budget to
 * the upstream fetch deadline (+60s so the fetch's own TimeoutError
 * still wins the race and surfaces as a clean 502 instead of a socket
 * reset) keeps long cold prefills alive without raising the global
 * idleTimeout for non-inference routes.
 */
function proxiedRouteIdleSeconds(): number {
  return Math.ceil(openaiProxy.upstreamTimeoutMs() / 1000) + 60;
}

type AgentFetchHandler = (req: Request, server: AgentFetchServer) => Response | Promise<Response>;

/**
 * The audit closure the privileged routes hand their bearer check (#218).
 * Those routes verify the primary bearer only, so the admitted hop is
 * recorded under `PRIMARY_BEARER_NAME`.
 */
function primaryBearerAuditor(req: Request, url: URL, opts: StartAgentOptions): () => void {
  return (): void => {
    recordBearerUse(req, url.pathname, PRIMARY_BEARER_NAME, opts);
  };
}

/**
 * Infrastructure routes that precede the API surface: health checks,
 * reverse-tunnel endpoints, bootstrap registration, the install
 * script, artifact downloads, and agent self-update/rollback. Order
 * is load-bearing — it mirrors the original route chain exactly.
 * Returns null when no route matched (fall through to the API routes).
 */
function handleInfraRoutes(
  req: Request,
  url: URL,
  server: AgentFetchServer,
  opts: StartAgentOptions,
  tunnelServer: TunnelServer | null,
): Response | Promise<Response> | null {
  if (url.pathname === "/health" || url.pathname === "/healthz") {
    // The JSON build object is returned only with Accept: application/json;
    // the plain-text "ok" stays for update/probes.ts agentHealthy and older
    // CLIs. Fleet deploy verifiers must send that header (#743).
    if (req.headers.get("accept")?.includes("application/json")) {
      return Response.json({ status: "ok", build: nodeFacts.resolveBuildStamp() });
    }
    return new Response("ok", { status: 200 });
  }
  // Reverse-tunnel endpoints — gated on opts.tunnelCentral. Both
  // are no-ops when tunnelServer is null (falls through to 404).
  // handleUpgrade returns undefined on a successful upgrade (Bun
  // owns the response) and a 400 Response on upgrade failure. The
  // 101 placeholder is unreachable when the upgrade succeeded
  // (Bun has already taken over the socket); it satisfies the
  // typed Response return shape for the fetch handler.
  if (url.pathname === "/tunnel" && tunnelServer) {
    const upgradeRes = tunnelServer.handleUpgrade(req, server);
    return upgradeRes ?? new Response(null, { status: 101 });
  }
  if (url.pathname.startsWith("/tunnel-relay/") && tunnelServer) {
    return handleTunnelRelay(
      req,
      url,
      forwardingServiceToken(tunnelServer, req),
      opts.tokenHash,
      opts.tunnelJournalPath,
      opts.tunnelCentral?.workerRpcRelay?.()?.tokenHashes ?? [],
      primaryBearerAuditor(req, url, opts),
    );
  }
  // Bootstrap registration — unauthenticated by design (nodes have
  // no bearer yet; that's what this endpoint mints). Consumes a
  // single-use token from deploy-node, writes to kubeconfig.
  if (url.pathname === "/register") {
    return handleRegister(req, opts.registerOptions ?? {});
  }
  // Install-script endpoint — returns the curl-pipe-sh bootstrap
  // script for the given token. Unauthenticated; the token query
  // param is the capability. Hits /artifacts + /register once the
  // target host runs it.
  if (url.pathname === "/install-agent.sh") {
    return handleInstallScript(req, opts.installScriptOptions ?? {});
  }
  // Artifact server — streams pre-built llamactl-agent binaries
  // to the curl-pipe-sh installer. Public, no auth (the binary is
  // the same thing anyone can compile from git; serving it over
  // TLS with caching is a convenience, not a privilege).
  if (url.pathname.startsWith("/artifacts/")) {
    return handleArtifact(req, url, opts.artifactsOptions ?? {});
  }
  // Agent self-update endpoint — bearer-auth'd POST that takes a
  // raw binary body + X-Sha256 header, atomic-replaces the running
  // binary, and exits so launchd respawns into the new build.
  // Used by `llamactl agent update --node <n>` from the control
  // plane; never exposed unauthenticated. An admitted primary bearer is
  // audited (#218) before the build-stamp refusal.
  if (url.pathname === "/agent/update") {
    return handleAgentUpdate(req, {
      tokenHash: opts.tokenHash,
      onAuthenticated: primaryBearerAuditor(req, url, opts),
    });
  }
  // Companion to /agent/update — restores `<execPath>.previous`
  // over the running binary + exits 0 so launchd respawns the
  // prior version. Symmetric: calling it twice flips back. Like update, an
  // admitted primary bearer is audited before any refusal.
  if (url.pathname === "/agent/rollback") {
    return handleAgentRollback(req, {
      tokenHash: opts.tokenHash,
      onAuthenticated: primaryBearerAuditor(req, url, opts),
    });
  }
  return null;
}

/**
 * The tunnel server as one relay request sees it: a worker-RPC caller's
 * single-use service token rides, unread, on the worker-RPC procedures' req
 * frames, named exactly, stamped with the relay principal of the bearer this
 * hop presented, for the node to verify. The relay hop itself stays
 * authorized by central's own bearer.
 */
function forwardingServiceToken(server: TunnelServer, req: Request): TunnelServer {
  const token = req.headers.get(SERVICE_TOKEN_HEADER);
  const bearer = extractBearer(req);
  if (token === null || token === "" || token.length > SERVICE_TOKEN_MAX_LENGTH) return server;
  if (bearer === null) return server;
  const auth = { serviceToken: token, relayPrincipal: relayPrincipalOf(bearer) };
  const withAuth = (frame: Omit<TunnelReq, "type">): Omit<TunnelReq, "type"> =>
    isInferenceRpcProcedure(frame.method) ? { ...frame, auth } : frame;
  return {
    ...server,
    send: (nodeName, frame) => server.send(nodeName, withAuth(frame)),
    sendSubscribe: (nodeName, frame) => server.sendSubscribe(nodeName, withAuth(frame)),
  };
}

function inspectCapturedRequest(req: Request, pathname: string, opts: StartAgentOptions): Response {
  if (bearerNameFor(extractBearer(req), opts.tokenHash, opts.bearerTokens?.() ?? []) === null) {
    return unauthorizedResponse();
  }
  if (req.method !== "GET") return new Response(null, { status: 405 });
  if (pathname === CAPTURE_PATH) return captureResponse();
  const id = pathname.slice(CAPTURE_PATH.length + 1);
  return REQUEST_ID.test(id) ? captureResponse(id) : new Response(null, { status: 404 });
}

function fleetSnapshotOptions(opts: StartAgentOptions): FleetSnapshotRouteOptions {
  const snapshot: FleetSnapshotRouteOptions = {};
  if (opts.fleetJournalPath !== undefined) snapshot.journalPath = opts.fleetJournalPath;
  if (opts.noAuth !== true && opts.peerDeclarationProvenance !== undefined) {
    snapshot.declaredProvenance = {
      ownerNodeId: opts.nodeName ?? process.env["LLAMACTL_NODE_NAME"] ?? "agent",
      read: opts.peerDeclarationProvenance,
    };
  }
  return snapshot;
}

/**
 * Bearer-auth'd API routes: metrics, RAG-aware chat completions, the
 * fleet snapshot, and the OpenAI-compatible /v1 gateway. Order is
 * load-bearing — it mirrors the original route chain exactly.
 * Returns null when no route matched (fall through to /trpc).
 */
function handleAuthedApiRoutes(
  req: Request,
  url: URL,
  clientAddress: ClientAddress | null,
  opts: ServingAgentOptions,
  gate: NoAuthGate,
  server: AgentFetchServer,
): Response | Promise<Response> | null {
  if (url.pathname === CAPTURE_PATH || url.pathname.startsWith(CAPTURE_PATH + "/")) {
    return inspectCapturedRequest(req, url.pathname, opts);
  }
  // Prometheus scrape endpoint. Bearer-auth'd like everything else;
  // scrapers can set the standard Authorization header.
  if (url.pathname === "/metrics") {
    return handleMetricsRoute(req, url, clientAddress, opts, gate);
  }
  // RAG-aware chat completions. Plain OpenAI clients can opt into
  // retrieval by adding a `rag: {node, topK?}` extension field, and
  // must include `via: <node>` to name the llamactl node to route
  // chat through. When neither field is present the handler falls
  // through to the legacy openai-proxy path below. Non-POST / other
  // paths under /v1/* fall straight through to handleOpenAIRoute.
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    return handleChatCompletionsRoute(req, url, clientAddress, opts, gate, server);
  }
  if (req.method === "GET" && url.pathname === "/v1/fleet/snapshot") {
    const denied = authGateReject(req, url.pathname, clientAddress, opts, gate);
    if (denied) return denied;
    return handleFleetSnapshotRoute(req, fleetSnapshotOptions(opts));
  }
  // #281 DF-08: the Anthropic Messages, OpenAI Responses and generic
  // completions ingresses share the chat-completions admission instance.
  // Exact pathname match, as core's parseIncoming does; when the option is
  // absent these fall through to the generic proxy branch untouched.
  const proxyAdmission = opts.chatCompletionsAdmission;
  if (isAdmittedProxyIngress(req, url, proxyAdmission)) {
    return handleAdmittedProxyRoute(req, url, clientAddress, opts, gate, server, proxyAdmission);
  }
  // OpenAI-compatible gateway. Anything under /v1/* is bearer-auth'd
  // then either listed (GET /v1/models — static, no upstream call)
  // or proxied straight to the local llama-server so external tools
  // can speak plain OpenAI SDK to the agent's URL.
  if (url.pathname.startsWith("/v1/") || url.pathname === "/v1") {
    return handleOpenAIRoute(req, url, clientAddress, opts, gate, server);
  }
  return null;
}

// #281 DF-08: the generic /v1/completions ingress shares the chat cap through
// the same create-proxy dispatchProxyRequest branch every other /v1/* route
// takes. /v1/embeddings is excluded on purpose: an embedder call nested inside
// an admitted chat (RAG) would self-deadlock behind its own outer slot.
// /v1/rerank and the other generic /v1/* POSTs are deferred.
function isAdmittedProxyIngress(
  req: Request,
  url: URL,
  admission: RequestAdmission | undefined,
): admission is RequestAdmission {
  return (
    admission !== undefined &&
    req.method === "POST" &&
    (url.pathname === "/v1/messages" ||
      url.pathname === "/v1/responses" ||
      url.pathname === "/v1/completions")
  );
}

// Capture the original chat before admission and RAG rewrite so results
// describe what the client sent, including requests refused during admission.
function handleChatCompletionsRoute(
  req: Request,
  url: URL,
  clientAddress: ClientAddress | null,
  opts: ServingAgentOptions,
  gate: NoAuthGate,
  server: AgentFetchServer,
): Response | Promise<Response> {
  const denied = authGateReject(req, url.pathname, clientAddress, opts, gate);
  if (denied) return denied;
  server.timeout?.(req, proxiedRouteIdleSeconds());
  const admission = opts.chatCompletionsAdmission;
  const forward = (request: Request): Promise<Response> =>
    handleRagChatCompletions(request, {
      appRouter,
      fallback: (forwarded) =>
        handleOpenAIRoute(forwarded, url, clientAddress, opts, gate, server, false),
    });
  return captureInference(req, url.pathname, () =>
    admission === undefined ? forward(req) : admitChatCompletions(req, admission, forward),
  );
}

// #281 DF-08: /v1/messages, /v1/responses and generic /v1/completions share
// the chat-completions admission instance. Auth runs before any acquire;
// record=false so the bearer use admitted here is not double-counted when
// handleOpenAIRoute re-checks it.
// A forward that rejects (a unified-proxy throw) has already released its slot
// inside admitChatCompletions; surfacing it as a reset socket would let the
// rejection escape Bun.serve unhandled, so it is collapsed to a 502.
function handleAdmittedProxyRoute(
  req: Request,
  url: URL,
  clientAddress: ClientAddress | null,
  opts: ServingAgentOptions,
  gate: NoAuthGate,
  server: AgentFetchServer,
  admission: RequestAdmission,
): Response | Promise<Response> {
  const denied = authGateReject(req, url.pathname, clientAddress, opts, gate);
  if (denied) return denied;
  server.timeout?.(req, proxiedRouteIdleSeconds());
  return captureInference(req, url.pathname, () =>
    admitChatCompletions(req, admission, (admitted) =>
      handleOpenAIRoute(admitted, url, clientAddress, opts, gate, server, false),
    ),
  ).catch((err: unknown) => {
    console.warn("admitted proxy route forward failed", { path: url.pathname, error: err });
    return new Response(JSON.stringify({ error: { type: "api_error" } }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  });
}

function handleMetricsRoute(
  req: Request,
  url: URL,
  clientAddress: ClientAddress | null,
  opts: StartAgentOptions,
  gate: NoAuthGate,
): Response | Promise<Response> {
  const denied = authGateReject(req, url.pathname, clientAddress, opts, gate);
  if (denied) return denied;
  return metricsRegistry.metrics().then(
    (text) =>
      new Response(text, {
        status: 200,
        headers: { "content-type": metricsRegistry.contentType },
      }),
  );
}

/**
 * True when every procedure a tRPC request names, under the endpoint, is
 * a worker-RPC procedure named exactly. Batched paths are decoded and
 * split the way tRPC splits them, so a service credential never rides
 * along to another procedure, nor reaches one by another spelling.
 */
function inferenceRpcOnly(pathname: string, endpoint: string): boolean {
  if (!pathname.startsWith(`${endpoint}/`)) return false;
  let paths: string[];
  try {
    paths = decodeURIComponent(pathname.slice(endpoint.length + 1)).split(",");
  } catch {
    return false;
  }
  return paths.every((path) => isInferenceRpcProcedure(path));
}

/**
 * An unbatched `inferenceRpc.negotiate`. It may run without a credential:
 * with no claims it can only answer "not advertised" or a typed refusal,
 * never anything claims-dependent. So an owner that rolled the RPC back
 * answers a direct caller the way it answers a tunneled one, and the
 * caller keeps the existing path on both.
 */
function negotiateOnly(pathname: string, endpoint: string): boolean {
  return pathname === `${endpoint}/inferenceRpc.negotiate`;
}

type InferenceClaims = inferenceRpc.InferenceServiceClaimsV1;

function requestContext(
  opts: StartAgentOptions,
  claims: InferenceClaims | null,
): AgentRouterContext & InferenceRpcContext {
  // Assigned field by field so a renamed context field fails to compile.
  const context: AgentRouterContext & InferenceRpcContext = {};
  if (opts.fleetJournalPath !== undefined) context.fleetJournalPath = opts.fleetJournalPath;
  // #281 DF-08: the shared chat admission reaches the router's local chat
  // branches through both /trpc and the tunnel client's contextFor, since
  // both build their context here.
  if (opts.chatCompletionsAdmission !== undefined) {
    context.chatAdmission = opts.chatCompletionsAdmission;
  }
  if (opts.managedLaunchAdmission !== undefined) {
    context.managedLaunchAdmission = opts.managedLaunchAdmission;
  }
  if (claims !== null) context.inferenceClaims = claims;
  return context;
}

function handlePeerColdRequest(
  req: Request,
  pathname: string,
  serving: ServingAgentOptions["peerCold"],
  server: AgentFetchServer,
): Promise<Response> | Response | undefined {
  if (serving === undefined) return undefined;
  if (pathname.startsWith(PEER_COLD_ROUTE + "/")) {
    server.timeout?.(req, 360);
    return serving.handle(req);
  }
  return serving.isCredential(req) ? unauthorizedResponse() : undefined;
}

function createAgentFetchHandler(args: {
  opts: ServingAgentOptions;
  endpoint: string;
  tunnelServer: TunnelServer | null;
  gate: NoAuthGate;
  workerRpc: WorkerRpcServing | null;
}): AgentFetchHandler {
  const { opts, endpoint, tunnelServer, gate, workerRpc } = args;
  scheduleCaptureExpiry();
  return (req, server) => {
    const url = new URL(req.url);
    const clientAddress = typeof server.requestIP === "function" ? server.requestIP(req) : null;
    opts.onRequest?.(url);
    const peerCold = handlePeerColdRequest(req, url.pathname, opts.peerCold, server);
    if (peerCold !== undefined) return peerCold;
    const infra = handleInfraRoutes(req, url, server, opts, tunnelServer);
    if (infra) return infra;
    const api = handleAuthedApiRoutes(req, url, clientAddress, opts, gate, server);
    if (api) return api;
    if (!url.pathname.startsWith(endpoint)) {
      return new Response("not found", { status: 404 });
    }
    // A worker-RPC service credential stands in for the operator bearer
    // on the worker-RPC procedures alone, and carries its verified claims; the
    // operator bearer keeps its scope and carries none.
    const claims =
      workerRpc !== null && inferenceRpcOnly(url.pathname, endpoint)
        ? workerRpc.claimsFor(extractBearer(req))
        : null;
    if (claims === null && !negotiateOnly(url.pathname, endpoint)) {
      const denied = authGateReject(req, url.pathname, clientAddress, opts, gate);
      if (denied) return denied;
    }
    return fetchRequestHandler({
      req,
      endpoint,
      router: appRouter,
      createContext: () => requestContext(opts, claims),
    });
  };
}

/**
 * Counts the requests still executing inside the fetch handler. A route
 * miss is resolved only after the handler has awaited the request body,
 * so a request accepted before `stop()` can still be about to read the
 * declared-model source once the HTTP listener and the tunnel client are
 * gone — both the socket path and the synthetic `handleRequest` path
 * reach this handler. `stop()` waits for the count to drop before it
 * unregisters that source (DF-07); streams release at their head, since
 * the declared lookup happens before the upstream fetch. Only wired when a
 * declared source is registered: with none nothing reads it late, so the
 * default stop() keeps its pre-#610 timing.
 */
function trackServedRequests(handler: AgentFetchHandler): {
  handler: AgentFetchHandler;
  untilIdle: () => Promise<void>;
} {
  const idleWaiters: (() => void)[] = [];
  let active = 0;
  const release = (): void => {
    active -= 1;
    if (active === 0) {
      for (const settle of idleWaiters.splice(0)) settle();
    }
  };
  return {
    handler: (req: Request, server: AgentFetchServer): Response | Promise<Response> => {
      active += 1;
      try {
        const outcome = handler(req, server);
        if (outcome instanceof Promise) return outcome.finally(release);
        release();
        return outcome;
      } catch (error) {
        release();
        throw error;
      }
    },
    untilIdle: (): Promise<void> =>
      active === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idleWaiters.push(resolve);
          }),
  };
}

function startBunServer(args: {
  tls: StartAgentOptions["tls"];
  allowPlainHttp: boolean;
  port: number;
  bindHost: string;
  wsConfig: TunnelServer["websocket"] | null;
  fetchHandler: AgentFetchHandler;
  idleTimeoutSeconds?: number;
}): { server: Bun.Server<unknown>; fingerprint: string | null } {
  const { tls, allowPlainHttp, port, bindHost, wsConfig, fetchHandler } = args;
  // Composite applies (image pulls + pod readiness polling) routinely run
  // well past Bun.serve's default 10s idle timeout. 255 is Bun.serve's
  // hard ceiling; past that the caller polls compositeStatus
  // subscriptions instead of waiting on the apply mutation. Proxied
  // inference requests re-arm their own budget via server.timeout —
  // see proxiedRouteIdleSeconds.
  const idleTimeout = args.idleTimeoutSeconds ?? 255;
  let fingerprint: string | null = null;
  // Bun.serve's option type discriminates on whether `websocket` is
  // present, so we can't share a single literal with `websocket?:`
  // optional — the ws-and-no-ws branches construct separately.
  const server =
    tls && !allowPlainHttp
      ? ((): Bun.Server<unknown> => {
          const loaded = loadCert(tls);
          fingerprint = loaded.fingerprint;
          return wsConfig
            ? Bun.serve({
                port,
                hostname: bindHost,
                reusePort: true,
                fetch: fetchHandler,
                websocket: wsConfig,
                tls: { cert: loaded.certPem, key: loaded.keyPem },
                idleTimeout,
              })
            : Bun.serve({
                port,
                hostname: bindHost,
                reusePort: true,
                fetch: fetchHandler,
                tls: { cert: loaded.certPem, key: loaded.keyPem },
                idleTimeout,
              });
        })()
      : wsConfig
        ? Bun.serve({
            port,
            hostname: bindHost,
            reusePort: true,
            fetch: fetchHandler,
            websocket: wsConfig,
            idleTimeout,
          })
        : Bun.serve({
            port,
            hostname: bindHost,
            reusePort: true,
            fetch: fetchHandler,
            idleTimeout,
          });
  return { server, fingerprint };
}

function maybePublishAgentMdns(
  opts: StartAgentOptions,
  listenPort: number,
  fingerprint: string | null,
): PublishedAgent | null {
  // LLAMACTL_DISABLE_MDNS=1 forces mDNS off even when tls=true. Needed
  // when bonjour-service v1.3.0 hits a probe collision against a stale
  // cached announcement on the LAN and synchronously emits
  // `console.log(new Error("Service name is already in use"))` — Bun
  // turns that into an unrecoverable async error that wedges the
  // event loop, leaving the HTTP server listening on its TCP port but
  // never serving requests. The try-catch below only covers the
  // synchronous publish call; the dgram-side collision fires later and
  // bypasses it. Until bonjour-service is replaced, the env-var
  // escape hatch keeps long-lived launchd-managed agents stable.
  const mdnsDisabledByEnv =
    process.env["LLAMACTL_DISABLE_MDNS"] === "1" || process.env["LLAMACTL_DISABLE_MDNS"] === "true";
  const shouldAdvertise = !mdnsDisabledByEnv && (opts.advertiseMdns ?? Boolean(opts.tls));
  if (!shouldAdvertise) return null;
  try {
    return publishAgentMdns({
      port: listenPort,
      nodeName: opts.nodeName ?? process.env["LLAMACTL_NODE_NAME"] ?? "agent",
      fingerprint,
      version: opts.version ?? "0.0.0",
    });
  } catch {
    // mDNS is best-effort — platforms without a working multicast
    // interface shouldn't prevent the agent from starting.
    return null;
  }
}

// Reverse-tunnel dial-out — gated on opts.tunnelDial. The HTTP
// server is already up at this point; the tunnel client runs in
// the background and uses its own reconnect loop, so an unreachable
// central never blocks the local agent. Bridges inbound `req`
// frames from central — queries, mutations and subscriptions — into
// the same appRouter the /trpc endpoint serves. `onCreated` receives
// the client before start() runs, so a start that throws still leaves
// the startup rollback a handle to stop (#278 DF-05).
function maybeStartTunnelClient(
  opts: StartAgentOptions,
  workerRpc: WorkerRpcServing | null,
  onCreated: (tunnelClient: TunnelClient) => void,
): TunnelClient | null {
  if (!opts.tunnelDial) return null;
  // Central forwards a worker-RPC caller's single-use token on the req
  // frame, bound to this node's tunnel name and to the call; the claims
  // it verifies to ride that request's context only.
  const tokens = createServiceTokenVerifier({
    node: opts.tunnelDial.nodeName,
    // Why, and for which procedure; never the token.
    onRefused: (reason, method) => {
      process.stderr.write(`[worker-rpc] tunnel token refused (${reason}) for ${method}\n`);
    },
  });
  const contextFor = (req: TunnelReq): ReturnType<typeof requestContext> => {
    const params = req.params as { input?: unknown } | undefined;
    const claims =
      workerRpc !== null && isInferenceRpcProcedure(req.method)
        ? tokens.claimsFor(
            req.auth?.serviceToken,
            {
              method: req.method,
              input: params?.input,
              relayPrincipal: req.auth?.relayPrincipal ?? "",
            },
            workerRpc.bindings(),
          )
        : null;
    return requestContext(opts, claims);
  };
  const handleRequest = (req: TunnelReq): Promise<unknown> =>
    createTunnelRouterHandler(appRouter.createCaller(contextFor(req)))(req);
  const handleSubscription = createTunnelSubscriptionHandler(appRouter, contextFor);
  const tunnelClient = createTunnelClient({
    url: opts.tunnelDial.url,
    bearer: opts.tunnelDial.bearer,
    nodeName: opts.tunnelDial.nodeName,
    handleRequest,
    handleSubscription,
    ...(opts.tunnelDial.onStateChange !== undefined
      ? { onStateChange: opts.tunnelDial.onStateChange }
      : {}),
    // Background mode by default: the HTTP server must come up
    // regardless of central's reachability. The reconnect loop
    // handles transient failures on its own schedule.
    initialAttemptTimeoutMs: opts.tunnelDial.initialAttemptTimeoutMs ?? 0,
    ...(opts.tunnelDial.WebSocketCtor !== undefined
      ? { WebSocketCtor: opts.tunnelDial.WebSocketCtor }
      : {}),
  });
  onCreated(tunnelClient);
  // Fire-and-forget; state transitions are observable via
  // opts.tunnelDial.onStateChange.
  void tunnelClient.start();
  return tunnelClient;
}

// Async best-effort subsystems (mDNS Bonjour probes, the tunnel
// client's reconnect loop, telemetry flushers) can throw
// unhandled rejections + uncaughtExceptions hours after startup.
// In a TTY those land as stderr noise; under launchd the default
// handler kills the process even though the HTTP server is fine.
// Make the agent resilient: log + continue. Once installed, this
// covers ANY future async-leak the agent picks up — not just mDNS.
const captureFatal =
  (kind: string) =>
  (err: unknown): void => {
    process.stderr.write(
      `${kind}: ${err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)}\n`,
    );
  };

function warnNoAuthEnabled(allowPlainHttp: boolean): void {
  const transport = allowPlainHttp ? "Serving plain HTTP (no TLS)." : "Serving HTTPS.";
  process.stderr.write(
    `[agent] WARNING: --no-auth flag enabled. Bearer token validation BYPASSED for /v1/* connections from 127.0.0.1. All other routes (including /trpc) still require bearer auth. ${transport}\n`,
  );
}

function maybeStartPeerSnapshotPoller(opts: StartAgentOptions): (() => void) | null {
  if (!opts.peerSnapshotPoll) return null;
  return startPeerSnapshotPoller({
    ...(opts.peerSnapshotPollIntervalMs ? { intervalMs: opts.peerSnapshotPollIntervalMs } : {}),
    // The unified dispatch path's shadow catalog reads the same
    // snapshot map the legacy route map gets — publish to both so a
    // flag flip never changes which peer routes are visible.
    publish: (snapshots) => {
      openaiProxy.setPeerSnapshots(snapshots);
      publishUnifiedPeerSnapshots(snapshots);
    },
  });
}

function maybeRegisterDeclaredModels(opts: StartAgentOptions): (() => void) | null {
  if (!opts.declaredModels) return null;
  // Project with LOCAL_NODE_ID, not the agent's nodeName: agent-local
  // manifests carry spec.node 'local' (router.ts:144, reconciler.ts:480),
  // while nodeName defaults to LLAMACTL_NODE_NAME or 'agent'. No `dir`:
  // defaultWorkloadsDir() re-reads env on every call. The source itself is
  // uncached (in-place manifest edits do not bump the dir mtime); the proxy's
  // routed-path stale check caches its projection on the route-map runtime
  // signature plus declaredManifestSignature (per-file mtime/size and lease
  // phase), so a routed request spawns no `ps` and parses no manifest while
  // nothing changes. The live set is keyed by the
  // route's model, never its workload name: a live llama-server marks the
  // claim for that model ready, and a name-keyed set would mark nothing. The
  // warming set is read fresh from the proxy's chat-routing gate (#280 DF-07)
  // so a live id whose route fails readiness projects 'loading', not 'ready'.
  // The withdrawn set is read fresh from the same gate so a workload whose
  // routes are pulled for the duration of a stop (#280 DF-07) projects
  // 'draining', not 'ready'.
  const workloadPhase = (workload: string): DeclaredWorkloadPhase | undefined =>
    getResidencyLeaseRegistry()?.snapshot(workload).phase;
  openaiProxy.setDeclaredModelSource(
    () => {
      const routes = listLocalRoutes(resolveEnv());
      return listDeclaredModels({
        nodeName: LOCAL_NODE_ID,
        liveModelIds: new Set(routes.map((route) => route.model)),
        liveRoutes: routes.map((route) => ({
          workload: route.workload,
          model: route.model,
        })),
        workloadPhase,
        warmingModelIds: openaiProxy.servingWarmingModelIds(),
        withdrawnWorkloads: openaiProxy.servingWithdrawnWorkloads(),
      });
    },
    { signature: () => declaredManifestSignature({ workloadPhase }) },
  );
  return (): void => {
    openaiProxy.setDeclaredModelSource(null);
  };
}

interface WorkerRpcServing {
  /** The service-credential bindings current now. */
  bindings(): readonly ServiceCredentialBinding[];
  /** The claims a service credential carries under the bindings current now. */
  claimsFor(token: string | null | undefined): InferenceClaims | null;
  /** Drains active attempts and cancels what outlives the window. */
  drain(): Promise<void>;
  /** Stops serving the host; called once the HTTP server has stopped,
   * and also during startup-failure rollback. */
  unpublish(): void;
}

// Rollback helpers started during startup: best-effort, each step
// individually try/catch'd so one failure cannot mask the original
// error or skip the others.
function rollbackStartupResources(
  started: {
    server?: { stop(closeActive?: boolean): unknown };
    unregisterDeclaredModels?: (() => void) | null;
    mdns?: ReturnType<typeof maybePublishAgentMdns>;
    tunnelClient?: ReturnType<typeof maybeStartTunnelClient>;
  },
  workerRpc: WorkerRpcServing | null,
  leases: ReturnType<typeof maybePublishResidencyLeases> | null,
  engineScope: ReturnType<typeof maybePublishEngineScope> | null,
): void {
  try {
    started.tunnelClient?.stop();
  } catch {
    /* ignore */
  }
  try {
    if (started.mdns) void started.mdns.stop().catch(() => undefined);
  } catch {
    /* ignore */
  }
  try {
    void started.server?.stop(true);
  } catch {
    /* ignore */
  }
  try {
    started.unregisterDeclaredModels?.();
  } catch {
    /* ignore */
  }
  try {
    workerRpc?.unpublish();
  } catch {
    /* ignore */
  }
  try {
    leases?.restore();
  } catch {
    /* ignore */
  }
  try {
    engineScope?.restore();
  } catch {
    /* ignore */
  }
}

// stop() body extracted to reduce cognitive complexity: drain worker-RPC,
// remove process handlers, stop this agent's own search ingest (#634), stop
// the HTTP server, flush served requests, restore the residency seam, and
// unregister declared-models.
async function stopAgentServerResources(
  workerRpc: WorkerRpcServing | null,
  onUncaughtException: (err: Error) => void,
  onUnhandledRejection: (err: Error) => void,
  stopPeerSnapshotPoller: (() => void) | null,
  server: { stop(closeActive?: boolean): unknown },
  tunnelClient: ReturnType<typeof maybeStartTunnelClient>,
  servedRequests: ReturnType<typeof trackServedRequests> | null,
  mdns: ReturnType<typeof maybePublishAgentMdns>,
  leases: ReturnType<typeof maybePublishResidencyLeases> | null,
  engineScope: ReturnType<typeof maybePublishEngineScope> | null,
  unregisterDeclaredModels: (() => void) | null,
  stopIngest: SearchIngestStop,
  admissionsIdle?: () => Promise<void>,
): Promise<void> {
  // Worker-RPC attempts drain first, while their transports are up.
  await workerRpc?.drain();
  // Remove exactly the process handlers this call installed so
  // repeated start/stop cycles don't accumulate listeners.
  process.off("uncaughtException", onUncaughtException);
  process.off("unhandledRejection", onUnhandledRejection);
  // Scoped to this agent's own ingest, so stopping one agent leaves another's
  // search ingest running (#634).
  stopIngest();
  stopPeerSnapshotPoller?.();
  try {
    // A drained or cancelled worker-RPC stream has handed its terminal
    // to its response; let in-flight responses finish before closing.
    // Tunneled calls never pass through the HTTP server, so the tunnel
    // stays up until it is idle too, in the same window. The host stays
    // published until then, so a status or cancel still in flight, over
    // either transport, is answered by the attempts it names.
    if (workerRpc !== null) {
      await within(
        TERMINAL_FLUSH_MS,
        Promise.all([server.stop(), tunnelClient?.whenIdle()]).then(() => undefined),
      );
    }
  } finally {
    // Best-effort — never let a tunnel-client teardown error
    // prevent the HTTP server from also stopping.
    if (tunnelClient) {
      try {
        tunnelClient.stop();
      } catch {
        /* ignore */
      }
    }
    void server.stop(true);
    workerRpc?.unpublish();
    // Guarded at the call site: awaiting even an empty async function
    // costs a microtask, and the default stop() (no opt-in, no mDNS) must
    // keep its pre-#610 timing. Bonjour's stop is bounded inside it: a
    // hung one must not keep the tunnel serving or hold stop() open.
    if (servedRequests !== null || mdns) await finalFlushWindow(servedRequests, mdns);
    // A canceled cold request or a timed-out idle switch can return while a
    // managed actuator is still settling against this owner.
    if (admissionsIdle !== undefined) await admissionsIdle();
    // After the worker-RPC drain, server.stop() and the final flush of
    // served requests, so in-flight bodies (which may hold leases) settle
    // against the published registry before the seam reverts (#278 DF-05).
    leases?.restore();
    // Same seam discipline for the engine-scope launcher (#806 phase 3):
    // restore only after every in-flight engine launch has settled.
    engineScope?.restore();
    // Unregister the declared-model source only once the HTTP server, the
    // tunnel client and every request that could still read it are done:
    // while any of them is up, a cold pin must still get its declared
    // 503 instead of the default-target fallthrough (DF-07).
    unregisterDeclaredModels?.();
  }
}

// Inside launchd's default 20 s ExitTimeOut, so a SIGTERM'd agent still
// cancels what outlives the drain instead of being killed mid-stream.
const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;
/** How long streams get to deliver their terminal, after a cancel and again on the wire. */
export const TERMINAL_FLUSH_MS = 1_000;

function within(ms: number, work: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  return Promise.race([work.then(() => true), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Each owner's share of the active attempts when agent.yaml sets none.
 * Undefined, the host's whole cap: with one owner bound to submit there
 * is nobody to keep slots for. Two bindings of one owner, as in a
 * rotation, are still one owner. A binding that cannot submit, such as a
 * status or catalog monitor, never holds a slot, so counting it would
 * only cut the submitters' share.
 */
function defaultActiveShare(bindings: readonly ServiceCredentialBinding[]): number | undefined {
  const owners = new Set(
    bindings
      .filter((b) => b.operations.includes("submit"))
      .map((b) => JSON.stringify([b.serviceId, b.credentialScopeId])),
  );
  return owners.size > 1 ? DEFAULT_SHARED_MAX_ACTIVE_PER_OWNER : undefined;
}

/**
 * Prepares the residency lease registry (DF-05, #278) for explicit leases
 * or owner execution groups. The default path leaves the process-wide seam
 * and the on-disk audit alone.
 * Otherwise it captures the seam's previous value, wires the registry's
 * onAudit sink to the node-local residency store (the forced-unload audit
 * survives a restart; the sink opens lazily on the first write and its close
 * runs on both the stop and rollback paths), and builds a fresh registry — but
 * does NOT install it: `publish` installs the registry and `restore` puts the
 * captured previous value back. The caller publishes only once the listener is
 * up (next to maybeRegisterDeclaredModels), so a failed bind (a missing cert, a
 * port in use) never leaves an orphan registry in the seam for a later start to
 * capture as its previous value.
 */
function maybePublishResidencyLeases(
  opts: StartAgentOptions,
): { registry: ResidencyLeases; publish: () => void; restore: () => void } | null {
  if (opts.residencyLeases !== true && !opts.executionAdmission?.length) return null;
  const previous = getResidencyLeaseRegistry();
  const previousSession = currentSessionRefcounts();
  const auditSink = createResidencyLeaseAuditSink({
    path: defaultResidencyStorePath(),
    requireExisting: hasManagedRuntimeMarker(resolveEnv().LOCAL_AI_RUNTIME_DIR),
  });
  const registry = createResidencyLeases({ onAudit: auditSink.onAudit });
  let sessionRefcounts: SessionRefcounts | null = null;
  if (opts.residencySessionIdleMs !== undefined) {
    sessionRefcounts = createSessionRefcounts({
      idleTimeoutMs: opts.residencySessionIdleMs,
    });
  }
  const publish = (): void => {
    setResidencyLeaseRegistry(registry);
    if (sessionRefcounts !== null) {
      setSessionRefcountRegistry(sessionRefcounts);
    }
  };
  const restore = (): void => {
    setResidencyLeaseRegistry(previous);
    if (sessionRefcounts !== null) {
      setSessionRefcountRegistry(previousSession);
    }
    auditSink.close();
  };
  return { registry, publish, restore };
}

/**
 * Prepares the opt-in engine-scope launcher (#806 phase 3). Returns null
 * unless `opts.engineScope` is true AND the platform is linux, so macOS
 * agents, tests and in-process applies never install a launcher and every
 * launch stays a byte-identical direct spawn. Like the residency seam,
 * `publish` installs the launcher only once the listener is up and `restore`
 * puts the previous value back on stop/rollback.
 */
export function maybePublishEngineScope(
  opts: Pick<StartAgentOptions, "engineScope">,
  platform: NodeJS.Platform = process.platform,
): { publish: () => void; restore: () => void } | null {
  if (opts.engineScope !== true || platform !== "linux") return null;
  // Captured at creation AND re-captured at publish: a rollback that runs
  // before publish must restore the pre-handle value, not a hard null that
  // would wipe a launcher another in-process agent already installed.
  let previous: EngineScopeLauncher | null = getEngineScopeLauncher();
  return {
    publish: (): void => {
      previous = getEngineScopeLauncher();
      setEngineScopeLauncher(createEngineScopeLauncher());
    },
    restore: (): void => {
      setEngineScopeLauncher(previous);
    },
  };
}

function prepareExecutionHooks(opts: StartAgentOptions): {
  hooks: ReturnType<typeof maybePublishEngineScope>;
  owner?: OwnerAdmission;
  activity?: OwnerActivity;
} {
  const scope = maybePublishEngineScope(opts);
  if (!opts.executionAdmission?.length && opts.managedInferenceHolds === undefined) {
    return { hooks: scope };
  }
  const activity = opts.managedOwnerActivity === undefined ? undefined : createOwnerActivity();
  const allowsProfileServing =
    activity === undefined ? undefined : opts.managedLaunchAdmission?.allowsProfileServing;
  const allowsManagedServing = opts.managedLaunchAdmission?.allowsManagedServing;
  const owner = createOwnerAdmission(opts.executionAdmission ?? [], {
    observeWait: (group, sample): void => {
      observeAdmissionWait("execution", group, sample);
    },
    ...(allowsManagedServing === undefined ? {} : { allowsManagedServing }),
    ...(activity === undefined ? {} : { activity }),
    ...(allowsProfileServing === undefined ? {} : { allowsProfileServing }),
    ...(opts.selectManagedEngineTransport === undefined
      ? {}
      : { selectEngineTransport: opts.selectManagedEngineTransport }),
    noAuth: opts.noAuth === true && isLoopbackAddress(opts.bindHost ?? "127.0.0.1"),
    ...(opts.managedInferenceHolds === undefined
      ? {}
      : { inferenceHolds: opts.managedInferenceHolds }),
  });
  let uninstall: (() => void) | undefined;
  return {
    owner,
    ...(activity === undefined ? {} : { activity }),
    hooks: {
      publish: (): void => {
        scope?.publish();
        uninstall = installLocalEngineForwarder(owner.forward, opts.selectManagedEngineReadiness);
        setOwnerAdmissionMetricsReader(owner.snapshot);
      },
      restore: (): void => {
        if (uninstall !== undefined) {
          owner.stop();
          uninstall();
          uninstall = undefined;
          setOwnerAdmissionMetricsReader(null);
        }
        scope?.restore();
      },
    },
  };
}

/**
 * Publishes this agent's worker-RPC host (P4.1). It advertises the
 * versions agent.yaml lists that this build speaks, read on every call,
 * so emptying the list stops the advertisement for new requests while
 * accepted attempts run on. Each owner's share of the active attempts is
 * read on every submit too, so it can be changed without a restart, which
 * would drain and then cancel every attempt in flight.
 */
function maybePublishWorkerRpc(
  opts: StartAgentOptions,
  leases: ResidencyLeases | null,
  ownerAdmission?: OwnerAdmission,
): WorkerRpcServing | null {
  const config = opts.workerRpc;
  if (config === undefined) return null;
  const spoken = inferenceRpc.inferenceRpcVersionsSpokenAt(inferenceRpc.INFERENCE_RPC_VERSION);
  const host = createWorkerRpcHost({
    workerId: config.workerId,
    ...(config.backends !== undefined ? { backends: config.backends } : {}),
    ...(leases !== null ? { residencyLeases: leases } : {}),
    ...(ownerAdmission !== undefined ? { ownerAdmission } : {}),
    ...(opts.chatCompletionsAdmission !== undefined
      ? { admission: opts.chatCompletionsAdmission }
      : {}),
    versions: () =>
      (config.settings()?.versions ?? []).filter((v) =>
        spoken.some((s) => inferenceRpc.compareInferenceRpcVersions(s, v) === 0),
      ),
    maxActiveAttemptsPerOwner: () => {
      const settings = config.settings();
      return (
        settings?.maxActiveAttemptsPerOwner ??
        defaultActiveShare(settings?.serviceCredentials ?? [])
      );
    },
  });
  const restore = publishWorkerRpcHost(host);
  const peerColdHashes = new Set(opts.managedPeerColdCredentials?.map((entry) => entry.tokenHash));
  const bindings = (): readonly ServiceCredentialBinding[] =>
    (config.settings()?.serviceCredentials ?? []).filter(
      (entry) => !peerColdHashes.has(entry.tokenHash),
    );
  return {
    bindings,
    claimsFor: (token) => claimsForServiceCredential(token, bindings()),
    drain: async (): Promise<void> => {
      const drainMs = config.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
      if (!(await within(drainMs, host.drain()))) {
        // Cancelled attempts end with a typed terminal on their stream.
        host.close();
        await within(TERMINAL_FLUSH_MS, host.drain());
      }
    },
    unpublish: restore,
  };
}

function maybeCreateTunnelServer(opts: StartAgentOptions): TunnelServer | null {
  if (!opts.tunnelCentral) return null;
  return createTunnelServer({
    expectedBearerHash: opts.tunnelCentral.expectedBearerHash,
    ...(opts.tunnelCentral.onNodeConnect !== undefined
      ? { onNodeConnect: opts.tunnelCentral.onNodeConnect }
      : {}),
    ...(opts.tunnelCentral.onNodeDisconnect !== undefined
      ? { onNodeDisconnect: opts.tunnelCentral.onNodeDisconnect }
      : {}),
    // journal.ts resolves undefined → the default path; we just
    // pass through so callers can force a tempfile in tests.
    ...(opts.tunnelJournalPath !== undefined ? { journalPath: opts.tunnelJournalPath } : {}),
  });
}

/**
 * Last, and bounded: bonjour's stop has no timeout, and a hung one must
 * not keep the tunnel serving or hold stop() open. The waits here run
 * concurrently, so stop() stays inside the drain timeout plus three flush
 * windows: the drain's, the shared one in stop and this one. The in-flight
 * wait only joins this window when a declared source is registered; without
 * the opt-in stop() never waits on a client request at all. With neither
 * opt-in nor mDNS there is nothing to flush, and the caller skips this
 * function entirely, so the default stop() keeps its pre-#610 timing.
 */
async function finalFlushWindow(
  servedRequests: { untilIdle: () => Promise<void> } | null,
  mdns: PublishedAgent | null,
): Promise<void> {
  const finalFlush: Promise<boolean>[] = [];
  if (servedRequests !== null) {
    // Requests already inside the handler when the listener went away
    // answer their route miss later, from the declared source, so this
    // window is what makes the source outlive them (DF-07).
    finalFlush.push(within(TERMINAL_FLUSH_MS, servedRequests.untilIdle()));
  }
  if (mdns) {
    finalFlush.push(
      within(
        TERMINAL_FLUSH_MS,
        mdns.stop().catch(() => undefined),
      ),
    );
  }
  if (finalFlush.length > 0) {
    await Promise.all(finalFlush);
  }
}

function verifyManagedEngineTransportAdmission(opts: StartAgentOptions): void {
  if (
    opts.selectManagedEngineReadiness !== undefined &&
    opts.selectManagedEngineTransport === undefined
  ) {
    throw new Error("ManagedEngineTransportAdmissionRequired");
  }
  if (
    opts.selectManagedEngineTransport !== undefined &&
    (opts.noAuth === true || !opts.executionAdmission?.length)
  ) {
    throw new Error("ManagedEngineTransportAdmissionRequired");
  }
}

/**
 * Seeds the per-token last-used gauge from the persisted store (#218) so a
 * restarted agent reports when a token was last seen rather than nothing.
 * A label whose time does not parse is skipped, and a store that cannot be
 * read leaves the gauges empty: last use never blocks boot.
 */
function seedBearerLastUsedGauges(opts: StartAgentOptions): void {
  try {
    for (const [label, at] of Object.entries(opts.bearerLastUsed?.snapshot() ?? {})) {
      const ms = Date.parse(at);
      if (!Number.isFinite(ms)) continue;
      agentBearerLastUsedSeconds.set({ token: label }, ms / 1000);
    }
  } catch {
    process.stderr.write("[agent] bearer last-use seed failed; gauges start empty\n");
  }
}

/**
 * Starts a Bun HTTP(S) server that exposes the llamactl tRPC router
 * behind bearer-token auth. The fetchRequestHandler is the same surface
 * the Electron main process mounts via electron-trpc — one router,
 * three mounts.
 */
export function startAgentServer(opts: StartAgentOptions): RunningAgent {
  verifyManagedEngineTransportAdmission(opts);
  if (opts.managedOwnerActivity !== undefined && opts.workerRpc !== undefined)
    throw new Error("ManagedOwnerActivityIngressUnsupported");
  if (
    hasManagedRuntimeMarker(resolveEnv().LOCAL_AI_RUNTIME_DIR) &&
    (opts.managedLaunchAdmission?.runOwnedLifecycle === undefined ||
      opts.residencyLeases !== true ||
      opts.noAuth === true)
  ) {
    throw new Error("ManagedOwnerRequired");
  }
  if (opts.executionAdmission?.length && opts.chatCompletionsAdmission !== undefined) {
    throw new Error("executionAdmission requires the agent-wide chat admission cap to be disabled");
  }
  const bindHost = opts.bindHost ?? "127.0.0.1";
  const port = opts.port ?? 0;
  const endpoint = opts.endpoint ?? "/trpc";
  const noAuth = opts.noAuth === true;
  const allowPlainHttp = noAuth && isLoopbackAddress(bindHost);

  // Capture the handler references so stop() can remove exactly the
  // pair this call installed. Anonymous re-registration on every
  // startAgentServer would otherwise leak two process listeners per
  // call across restart/test cycles (MaxListeners warning + each
  // still-installed handler firing once per fatal).
  const onUncaughtException = captureFatal("uncaughtException");
  const onUnhandledRejection = captureFatal("unhandledRejection");
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

  // From here on a throw at ANY step must also undo the early steps: the
  // process handlers above, the search ingest and the peer-snapshot poller.
  // The post-bind resources are rolled back by the inner catch first.
  const early: EarlyStartup = { stopSearchIngest: null, stopPeerSnapshotPoller: null };
  try {
    seedBearerLastUsedGauges(opts);
    runStartupMigration();
    // #279 DF-06 boot recovery. Runs synchronously here, before
    // startAgentServerAfterHandlers, so it completes before startAgentServer
    // returns and no request can arrive first. It is inert unless leftover
    // profile-switch rows exist, or lifecycle rows are interrupted outside a
    // switch, have made no progress for the staleness window and have a
    // proven-down workload with no nonterminal operation row present (a
    // read-only probe first, so no file is created), never blocks long (250ms
    // busy timeout) and never crashes boot. It only terminalizes rows older
    // than its staleness window, and claims the fence under the apply-profile
    // owner identity, so the #284 residencyApplyProfile mutation (#703), which
    // runs executeProfileSwitch, is never left Busy by it. This is recovery,
    // not activation: there is no opt-in flag.
    const recovery = runProfileSwitchBootRecovery({
      path: defaultResidencyStorePath(),
      incarnation: `agent-boot:${String(process.pid)}:${crypto.randomUUID()}`,
      isProvenDown: directWorkloadProvenDown,
      ...(opts.managedLaunchAdmission?.runOwnedLifecycle === undefined
        ? {}
        : {
            openStore: (path: string): ReturnType<typeof openResidencyOperationStore> =>
              openResidencyOperationStore({ path, requireExisting: true }),
          }),
    });
    if (
      opts.managedLaunchAdmission?.runOwnedLifecycle !== undefined &&
      (recovery.status === "failed" || recovery.status === "absent" || recovery.recordFailures > 0)
    ) {
      throw new Error("ManagedTransitionRecoveryFailed");
    }
    if (noAuth) {
      warnNoAuthEnabled(allowPlainHttp);
    }
    return startAgentServerAfterHandlers(
      opts,
      { bindHost, port, endpoint, noAuth, allowPlainHttp },
      { onUncaughtException, onUnhandledRejection },
      early,
    );
  } catch (err) {
    rollbackEarlyStartupSteps(early, onUncaughtException, onUnhandledRejection);
    throw err;
  }
}

// The startup steps that run before any listener is bound. Recorded as
// they happen so a failed start undoes exactly what THIS call started:
// the search-ingest stop is the handle this call's startSearchIngest()
// returned, scoped to the ingests it started, so a failed start never
// stops the ingest another in-process agent owns (#634).
interface EarlyStartup {
  stopSearchIngest: SearchIngestStop | null;
  stopPeerSnapshotPoller: (() => void) | null;
}

// Best-effort, each step individually try/catch'd so one failure cannot
// mask the original error or skip the others.
function rollbackEarlyStartupSteps(
  early: EarlyStartup,
  onUncaughtException: (err: Error) => void,
  onUnhandledRejection: (err: Error) => void,
): void {
  try {
    early.stopPeerSnapshotPoller?.();
  } catch {
    /* ignore */
  }
  try {
    early.stopSearchIngest?.();
  } catch {
    /* ignore */
  }
  process.off("uncaughtException", onUncaughtException);
  process.off("unhandledRejection", onUnhandledRejection);
}

// Wire runtime role + memory budget into the metrics identity.
function applyAgentRuntimeIdentity(opts: StartAgentOptions): void {
  if (opts.runtimeRole === undefined && opts.runtimeMemoryBudgetBytes === undefined) return;
  setAgentRuntimeIdentity({
    role: opts.runtimeRole ?? "agent",
    ...(opts.runtimeMemoryBudgetBytes !== undefined
      ? { memoryBudgetBytes: opts.runtimeMemoryBudgetBytes }
      : {}),
  });
  setRuntimeProcessMemoryReader(opts.processMemoryReader ?? defaultProcessMemoryReader());
}

function prepareServingColdOwner(
  opts: StartAgentOptions,
  warm: OwnerAdmission | undefined,
): ReturnType<typeof prepareColdOwnerMount> {
  if (opts.managedColdOwnerFactory === undefined) return undefined;
  return prepareColdOwnerMount({
    factory: opts.managedColdOwnerFactory,
    managed: opts.managedLaunchAdmission,
    warm,
    executionAdmission: opts.executionAdmission,
    managedRuntime: hasManagedRuntimeMarker(resolveEnv().LOCAL_AI_RUNTIME_DIR),
    tls: opts.tls !== undefined,
    noAuth: opts.noAuth === true,
    declaredModels: opts.declaredModels === true,
    residencyLeases: opts.residencyLeases === true,
    observeWait: (sample): void => {
      observeAdmissionWait("activation", "", sample);
    },
  });
}

function ownerAdmissionPause(
  opts: StartAgentOptions,
  nodeName: string,
  execution: ReturnType<typeof prepareExecutionHooks>,
  cold: ReturnType<typeof prepareServingColdOwner>,
  leases: ResidencyLeases | undefined,
): {
  methods: Pick<RunningAgent, "tryQuiesceOwnerAdmissions" | "tryApplyIdleProfile">;
  whenIdle: (() => Promise<void>) | undefined;
} {
  const { owner, activity } = execution;
  const managed = opts.managedLaunchAdmission;
  const proof = opts.managedOwnerActivity;
  const holds = opts.managedInferenceHolds;
  if (
    owner === undefined ||
    activity === undefined ||
    cold === undefined ||
    leases === undefined ||
    proof === undefined ||
    managed?.ownerNodeId !== nodeName ||
    managed.allowsProfileServing === undefined ||
    managed.ownsNode?.(nodeName) !== true
  )
    return { methods: {}, whenIdle: cold?.whenIdle };

  const verifyIngress = (): boolean =>
    getLocalEngineForwarder() === owner.forward &&
    getResidencyLeaseRegistry() === leases &&
    proof.verifyExclusiveIngress() === true &&
    owner.isQuiescent() &&
    cold.isQuiescent() &&
    holds?.allClear?.() === true;
  // A holder may start its own durable transition after acquiring the pause.
  const proveInitialIdle = (): boolean => {
    const status = managed.readStatus?.();
    return (
      leases.isQuiescent?.() === true &&
      status?.ledger === "available" &&
      status.ownerNodeId === nodeName &&
      (status.profile.kind === "selected" || status.profile.kind === "unselected") &&
      status.claims.every((claim) => claim.state === "resident")
    );
  };
  const tryPause = (): OwnerAdmissionPause | undefined =>
    activity.tryPause(verifyIngress, proveInitialIdle);
  const pending = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>): Promise<T> => {
    pending.add(task);
    const settled = (): void => {
      pending.delete(task);
    };
    void task.then(settled, settled);
    return task;
  };
  const trackSettlement = (task: Promise<void>): void => {
    void track(task);
  };
  return {
    methods: {
      tryQuiesceOwnerAdmissions: tryPause,
      tryApplyIdleProfile: (window) =>
        track(runIdleProfileMutation(nodeName, window, managed, tryPause, trackSettlement)),
    },
    async whenIdle(): Promise<void> {
      await cold.whenIdle();
      while (pending.size > 0) await Promise.allSettled(pending);
    },
  };
}

function coldServingOptions(
  opts: StartAgentOptions,
  nodeName: string,
  cold: ReturnType<typeof prepareServingColdOwner>,
): ServingAgentOptions {
  const gateway = opts.managedPeerColdGateway;
  if (gateway !== undefined && (opts.noAuth === true || opts.tls === undefined)) {
    throw new Error("ManagedPeerColdGatewayAuthenticationRequired");
  }
  return {
    ...opts,
    trustedColdOwner: cold?.forward,
    peerCold: preparePeerColdHandler(opts, nodeName, cold),
    peerColdGateway:
      gateway === undefined
        ? undefined
        : createSharedUnifiedProxy({
            ...gateway,
            peers: gateway.peers.filter((peer) => peer.id !== nodeName),
            env: { ...process.env, LLAMACTL_UNIFIED_PROXY: "1" },
          }),
  };
}

function startAgentServerAfterHandlers(
  opts: StartAgentOptions,
  bind: {
    bindHost: string;
    port: number;
    endpoint: string;
    noAuth: boolean;
    allowPlainHttp: boolean;
  },
  handlers: {
    onUncaughtException: (err: Error) => void;
    onUnhandledRejection: (err: Error) => void;
  },
  early: EarlyStartup,
): RunningAgent {
  const { bindHost, port, endpoint, noAuth, allowPlainHttp } = bind;
  const { onUncaughtException, onUnhandledRejection } = handlers;

  // Ingest stop is scoped to the agent that started it (#634): a synchronous
  // throw from a partial start is already undone inside startSearchIngest,
  // so the handle is recorded only once the start fully succeeded.
  const stopOwnIngest = startSearchIngest();
  early.stopSearchIngest = stopOwnIngest;
  const stopPeerSnapshotPoller = maybeStartPeerSnapshotPoller(opts);
  early.stopPeerSnapshotPoller = stopPeerSnapshotPoller;
  const nodeName = opts.nodeName ?? process.env["LLAMACTL_NODE_NAME"] ?? "agent";
  agentInfo.set(
    {
      node_name: nodeName,
      version: opts.version ?? "0.0.0",
    },
    1,
  );
  setModelHostMetricsNode(nodeName);

  const tunnelServer: TunnelServer | null = maybeCreateTunnelServer(opts);

  const gate = makeNoAuthGate(noAuth, bindHost);

  const leases = maybePublishResidencyLeases(opts);
  const execution = prepareExecutionHooks(opts);
  const cold = prepareServingColdOwner(opts, execution.owner);
  const workerRpc = maybePublishWorkerRpc(opts, leases?.registry ?? null, execution.owner);

  const started: {
    server?: { stop(closeActive?: boolean): unknown };
    unregisterDeclaredModels?: (() => void) | null;
    mdns?: ReturnType<typeof maybePublishAgentMdns>;
    tunnelClient?: ReturnType<typeof maybeStartTunnelClient>;
  } = {};
  try {
    applyAgentRuntimeIdentity(opts);

    const baseFetchHandler = createAgentFetchHandler({
      opts: coldServingOptions(opts, nodeName, cold),
      endpoint,
      tunnelServer,
      gate,
      workerRpc,
    });
    const servedRequests =
      opts.declaredModels === true ? trackServedRequests(baseFetchHandler) : null;
    const fetchHandler = servedRequests?.handler ?? baseFetchHandler;

    const { server, fingerprint } = startBunServer({
      tls: opts.tls,
      allowPlainHttp,
      port,
      bindHost,
      wsConfig: tunnelServer?.websocket ?? null,
      fetchHandler,
      ...(opts.idleTimeoutSeconds !== undefined
        ? { idleTimeoutSeconds: opts.idleTimeoutSeconds }
        : {}),
    });
    started.server = server;
    // Published only once the listener is actually up, beside the declared
    // source: a failed bind (a missing cert, a port in use) must not leave an
    // orphan registry in the process-wide seam for a later start to capture as
    // its previous value (DF-05 review). The Worker RPC host already holds the
    // registry instance directly, so deferring the seam write does not desync
    // drain from admission. Binding is synchronous and this call is the next
    // statement, so no request can observe the gap. A throw anywhere after
    // the Worker RPC host is published now unpublishes it, restores the seam
    // and stops the bound server (#278 DF-05).
    leases?.publish();
    execution.hooks?.publish();
    const unregisterDeclaredModels = maybeRegisterDeclaredModels(opts);
    started.unregisterDeclaredModels = unregisterDeclaredModels;

    const scheme = opts.tls && !allowPlainHttp ? "https" : "http";
    const listenPort = server.port ?? port;

    const mdns = maybePublishAgentMdns(opts, listenPort, fingerprint);
    started.mdns = mdns;

    const tunnelClient = maybeStartTunnelClient(opts, workerRpc, (client) => {
      started.tunnelClient = client;
    });

    const idleProfile = ownerAdmissionPause(opts, nodeName, execution, cold, leases?.registry);
    return {
      url: `${scheme}://${bindHost}:${String(listenPort)}`,
      port: listenPort,
      fingerprint,
      ...idleProfile.methods,
      handleRequest: async (
        req: Request,
        address: ClientAddress | null = null,
      ): Promise<Response> => {
        return await fetchHandler(req, {
          requestIP: () => address,
          // Tunneled requests are synthetic — no socket to upgrade.
          upgrade: () => false,
        });
      },
      stop: async (): Promise<void> => {
        execution.activity?.stop();
        cold?.stop();
        await stopAgentServerResources(
          workerRpc,
          onUncaughtException,
          onUnhandledRejection,
          stopPeerSnapshotPoller,
          server,
          tunnelClient,
          servedRequests,
          mdns,
          leases,
          execution.hooks,
          unregisterDeclaredModels,
          stopOwnIngest,
          idleProfile.whenIdle,
        );
      },
      ...(tunnelServer ? { tunnelServer } : {}),
      ...(tunnelClient ? { tunnelClient } : {}),
    };
  } catch (err) {
    cold?.stop();
    // Synchronous, best-effort rollback: each step is individually try/catch'd
    // so one failure cannot mask the original error or skip the others. The
    // rethrow reaches startAgentServer's early-step rollback, which stops
    // this agent's own search ingest through its handle (#634).
    rollbackStartupResources(started, workerRpc, leases, execution.hooks);
    throw err;
  }
}
