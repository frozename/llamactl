import { env as envMod, sourceRevision } from "@llamactl/core";
import { omitUndefined } from "@llamactl/core/object";
import { callViaTunnelRelay, type TunnelRelayCallOptions } from "@llamactl/core/tunnel-relay";
import {
  appendFleetJournal,
  bumpLeaseTerm,
  type CompletionProbeConfig,
  createMigrationController,
  createPeerFetch,
  DEFAULT_PRESSURE_THRESHOLDS,
  defaultFleetJournalPath,
  defaultLeaseTermPath,
  electLeaseHolder,
  type FleetJournalEntry,
  type FleetSnapshotEntry,
  getLatestPerNode,
  isPressureHot,
  type MigrationController,
  type MigrationControllerDeps,
  type NodeSnapshot,
  openAggregatorDb,
  readAuditEntries,
  readRecentMovesFromJournal,
  readSupervisorStatus,
  redactEndpoint,
  runExecutor,
  type SnapshotRow,
  startSupervisorLoop,
  type SupervisorLoopOptions,
  type WorkloadTarget,
} from "@llamactl/fleet-supervisor";
import { listPeers, workloadStore } from "@llamactl/remote";
import { stringify as stringifyYaml } from "yaml";

import { getGlobals, getNodeClientByName } from "../dispatcher.js";
import { isRecord } from "../runtime-shape.js";
import { setWorkloadEnabled } from "./setEnabled.js";

const USAGE = `llamactl supervisor — fleet observability + severity-gated remediation

USAGE:

  llamactl supervisor serve [flags]
  llamactl supervisor tick  [flags]    (alias for --once)
  llamactl supervisor status [flags]   (show current pressure state)
  llamactl supervisor audit [flags]    (show recent MCP write-tool audit entries)

FLAGS:
  --interval=<s>              Seconds between ticks. Default 30.
  --once                      One tick then exit.
  --journal=<path>            Override journal path.
                              Default $DEV_STORAGE/fleet-supervisor/journal.jsonl
                              (falls back to ~/.llamactl/fleet-supervisor/journal.jsonl
                              when DEV_STORAGE is unset).
  --node=<name>               Node label. Consumed as a llamactl-global flag
                              (see 'llamactl --help'); supervisor reads it from
                              the dispatcher. Default 'local'.
  --headroom-mb=<n>           Pressure free_mb threshold. Default 512.
  --compressor-mb=<n>         Pressure compressor_mb threshold. Default 2048.
  --consecutive-ticks=<n>     Pressure consecutive-tick window. Default 3.
  --clear-ticks=<n>           Pressure clear-tick hysteresis window. Default 5.
  --p95-degraded-ms=<n>       Per-workload p95 degradation threshold. Default 5000.
  --consecutive-errors=<n>    Per-workload consecutive-errors threshold. Default 3.
  --consecutive-completion-errors=<n>
                              Completion-probe wedge failures (5xx/timeout
                              despite /health 200) before recycling. Default 2.
  --no-workloads              Skip workload probing (mem-only mode).
  --workload=<name@url>       Add a workload target (repeatable).
                              Format: name@url, e.g. mlx-qwen36-35b@http://127.0.0.1:8096
  --kind=ModelHost|ModelRun   Kind for subsequent --workload entries. Default ModelHost.
  --log-slot-progress         Read-only: poll each workload's /slots per tick and
                              journal a fleet-slot-progress entry (busy-aware-probing
                              data collection; drives nothing). Default off.
  --quiet                     Suppress per-tick stderr summary.
  --no-reload-on-source-change Do not auto-exit (→ launchd reload) when the running
                              git source changes after startup. Warning still logs.

STATUS FLAGS:
  --json                      Emit JSON instead of human format.
  --limit=<n>                 How many recent pressure-status entries to show. Default 20.


AUDIT FLAGS:
  --audit-path=<path>          Override audit path. Default $HOME/.llamactl/fleet-supervisor/audit.jsonl.
  --tool=<name>           Filter to one tool (exact match).
  --outcome=<denied|success|error>
                          Filter by outcome.
  --since=<iso-ts>        Entries with ts >= this value.
  --limit=<n>             Default 50, cap 500.
  --json                  Emit JSON instead of human format.

EXECUTOR FLAGS (opt-in — no actions taken without these):
  --auto                      Enable the proposal executor after each tick.
  --severity-threshold=<1|2|3>
                              Execute proposals at or below this tier. Default 2.
                              Tier 2 = mark-degraded (auto-safe).
                              Tier 3 = evict / restart (destructive).
  --execute=<proposalId>      Execute one specific proposal by ID regardless of
                              --auto or tier (manual one-shot override).

EXAMPLES:
  llamactl supervisor serve --once
  llamactl supervisor tick --auto --severity-threshold=2
  llamactl supervisor status
  llamactl supervisor status --json --limit=5
`;

type SupervisorStatusNode = Awaited<ReturnType<typeof readSupervisorStatus>>["nodes"][number];
type MigrationPeer = ReturnType<typeof listPeers>[number];

export interface MigrationWorkloadOpsOptions {
  peers: MigrationPeer[];
  loadManifestByName?: typeof workloadStore.loadWorkloadByNameAny;
  callViaTunnelRelay?: typeof callViaTunnelRelay;
  getNodeClientByName?: typeof getNodeClientByName;
  callTimeoutMs?: number;
  allowInsecureTunnelRelay?: boolean;
}

type MigrationWorkloadOps = Pick<MigrationControllerDeps, "deployWorkload" | "removeWorkload">;
const MIGRATION_WORKLOAD_CALL_TIMEOUT_MS = 5_000;

function renderStatusNode(node: SupervisorStatusNode): void {
  if (node.state === "NORMAL") {
    process.stdout.write(`node ${node.name}: NORMAL (no recent pressure event)\n`);
    process.stdout.write("\n");
    return;
  }
  const mins = Math.floor(node.durationMs / 60000);
  process.stdout.write(
    `node ${node.name}: HIGH for ${String(mins)}m (since ${String(node.enteredAt)})\n`,
  );
  process.stdout.write(
    `  clear progress: ${String(node.consecutiveClearTicks)}/${String(node.clearTicksNeeded)}\n`,
  );
  process.stdout.write(
    `  free_mb=${String(node.free_mb)} (breach: ${node.headroomBreach ? "yes" : "no"}) compressor_mb=${String(node.compressor_mb)} (breach: ${node.compressorBreach ? "yes" : "no"})\n`,
  );
  process.stdout.write(`  last ${String(node.recent.length)} pressure-status:\n`);
  for (const recent of node.recent) {
    const t = new Date(recent.ts).toLocaleTimeString("en-US", { hour12: false });
    const hits = [];
    if (recent.headroomBreach) hits.push("headroom");
    if (recent.compressorBreach) hits.push("compressor");
    const hitsStr = hits.length > 0 ? hits.join(",") : "(none)";
    process.stdout.write(
      `    ${t}  free=${String(recent.free_mb)}  comp=${String(recent.compressor_mb)}  clear=${String(recent.consecutiveClearTicks)}/${String(recent.clearTicksNeeded)}  hits=${hitsStr}\n`,
    );
  }
  process.stdout.write("\n");
}

function hasSufficientRelayConfig(peer: MigrationPeer, allowInsecure: boolean): boolean {
  if (peer.tunnelPreferred !== true) return true;
  if (peer.tunnelCentralUrl === undefined || peer.tunnelRelayToken === undefined) return false;
  if (allowInsecure) return true;
  return peer.tunnelCentralCertificate !== undefined && peer.tunnelCentralFingerprint !== undefined;
}

function isInsecureTunnelRelay(argv: readonly string[] = process.argv): boolean {
  for (const raw of argv) {
    if (raw === "--") break;
    if (raw === "--insecure-tunnel-relay") return true;
    if (raw === "--insecure-tunnel-relay=true") return true;
  }
  return false;
}

function workloadDeployYaml(
  workloadName: string,
  loadManifestByName: typeof workloadStore.loadWorkloadByNameAny,
): string {
  const manifest = loadManifestByName(workloadName);
  if (manifest.kind !== "ModelRun") {
    throw new Error(
      `ModelHost moves are not supported yet because ModelHost workloadApply is not durable`,
    );
  }
  return stringifyYaml({
    ...manifest,
    spec: {
      ...manifest.spec,
      // The receiving agent resolves this through its in-process local client.
      node: "local",
      enabled: true,
    },
  });
}

export function buildMigrationWorkloadOps(opts: MigrationWorkloadOpsOptions): MigrationWorkloadOps {
  const loadManifestByName = opts.loadManifestByName ?? workloadStore.loadWorkloadByNameAny;
  const relayCall = opts.callViaTunnelRelay ?? callViaTunnelRelay;
  const directClient = opts.getNodeClientByName ?? getNodeClientByName;
  const callTimeoutMs = opts.callTimeoutMs ?? MIGRATION_WORKLOAD_CALL_TIMEOUT_MS;
  const allowInsecureTunnelRelay =
    opts.allowInsecureTunnelRelay ?? isInsecureTunnelRelay(process.argv);

  const peerForNode = (node: string): MigrationPeer | undefined =>
    opts.peers.find((candidate) => candidate.id === node);

  const assertPeerCanRelay = (peer: MigrationPeer): void => {
    if (hasSufficientRelayConfig(peer, allowInsecureTunnelRelay)) return;
    throw new Error(`tunnel relay config incomplete for peer '${peer.id}'`);
  };

  const withTimeout = async <T>(operation: Promise<T>, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${String(callTimeoutMs)}ms`));
      }, callTimeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const applyToNode = async (workloadName: string, node: string): Promise<void> => {
    const peer = peerForNode(node);
    if (peer?.tunnelPreferred === true) {
      assertPeerCanRelay(peer);
      const centralUrl = peer.tunnelCentralUrl;
      const bearer = peer.tunnelRelayToken;
      if (centralUrl === undefined || bearer === undefined) {
        throw new Error(`tunnel relay config incomplete for peer '${peer.id}'`);
      }
      const yaml = workloadDeployYaml(workloadName, loadManifestByName);
      const callOpts: TunnelRelayCallOptions = {
        centralUrl,
        nodeName: peer.tunnelNodeName ?? peer.id,
        method: "workloadApply",
        input: { yaml },
        bearer,
        type: "mutation",
        timeoutMs: callTimeoutMs,
      };
      if (peer.tunnelCentralCertificate !== undefined)
        callOpts.pinnedCa = peer.tunnelCentralCertificate;
      if (peer.tunnelCentralFingerprint !== undefined)
        callOpts.expectedFingerprint = peer.tunnelCentralFingerprint;
      if (allowInsecureTunnelRelay) callOpts.insecure = true;
      await withTimeout(relayCall(callOpts), `workloadApply on ${node}`);
      return;
    }

    const signal = AbortSignal.timeout(callTimeoutMs);
    const yaml = workloadDeployYaml(workloadName, loadManifestByName);
    await withTimeout(
      directClient(node).workloadApply.mutate({ yaml }, { signal }),
      `workloadApply on ${node}`,
    );
  };

  const deleteFromNode = async (workloadName: string, node: string): Promise<void> => {
    const peer = peerForNode(node);
    if (peer?.tunnelPreferred === true) {
      assertPeerCanRelay(peer);
      const centralUrl = peer.tunnelCentralUrl;
      const bearer = peer.tunnelRelayToken;
      if (centralUrl === undefined || bearer === undefined) {
        throw new Error(`tunnel relay config incomplete for peer '${peer.id}'`);
      }
      const callOpts: TunnelRelayCallOptions = {
        centralUrl,
        nodeName: peer.tunnelNodeName ?? peer.id,
        method: "workloadDelete",
        input: { name: workloadName },
        bearer,
        type: "mutation",
        timeoutMs: callTimeoutMs,
      };
      if (peer.tunnelCentralCertificate !== undefined)
        callOpts.pinnedCa = peer.tunnelCentralCertificate;
      if (peer.tunnelCentralFingerprint !== undefined)
        callOpts.expectedFingerprint = peer.tunnelCentralFingerprint;
      if (allowInsecureTunnelRelay) callOpts.insecure = true;
      await withTimeout(relayCall(callOpts), `workloadDelete on ${node}`);
      return;
    }

    const signal = AbortSignal.timeout(callTimeoutMs);
    await withTimeout(
      directClient(node).workloadDelete.mutate({ name: workloadName }, { signal }),
      `workloadDelete on ${node}`,
    );
  };

  return {
    deployWorkload: async (workloadName, toNode): Promise<void> => {
      await applyToNode(workloadName, toNode);
    },
    removeWorkload: async (workloadName, fromNode): Promise<void> => {
      await deleteFromNode(workloadName, fromNode);
    },
  };
}

async function runSupervisorStatus(flags: Flags, journalPath: string): Promise<number> {
  const report = await readSupervisorStatus({
    journalPath,
    node: flags.node,
    ...omitUndefined({ limit: flags.limit }),
  });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }

  if (report.nodes.length === 0) {
    process.stdout.write(`No entries found in journal: ${journalPath}\n`);
    return 0;
  }

  for (const node of report.nodes) {
    renderStatusNode(node);
  }
  return 0;
}

async function runSupervisorAudit(flags: Flags): Promise<number> {
  const res = await readAuditEntries({
    ...omitUndefined({ auditPath: flags.auditPath }),
    ...omitUndefined({ tool: flags.tool }),
    ...omitUndefined({ outcome: flags.outcome }),
    ...omitUndefined({ since: flags.since }),
    limit: flags.limit ?? 50,
  });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }

  if (res.malformedLines > 0) {
    process.stdout.write(`audit: ${String(res.malformedLines)} malformed lines skipped\n`);
  }
  process.stdout.write(
    `audit: ${res.auditPath}  total=${String(res.total)} entries=${String(res.entries.length)}\n\n`,
  );

  const summarize = (obj: unknown): string => {
    if (!isRecord(obj) || Object.keys(obj).length === 0) return "{}";

    let out = "";
    if ("proposalId" in obj) out += `proposalId:"${String(obj["proposalId"])}" `;
    if ("name" in obj) out += `name:"${String(obj["name"])}" `;
    if ("error" in obj && typeof obj["error"] === "string")
      out += `error:"${obj["error"].slice(0, 40)}" `;
    if ("auto" in obj) out += `auto:${String(obj["auto"])} `;
    if ("memMb" in obj) out += `memMb=${String(obj["memMb"])} `;
    if ("action" in obj && typeof obj["action"] === "string") out += `action:"${obj["action"]}" `;

    out = out.trim();
    if (!out) {
      const str = JSON.stringify(obj);
      return str.length > 80 ? str.slice(0, 80) + "..." : str;
    }
    return "{" + out + "}";
  };

  for (const e of res.entries) {
    const inStr = summarize(e.input);
    let detStr = "";
    // Entries come from unvalidated JSONL — a legacy/foreign line may
    // carry a missing/null/primitive detail, so guard before reading.
    if (isRecord(e.detail) && typeof e.detail["error"] === "string" && e.detail["error"]) {
      detStr = e.detail["error"];
    } else {
      detStr = summarize(e.detail);
    }

    process.stdout.write(
      `${e.ts}  ${e.outcome.padEnd(7)}  ${e.tool.padEnd(30)}  input=${inStr}  detail=${detStr}\n`,
    );
  }
  return 0;
}

// Mirror of the aggregator's staleness convention (aggregator.ts
// DEFAULT_STALE_AFTER_MS, ~3x tick). A peer snapshot older than this is treated
// as a dead node by the election.
const STALE_AFTER_MS = 90_000;

/**
 * Direct peer-fetch fallback for the lease election when the local aggregator
 * process is down or its db is empty. Pulls each peer's /v1/fleet/snapshot
 * directly (as findBestDestination does), carrying their `lease` intent, and
 * shapes them into SnapshotRow[]. On TOTAL failure returns [] so electLeaseHolder
 * yields null (no holder = safe) — NEVER degrades to always-self.
 */
async function directPeerFetchSnapshots(currentNodeName: string): Promise<SnapshotRow[]> {
  const peers = listPeers({ currentNodeName });
  const results = await Promise.all(
    peers.map(async (peer): Promise<SnapshotRow | null> => {
      try {
        const snapshot = await createPeerFetch(peer)();
        if (!snapshot) return null;
        return { node: snapshot.node, ts: snapshot.ts, snapshot };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((row): row is SnapshotRow => row !== null);
}

/**
 * Build this node's OWN lease intent row, shaped exactly as loop.ts publishes it
 * into every per-tick snapshot, wrapped as a SnapshotRow for the election input.
 *
 * The local aggregator's cluster.db never contains the self row — listPeers()
 * filters `node.name !== localNodeName` (packages/core/.../peers.ts), so a node's
 * own aggregator only ever stores PEER snapshots. getLatestPerNode(cluster.db)
 * therefore yields a SELF-EXCLUDED set. Feeding that directly to electLeaseHolder
 * drops the only eligible candidate (self) and elects null even in the
 * single-eligible-node prod case — which would freeze migrations (design §5
 * forbids this: "single eligible node => unchanged behavior"). The election is a
 * function over the replicated snapshots INCLUDING the node's own self-published
 * lease, so the wiring must inject this self row before electing.
 */
function buildSelfLeaseRow(
  selfNode: string,
  term: number,
  eligible: boolean,
  seq: number,
  nowMs: number,
): SnapshotRow {
  const ts = new Date(nowMs).toISOString();
  const snapshot: FleetSnapshotEntry = {
    kind: "fleet-snapshot",
    ts,
    node: selfNode,
    node_mem: {
      free_mb: 0,
      active_mb: 0,
      inactive_mb: 0,
      wired_mb: 0,
      compressor_mb: 0,
      swap_in: 0,
      swap_out: 0,
    },
    workloads: [],
    lease: { candidate: selfNode, term, eligible, seq },
  };
  return { node: selfNode, ts, snapshot };
}

/** Injectable seam for makeGetLeaseHolder so the real wiring can be exercised in
 *  tests over a self-excluded cluster.db without touching the user's $HOME db. */
export interface GetLeaseHolderDeps {
  selfNode: string;
  /** Persisted monotonic lease term (bumpLeaseTerm at startup). */
  selfLeaseTerm: number;
  /** LLAMACTL_FLEET_MOVE_ENABLED === "1" — self's eligibility. */
  selfEligible: boolean;
  /** Override LLAMACTL_FLEET_LEASE_MODE (default reads process.env). */
  leaseMode?: string;
  /** Override the clock (default Date.now). */
  now?: () => number;
  /** Override the per-node-fresh peer view (default getLatestPerNode over the
   *  local cluster.db). Returns null/[] when the aggregator is down/empty. */
  loadPeerRows?: (freshAfterTs: string) => SnapshotRow[] | null;
  /** Override the direct peer-fetch fallback (default createPeerFetch pull). */
  directFetch?: (selfNode: string) => Promise<SnapshotRow[]>;
}

/**
 * Build the scheduler-lease getLeaseHolder closure, gated by
 * LLAMACTL_FLEET_LEASE_MODE.
 *
 * - `legacy-self`: restores PR-1 behavior — holder is always selfNode (instant
 *   rollback without redeploy).
 * - default (`derived`): elects over the self-INCLUSIVE replicated view — this
 *   node's own freshly-minted lease intent PLUS the local aggregator's per-node
 *   peer rows (getLatestPerNode). When the aggregator is down/empty we still
 *   elect over [selfRow] synchronously (so an eligible self never spuriously
 *   loses the lease) and kick an async direct peer-pull to refine the next tick.
 *   On total peer failure the election still sees the self row — never degrades
 *   to "no holder" for the common single-eligible case, and never to "always
 *   self" when ineligible (self.eligible=false => null).
 *
 * In CURRENT prod (exactly one eligible node) the election returns that node, so
 * holder === self → byte-identical to PR-1.
 */
export function makeGetLeaseHolder(deps: GetLeaseHolderDeps): () => string | null {
  const { selfNode, selfLeaseTerm, selfEligible } = deps;
  const leaseMode = deps.leaseMode ?? process.env["LLAMACTL_FLEET_LEASE_MODE"] ?? "derived";
  if (leaseMode === "legacy-self") {
    return (): string => selfNode;
  }
  const now = deps.now ?? ((): number => Date.now());
  const loadPeerRows =
    deps.loadPeerRows ??
    ((freshAfterTs: string): SnapshotRow[] | null => {
      try {
        const db = openAggregatorDb();
        return getLatestPerNode(db, { freshAfterTs });
      } catch {
        return null;
      }
    });
  const directFetch = deps.directFetch ?? directPeerFetchSnapshots;

  // The direct peer-fetch fallback is async but the guard is sync. The cache is
  // scoped to THIS closure (never module-level shared state) and is purely an
  // optimization: it only ever ADDS fresh peer rows to the election input. The
  // self row is always present synchronously, so the holder is never spuriously
  // null for an eligible self even on a cold cache.
  let directFallbackCache: { rows: SnapshotRow[]; at: number } | null = null;
  let directFallbackInFlight = false;

  const refreshDirectFallback = (nowMs: number): void => {
    if (directFallbackInFlight) return;
    directFallbackInFlight = true;
    void directFetch(selfNode)
      .then((rows) => {
        directFallbackCache = { rows, at: Date.now() };
      })
      .catch(() => {
        directFallbackCache = { rows: [], at: Date.now() };
      })
      .finally(() => {
        directFallbackInFlight = false;
      });
  };

  return (): string | null => {
    const nowMs = now();
    const seq = Math.floor(nowMs / 1000);
    const selfRow = buildSelfLeaseRow(selfNode, selfLeaseTerm, selfEligible, seq, nowMs);
    const freshAfterTs = new Date(nowMs - STALE_AFTER_MS).toISOString();

    const peerRows = loadPeerRows(freshAfterTs);
    if (peerRows && peerRows.length > 0) {
      // Aggregator healthy: elect over self + the per-node-fresh peer view.
      return electLeaseHolder([selfRow, ...peerRows], nowMs, STALE_AFTER_MS);
    }

    // Aggregator down/empty: kick (or refresh) the async direct peer pull, but
    // elect NOW over self + whatever fresh peer rows the last pull cached. The
    // self row guarantees an eligible self still wins; the cache only refines the
    // result once peers respond. Never returns a spurious null for eligible self.
    refreshDirectFallback(nowMs);
    const cachedPeers =
      directFallbackCache && nowMs - directFallbackCache.at < STALE_AFTER_MS
        ? directFallbackCache.rows
        : [];
    return electLeaseHolder([selfRow, ...cachedPeers], nowMs, STALE_AFTER_MS);
  };
}

/**
 * Partition self-demotion predicate (design §2). Returns true iff this node can
 * see at least one FRESH destination peer — any peer it could move a workload
 * onto. Reuses the SAME per-node-fresh peer view as makeGetLeaseHolder (the
 * local aggregator's cluster.db, which is already self-excluded — listPeers
 * filters self — so every row is a candidate destination), falling back to a
 * direct peer pull when the aggregator is down/empty.
 *
 * Crucially this gates on destination VISIBILITY, not lease-eligibility: in the
 * single-eligible prod case the holder still sees its (ineligible) peer rows as
 * fresh destinations, so this returns true and migrations proceed exactly as
 * today. It returns false only for a partitioned-but-alive holder that can see
 * no fresh peer at all — which then self-demotes and emits no move.
 *
 * The direct fallback is async but the predicate is sync; the cache is scoped to
 * this closure and only ever ADDS fresh peer rows, so a cold cache during a real
 * partition correctly reports "no fresh peer" until a peer responds.
 */
export function makeCanSeeFreshDestinationPeer(deps: GetLeaseHolderDeps): () => boolean {
  const { selfNode } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const loadPeerRows =
    deps.loadPeerRows ??
    ((freshAfterTs: string): SnapshotRow[] | null => {
      try {
        const db = openAggregatorDb();
        return getLatestPerNode(db, { freshAfterTs });
      } catch {
        return null;
      }
    });
  const directFetch = deps.directFetch ?? directPeerFetchSnapshots;

  let directFallbackCache: { rows: SnapshotRow[]; at: number } | null = null;
  let directFallbackInFlight = false;

  const refreshDirectFallback = (): void => {
    if (directFallbackInFlight) return;
    directFallbackInFlight = true;
    void directFetch(selfNode)
      .then((rows) => {
        directFallbackCache = { rows, at: Date.now() };
      })
      .catch(() => {
        directFallbackCache = { rows: [], at: Date.now() };
      })
      .finally(() => {
        directFallbackInFlight = false;
      });
  };

  const hasFreshRow = (rows: SnapshotRow[], nowMs: number): boolean =>
    rows.some((row) => {
      const tsMs = Date.parse(row.ts);
      return Number.isFinite(tsMs) && nowMs - tsMs < STALE_AFTER_MS;
    });

  return (): boolean => {
    const nowMs = now();
    const freshAfterTs = new Date(nowMs - STALE_AFTER_MS).toISOString();

    const peerRows = loadPeerRows(freshAfterTs);
    if (peerRows && peerRows.length > 0) {
      return hasFreshRow(peerRows, nowMs);
    }

    refreshDirectFallback();
    const cachedPeers =
      directFallbackCache && nowMs - directFallbackCache.at < STALE_AFTER_MS
        ? directFallbackCache.rows
        : [];
    return hasFreshRow(cachedPeers, nowMs);
  };
}

/**
 * Cross-node in-flight-move consumer (design §4). Returns a predicate
 * `isPeerMovingWorkload(workload)` that is true iff some FRESH peer reports the
 * named workload in its snapshot `inFlightMoves` — i.e. a peer has deployed that
 * workload onto a destination but not yet removed the source. The migration
 * controller consults this before proposing a move so it does NOT start a second
 * move of a workload a peer is already mid-moving (the cross-node double-move).
 *
 * Reuses the SAME per-node-fresh peer view as makeGetLeaseHolder /
 * makeCanSeeFreshDestinationPeer (getLatestPerNode over the local cluster.db,
 * direct peer-fetch fallback when the aggregator is down/empty), and the SAME
 * staleness convention — a stale peer's in-flight publication is dropped (a dead
 * peer must not freeze a workload forever).
 *
 * The local aggregator's cluster.db is already SELF-EXCLUDED (listPeers filters
 * self), so a node never honors its OWN published move here — its own in-flight
 * moves are governed by the local cooldown, this is purely the PEER channel.
 *
 * In the single-eligible prod case no peer publishes any in-flight move, so the
 * predicate is always false and the controller behaves exactly as today.
 */
export function makeIsPeerMovingWorkload(deps: GetLeaseHolderDeps): (workload: string) => boolean {
  const { selfNode } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const loadPeerRows =
    deps.loadPeerRows ??
    ((freshAfterTs: string): SnapshotRow[] | null => {
      try {
        const db = openAggregatorDb();
        return getLatestPerNode(db, { freshAfterTs });
      } catch {
        return null;
      }
    });
  const directFetch = deps.directFetch ?? directPeerFetchSnapshots;

  let directFallbackCache: { rows: SnapshotRow[]; at: number } | null = null;
  let directFallbackInFlight = false;

  const refreshDirectFallback = (): void => {
    if (directFallbackInFlight) return;
    directFallbackInFlight = true;
    void directFetch(selfNode)
      .then((rows) => {
        directFallbackCache = { rows, at: Date.now() };
      })
      .catch(() => {
        directFallbackCache = { rows: [], at: Date.now() };
      })
      .finally(() => {
        directFallbackInFlight = false;
      });
  };

  // Collect the workloads any FRESH peer reports as in-flight. A peer is fresh by
  // the same `now - ts < STALE_AFTER_MS` test the election uses; loadPeerRows may
  // already be freshness-filtered, but we re-check here so the direct-fallback
  // cache (which is not) is held to the same bar.
  const freshInFlightWorkloads = (rows: SnapshotRow[], nowMs: number): Set<string> => {
    const out = new Set<string>();
    for (const row of rows) {
      const tsMs = Date.parse(row.ts);
      if (!Number.isFinite(tsMs) || nowMs - tsMs >= STALE_AFTER_MS) continue;
      for (const move of row.snapshot.inFlightMoves ?? []) out.add(move.workload);
    }
    return out;
  };

  return (workloadName: string): boolean => {
    const nowMs = now();
    const freshAfterTs = new Date(nowMs - STALE_AFTER_MS).toISOString();

    const peerRows = loadPeerRows(freshAfterTs);
    if (peerRows && peerRows.length > 0) {
      return freshInFlightWorkloads(peerRows, nowMs).has(workloadName);
    }

    refreshDirectFallback();
    const cachedPeers =
      directFallbackCache && nowMs - directFallbackCache.at < STALE_AFTER_MS
        ? directFallbackCache.rows
        : [];
    return freshInFlightWorkloads(cachedPeers, nowMs).has(workloadName);
  };
}

/**
 * Construct the migration controller when LLAMACTL_FLEET_MOVE_ENABLED=1, else
 * null. Bumps the persisted lease term at startup (design §2 acquire) and wires
 * the derived election (getLeaseHolder), the partition self-demotion predicate
 * (canSeeFreshDestinationPeer), and the cross-node in-flight-move consumer
 * (isPeerMovingWorkload).
 */
/**
 * Map a fetched peer fleet-snapshot to the migration-controller's NodeSnapshot,
 * deriving pressureState from node_mem via the SAME AND-gate the supervisor's own
 * pressure detector uses (isPressureHot + DEFAULT_PRESSURE_THRESHOLDS:
 * free_mb <= headroomMinMb AND compressor_mb >= compressorWarnMb). Sharing the
 * exported helper keeps the destination-viability gate consistent with local
 * pressure detection and avoids duplicating threshold literals. A constant here
 * would defeat findBestDestination's `pressureState === "NORMAL"` filter, so the
 * value MUST be computed from the snapshot.
 */
export function peerSnapshotToNodeSnapshot(snapshot: FleetSnapshotEntry): NodeSnapshot {
  const hot = isPressureHot(
    { node_mem: snapshot.node_mem, workloads: snapshot.workloads },
    DEFAULT_PRESSURE_THRESHOLDS,
  );
  return {
    node: snapshot.node,
    pressureState: hot ? "HIGH" : "NORMAL",
    nodeMem: { freeMb: snapshot.node_mem.free_mb },
    workloads: snapshot.workloads.map((workload) => ({
      name: workload.name,
      reachable: workload.reachable,
    })),
  };
}

function buildMigrationController(
  flags: Flags,
  journalPath: string,
  leaseTerm: number,
  migrationEnabled: boolean,
): MigrationController | null {
  if (!migrationEnabled) return null;
  const peers = listPeers({ currentNodeName: flags.node });
  return createMigrationController({
    peers: peers.map((peer) => peer.id),
    fetchSnapshot: async (node) => {
      const peer = peers.find((candidate) => candidate.id === node);
      if (!peer) {
        throw new Error(`unknown peer: ${node}`);
      }
      const fetchSnapshot = createPeerFetch(peer);
      const snapshot = await fetchSnapshot();
      if (!snapshot) {
        throw new Error(`peer ${node} returned no snapshot`);
      }
      return peerSnapshotToNodeSnapshot(snapshot);
    },
    ...buildMigrationWorkloadOps({ peers }),
    readRecentMoves: () => readRecentMovesFromJournal(journalPath),
    selfNode: flags.node,
    // Derived scheduler-lease election over the replicated peer snapshots,
    // gated by LLAMACTL_FLEET_LEASE_MODE (default 'derived'; 'legacy-self'
    // restores PR-1's always-self for instant rollback). In current prod
    // (one eligible node) this elects that node → holder === self →
    // byte-identical to PR-1.
    getLeaseHolder: makeGetLeaseHolder({
      selfNode: flags.node,
      selfLeaseTerm: leaseTerm,
      selfEligible: migrationEnabled,
    }),
    // Partition self-demotion (design §2): a partitioned-but-alive holder
    // that can see no fresh destination peer emits no move. Same fresh-peer
    // view as the election; gates only NEW proposals (in-flight completion
    // is unaffected).
    canSeeFreshDestinationPeer: makeCanSeeFreshDestinationPeer({
      selfNode: flags.node,
      selfLeaseTerm: leaseTerm,
      selfEligible: migrationEnabled,
    }),
    // Cross-node in-flight-move consumer (design §4): before proposing a move of
    // workload W, skip W if a fresh peer already published it in its snapshot
    // inFlightMoves (the peer is mid-moving it). Same fresh-peer view as the
    // election; honors a PEER's in-flight move so two holders can't double-move
    // the same workload. No-op in the single-eligible prod case (no peer
    // publishes any in-flight move).
    isPeerMovingWorkload: makeIsPeerMovingWorkload({
      selfNode: flags.node,
      selfLeaseTerm: leaseTerm,
      selfEligible: migrationEnabled,
    }),
    getNowMs: () => Date.now(),
  });
}

function buildSupervisorLoopOptions(
  flags: Flags,
  journalPath: string,
  once: boolean,
): SupervisorLoopOptions {
  const writeJournal = (entry: FleetJournalEntry): void => {
    appendFleetJournal(entry, journalPath);
  };

  const migrationEnabled = process.env["LLAMACTL_FLEET_MOVE_ENABLED"] === "1";
  // Acquire: bump the persisted monotonic term once at startup (design §2).
  const leaseTerm = bumpLeaseTerm(defaultLeaseTermPath());
  const migrationController = buildMigrationController(
    flags,
    journalPath,
    leaseTerm,
    migrationEnabled,
  );

  const executorEnabled = flags.auto || flags.executeId !== undefined;

  // Source-staleness auto-reload (serve mode only). Capture the running source's
  // revision once at startup; the loop consults the stateful closure at each
  // boundary and exits (→ launchd reloads) once a confirmed change is debounced.
  const startupRev = once ? undefined : sourceRevision.getSourceRevision();
  if (!once) {
    process.stderr.write(
      startupRev
        ? `supervisor: source-staleness reload ARMED at ${startupRev}\n`
        : `supervisor: source-staleness reload OFF — no git checkout resolved (compiled binary or non-git deploy); run 'llamactl infra restart-control-plane' after deploys\n`,
    );
  }
  let staleState: sourceRevision.StaleStreakState = { streak: 0 };
  const checkSourceStale = (rev: string): { shouldReload: boolean; currentRev: string | null } => {
    const r = sourceRevision.checkSourceStale(rev, staleState);
    staleState = r.state;
    return { shouldReload: r.shouldReload, currentRev: r.currentRev };
  };

  return {
    node: flags.node,
    workloads: flags.workloads,
    once,
    intervalMs: flags.intervalMs,
    writeJournal,
    // Publish the self lease intent in every per-tick snapshot so peers can run
    // electLeaseHolder over the replicated view. eligible mirrors
    // LLAMACTL_FLEET_MOVE_ENABLED (the existing eligibility gate).
    leaseTerm,
    leaseEligible: migrationEnabled,
    ...omitUndefined({ startupRev }),
    checkSourceStale,
    reloadOnSourceChange: flags.reloadOnSourceChange,
    pressureThresholds: {
      headroomMinMb: flags.headroomMb,
      compressorWarnMb: flags.compressorMb,
      consecutiveTicks: flags.consecutiveTicks,
      clearTicks: flags.clearTicks ?? DEFAULT_PRESSURE_THRESHOLDS.clearTicks,
    },
    degradationThresholds: {
      consecutiveErrorsForDegraded: flags.consecutiveErrors,
      p95DegradedMs: flags.p95DegradedMs,
      consecutiveCompletionErrorsForDegraded: flags.consecutiveCompletionErrors,
    },
    migrationController,
    logSlotProgress: flags.logSlotProgress,
    ...(executorEnabled
      ? {
          onTick: async (): Promise<void> => {
            const results = await runExecutor({
              node: flags.node,
              auto: flags.auto,
              severityThreshold: flags.severityThreshold,
              ...omitUndefined({ executeId: flags.executeId }),
              journalPath,
              writeJournal,
              disable: async (name) => {
                const r = await setWorkloadEnabled(name, false);
                if (r.message && !flags.quiet)
                  process.stderr.write(`supervisor: executor: ${r.message}`);
                return r.code;
              },
              enable: async (name) => {
                const r = await setWorkloadEnabled(name, true);
                if (r.message && !flags.quiet)
                  process.stderr.write(`supervisor: executor: ${r.message}`);
                return r.code;
              },
            });
            if (!flags.quiet && results.length > 0) {
              for (const r of results) {
                process.stderr.write(
                  `supervisor: executor: ${r.status} proposal=${r.proposalId} action=${r.action.type}${r.reason ? ` reason=${r.reason}` : ""}${r.exitCode !== undefined ? ` exitCode=${String(r.exitCode)}` : ""}\n`,
                );
              }
            }
          },
        }
      : {}),
  };
}

function isSupervisorSubcommand(sub: string): sub is "audit" | "serve" | "status" | "tick" {
  return sub === "serve" || sub === "tick" || sub === "status" || sub === "audit";
}

function printLoopBanner(
  flags: Flags,
  journalPath: string,
  once: boolean,
  loopOpts: SupervisorLoopOptions,
): void {
  if (!flags.quiet) {
    const wlSummary =
      flags.workloads.length === 0
        ? "(mem-only)"
        : flags.workloads.map((w) => `${w.name}@${redactEndpoint(w.endpoint)}`).join(", ");
    process.stderr.write(
      `supervisor: node=${flags.node} interval=${String(flags.intervalMs)}ms once=${String(once)} workloads=${wlSummary}\n`,
    );
    process.stderr.write(`supervisor: journal=${journalPath}\n`);
    if (loopOpts.onTick !== undefined) {
      process.stderr.write(
        `supervisor: executor=on auto=${String(flags.auto)} threshold=${String(flags.severityThreshold)}${flags.executeId ? ` executeId=${flags.executeId}` : ""}\n`,
      );
    }
  }
  if (flags.noWorkloadsConflict) {
    process.stderr.write(
      "supervisor: warning — both --no-workloads and --workload= were passed; --no-workloads wins, workloads ignored.\n",
    );
  }
}

async function runSupervisorLoop(
  flags: Flags,
  journalPath: string,
  once: boolean,
): Promise<number> {
  const loopOpts = buildSupervisorLoopOptions(flags, journalPath, once);
  printLoopBanner(flags, journalPath, once, loopOpts);

  const handle = startSupervisorLoop(loopOpts);
  if (!once) {
    process.on("SIGINT", () => {
      handle.stop();
    });
    process.on("SIGTERM", () => {
      handle.stop();
    });
  }
  await handle.done;
  return 0;
}

export async function runSupervisor(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return sub ? 0 : 1;
  }
  if (!isSupervisorSubcommand(sub)) {
    console.error(`Unknown supervisor subcommand: ${sub}`);
    console.error(USAGE);
    return 1;
  }
  let flags: Flags;
  try {
    flags = parseFlags(rest);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  if (sub === "serve" || sub === "tick") {
    // Deferred: re-resolve on each tick once we have low-overhead cache + invalidation.
    flags.workloads = resolveWorkloadTargetsAtStartup(flags.workloads, process.env);
  }

  const globalNode = getGlobals().nodeName;
  if (globalNode) flags.node = globalNode;
  const journalPath = flags.journal ?? defaultFleetJournalPath();

  if (sub === "status") {
    return await runSupervisorStatus(flags, journalPath);
  }

  if (sub === "audit") {
    return await runSupervisorAudit(flags);
  }

  const once = sub === "tick" || flags.once;
  return await runSupervisorLoop(flags, journalPath, once);
}

interface Flags {
  intervalMs: number;
  once: boolean;
  journal?: string;
  node: string;
  headroomMb: number;
  compressorMb: number;
  consecutiveTicks: number;
  clearTicks?: number;
  p95DegradedMs: number;
  consecutiveErrors: number;
  consecutiveCompletionErrors: number;
  workloads: WorkloadTarget[];
  noWorkloadsConflict: boolean;
  quiet: boolean;
  auto: boolean;
  logSlotProgress: boolean;
  reloadOnSourceChange: boolean;
  severityThreshold: 1 | 2 | 3;
  executeId?: string;

  json: boolean;
  limit?: number;
  auditPath?: string;
  tool?: string;
  outcome?: "denied" | "success" | "error";
  since?: string;
}

interface ResolveWorkloadUrlDeps {
  loadWorkloadByName?: typeof workloadStore.loadWorkloadByName;
  loadWorkloadByNameAny?: (name: string) => { spec: { useProxy?: boolean | undefined } };
  resolveInternalProxyEndpoint?: typeof envMod.resolveInternalProxyEndpoint;
  warn?: (message: string) => void;
}

interface ResolveWorkloadTargetsAtStartupDeps extends ResolveWorkloadUrlDeps {
  info?: (message: string) => void;
}

export function resolveWorkloadUrl(
  name: string,
  fallbackUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: ResolveWorkloadUrlDeps = {},
): string {
  const loadWorkloadByNameAny =
    deps.loadWorkloadByNameAny ??
    ((workloadName: string): { spec: { useProxy?: boolean | undefined } } =>
      deps.loadWorkloadByName
        ? deps.loadWorkloadByName(workloadName)
        : workloadStore.loadWorkloadByName(workloadName));
  const resolveInternalProxyEndpoint =
    deps.resolveInternalProxyEndpoint ?? envMod.resolveInternalProxyEndpoint;
  const warn = deps.warn ?? ((message: string): boolean => process.stderr.write(`${message}\n`));

  try {
    const manifest = loadWorkloadByNameAny(name);
    if (manifest.spec.useProxy === true) {
      return resolveInternalProxyEndpoint(env);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(
      `[supervisor] workload=${name} failed to read deployed spec (${message}); using configured URL ${fallbackUrl}`,
    );
  }

  return fallbackUrl;
}

/**
 * Reads the workload's deployed manifest and maps an enabled `spec.completionProbe`
 * to the supervisor's resolved config (seconds → ms). Returns undefined when the
 * probe is off or the manifest can't be read — the supervisor simply skips it.
 */
export function resolveCompletionProbe(
  name: string,
  deps: ResolveWorkloadUrlDeps = {},
): CompletionProbeConfig | undefined {
  const load = deps.loadWorkloadByName ?? workloadStore.loadWorkloadByName;
  try {
    const cp = load(name).spec.completionProbe;
    if (!cp?.enabled) return undefined;
    return {
      path: cp.path,
      prompt: cp.prompt,
      maxTokens: cp.maxTokens,
      timeoutMs: cp.timeoutSeconds * 1000,
      everyNTicks: cp.everyNTicks,
      ...(cp.model ? { model: cp.model } : {}),
    };
  } catch {
    return undefined;
  }
}

export function resolveWorkloadTargetsAtStartup(
  workloads: WorkloadTarget[],
  env: NodeJS.ProcessEnv = process.env,
  deps: ResolveWorkloadTargetsAtStartupDeps = {},
): WorkloadTarget[] {
  const info = deps.info ?? ((message: string): boolean => process.stderr.write(`${message}\n`));
  const loggedOverrides = new Map<string, string>();

  return workloads.map((target) => {
    // completionProbe is a ModelRun-only field; skipping non-ModelRun targets
    // avoids loading + ModelRunSchema-parsing (which throws) a ModelHost manifest.
    const completionProbe =
      target.kind === "ModelRun" ? resolveCompletionProbe(target.name, deps) : undefined;
    const withProbe = completionProbe ? { ...target, completionProbe } : target;
    const resolvedEndpoint = resolveWorkloadUrl(target.name, target.endpoint, env, deps);
    if (resolvedEndpoint === target.endpoint) return withProbe;

    const signature = `${target.endpoint}->${resolvedEndpoint}`;
    const prev = loggedOverrides.get(target.name);
    if (prev !== signature) {
      info(
        `[supervisor] workload=${target.name} routing via proxy ${resolvedEndpoint} (was ${target.endpoint})`,
      );
      loggedOverrides.set(target.name, signature);
    }
    return { ...withProbe, endpoint: resolvedEndpoint };
  });
}

const warnedDeprecatedAuditFlagNames = new Set<string>();

export function num(raw: string | undefined, prefix: string, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const v = Number(raw.slice(prefix.length));
  if (!Number.isFinite(v)) {
    return fallback;
  }
  if (v < 0) {
    throw new Error(
      `supervisor: ${prefix.replace(/=$/, "")} must be finite non-negative (got ${raw.slice(prefix.length)})`,
    );
  }
  return v;
}

interface AuditFlags {
  json: boolean;
  limit?: number;
  auditPath?: string;
  tool?: string;
  outcome?: "denied" | "success" | "error";
  since?: string;
}

function parseAuditFlags(raw: string, current: AuditFlags): void {
  if (raw.startsWith("--limit=")) {
    const limit = num(raw, "--limit=", 0) || undefined;
    if (limit !== undefined) current.limit = limit;
    return;
  }
  if (raw.startsWith("--audit-path=")) {
    current.auditPath = raw.slice("--audit-path=".length);
    return;
  }
  if (raw.startsWith("--audit=")) {
    if (!warnedDeprecatedAuditFlagNames.has("--audit")) {
      console.error("supervisor audit: --audit is deprecated; use --audit-path");
      warnedDeprecatedAuditFlagNames.add("--audit");
    }
    current.auditPath = raw.slice("--audit=".length);
    return;
  }
  if (raw.startsWith("--tool=")) {
    current.tool = raw.slice("--tool=".length);
    return;
  }
  if (raw.startsWith("--outcome=")) {
    const v = raw.slice("--outcome=".length);
    if (v === "denied" || v === "success" || v === "error") current.outcome = v;
    return;
  }
  if (raw.startsWith("--since=")) {
    current.since = raw.slice("--since=".length);
    return;
  }
}

function parsePressureFlags(
  raw: string,
  current: {
    intervalMs: number;
    journal?: string;
    node: string;
    headroomMb: number;
    compressorMb: number;
    consecutiveTicks: number;
    clearTicks?: number;
    p95DegradedMs: number;
    consecutiveErrors: number;
    consecutiveCompletionErrors: number;
  },
): void {
  if (raw.startsWith("--interval=")) {
    current.intervalMs = num(raw, "--interval=", 30) * 1000;
    return;
  }
  if (raw.startsWith("--journal=")) {
    current.journal = raw.slice("--journal=".length);
    return;
  }
  if (raw.startsWith("--node=")) {
    current.node = raw.slice("--node=".length);
    return;
  }
  if (raw.startsWith("--headroom-mb=")) {
    current.headroomMb = num(raw, "--headroom-mb=", 512);
    return;
  }
  if (raw.startsWith("--compressor-mb=")) {
    current.compressorMb = num(raw, "--compressor-mb=", 2048);
    return;
  }
  if (raw.startsWith("--consecutive-ticks=")) {
    current.consecutiveTicks = num(raw, "--consecutive-ticks=", 3);
    return;
  }
  if (raw.startsWith("--clear-ticks=")) {
    const v = Number(raw.slice("--clear-ticks=".length));
    if (!Number.isFinite(v) || v < 0)
      throw new Error("supervisor: clear-ticks must be finite non-negative");
    current.clearTicks = v;
    return;
  }
  if (raw.startsWith("--p95-degraded-ms=")) {
    current.p95DegradedMs = num(raw, "--p95-degraded-ms=", 5000);
    return;
  }
  if (raw.startsWith("--consecutive-errors=")) {
    current.consecutiveErrors = num(raw, "--consecutive-errors=", 3);
    return;
  }
  if (raw.startsWith("--consecutive-completion-errors=")) {
    current.consecutiveCompletionErrors = num(raw, "--consecutive-completion-errors=", 2);
    return;
  }
}

const AUDIT_FLAG_PREFIXES: readonly string[] = [
  "--limit=",
  "--audit-path=",
  "--audit=",
  "--tool=",
  "--outcome=",
  "--since=",
];

const PRESSURE_FLAG_PREFIXES: readonly string[] = [
  "--interval=",
  "--journal=",
  "--node=",
  "--headroom-mb=",
  "--compressor-mb=",
  "--consecutive-ticks=",
  "--clear-ticks=",
  "--p95-degraded-ms=",
  "--consecutive-errors=",
  "--consecutive-completion-errors=",
];

function hasPrefix(raw: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => raw.startsWith(prefix));
}

interface ToggleFlags {
  once: boolean;
  noWorkloads: boolean;
  quiet: boolean;
  auto: boolean;
  logSlotProgress: boolean;
  reloadOnSourceChange: boolean;
}

function parseToggleFlags(raw: string, toggles: ToggleFlags, audit: AuditFlags): boolean {
  switch (raw) {
    case "--once":
      toggles.once = true;
      return true;
    case "--no-workloads":
      toggles.noWorkloads = true;
      return true;
    case "--quiet":
      toggles.quiet = true;
      return true;
    case "--auto":
      toggles.auto = true;
      return true;
    case "--log-slot-progress":
      toggles.logSlotProgress = true;
      return true;
    case "--no-reload-on-source-change":
      toggles.reloadOnSourceChange = false;
      return true;
    case "--json":
      audit.json = true;
      return true;
    default:
      return false;
  }
}

function parseExecutorFlags(
  raw: string,
  executor: { severityThreshold: 1 | 2 | 3; executeId?: string },
): boolean {
  if (raw.startsWith("--severity-threshold=")) {
    const v = Number(raw.slice("--severity-threshold=".length));
    if (v === 1 || v === 2 || v === 3) executor.severityThreshold = v;
    return true;
  }
  if (raw.startsWith("--execute=")) {
    executor.executeId = raw.slice("--execute=".length);
    return true;
  }
  return false;
}

function parseWorkloadFlags(
  raw: string,
  state: { kind: "ModelHost" | "ModelRun"; workloads: WorkloadTarget[] },
): boolean {
  if (raw.startsWith("--kind=")) {
    const v = raw.slice("--kind=".length);
    if (v === "ModelHost" || v === "ModelRun") state.kind = v;
    return true;
  }
  if (raw.startsWith("--workload=")) {
    const v = raw.slice("--workload=".length);
    const [name, endpoint] = v.split("@", 2);
    if (name && endpoint) state.workloads.push({ name, endpoint, kind: state.kind });
    return true;
  }
  return false;
}

function parseFlags(argv: string[]): Flags {
  const toggles: ToggleFlags = {
    once: false,
    noWorkloads: false,
    quiet: false,
    auto: false,
    logSlotProgress: false,
    reloadOnSourceChange: true,
  };
  const executor: { severityThreshold: 1 | 2 | 3; executeId?: string } = { severityThreshold: 2 };
  const workloadState: { kind: "ModelHost" | "ModelRun"; workloads: WorkloadTarget[] } = {
    kind: "ModelHost",
    workloads: [],
  };

  const audit: AuditFlags = { json: false };
  const pressure: {
    intervalMs: number;
    journal?: string;
    node: string;
    headroomMb: number;
    compressorMb: number;
    consecutiveTicks: number;
    clearTicks?: number;
    p95DegradedMs: number;
    consecutiveErrors: number;
    consecutiveCompletionErrors: number;
  } = {
    intervalMs: 30_000,
    node: "local",
    headroomMb: 512,
    compressorMb: 2048,
    consecutiveTicks: 3,
    p95DegradedMs: 5000,
    consecutiveErrors: 3,
    consecutiveCompletionErrors: 2,
  };

  for (const raw of argv) {
    if (parseToggleFlags(raw, toggles, audit)) continue;
    if (hasPrefix(raw, AUDIT_FLAG_PREFIXES)) {
      parseAuditFlags(raw, audit);
      continue;
    }
    if (hasPrefix(raw, PRESSURE_FLAG_PREFIXES)) {
      parsePressureFlags(raw, pressure);
      continue;
    }
    if (parseExecutorFlags(raw, executor)) continue;
    parseWorkloadFlags(raw, workloadState);
  }

  return {
    intervalMs: pressure.intervalMs,
    once: toggles.once,
    ...omitUndefined({ journal: pressure.journal }),
    node: pressure.node,
    headroomMb: pressure.headroomMb,
    compressorMb: pressure.compressorMb,
    consecutiveTicks: pressure.consecutiveTicks,
    ...omitUndefined({ clearTicks: pressure.clearTicks }),
    p95DegradedMs: pressure.p95DegradedMs,
    consecutiveErrors: pressure.consecutiveErrors,
    consecutiveCompletionErrors: pressure.consecutiveCompletionErrors,
    workloads: toggles.noWorkloads ? [] : workloadState.workloads,
    noWorkloadsConflict: toggles.noWorkloads && workloadState.workloads.length > 0,
    quiet: toggles.quiet,
    auto: toggles.auto,
    logSlotProgress: toggles.logSlotProgress,
    reloadOnSourceChange: toggles.reloadOnSourceChange,
    severityThreshold: executor.severityThreshold,

    ...omitUndefined({ executeId: executor.executeId }),
    json: audit.json,
    ...omitUndefined({ limit: audit.limit }),
    ...omitUndefined({ auditPath: audit.auditPath }),
    ...omitUndefined({ tool: audit.tool }),
    ...omitUndefined({ outcome: audit.outcome }),
    ...omitUndefined({ since: audit.since }),
  };
}
