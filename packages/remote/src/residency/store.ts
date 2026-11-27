// Node-local fenced operation storage for the residency planner (#276, DF-03).
//
// The SQLite file must live on node-local disk: it must never sit on a
// network filesystem, where SQLite locking cannot be trusted and the fence
// below silently rots. The fence token is monotonic — every claimOwnership
// bumps it — and any mutation carrying a fenceToken that differs from the
// stored one fails closed as stale-fence.
//
// The store now persists per-model lifecycle states (Part of #517). Every
// residency_states write is fenced, compare-and-set on version, and checked
// against the lifecycle edges and exclusive-group occupancy over all
// persisted rows inside one IMMEDIATE transaction.
//
// Group declarations are not persisted. They come from the caller (default
// RESIDENCY_GROUPS), so exclusivity holds only when every writer passes
// consistent declarations.
//
// A row's group is per-row: an omitted group keeps the stored one, and a
// supplied group reassigns it. Reassignment is refused as group-conflict
// while the stored row is in an occupying state, so a member cannot leave
// or join a group while it holds that group's capacity.
//
// Operation phases remain caller-checked.
//
// touchOperation is a liveness heartbeat for a long-running operation (the
// profile-switch executor calls it at every step boundary). It is one fenced
// UPDATE of updated_at_ms only: it never bumps version, phase or ownership, so
// a later finishOperation still matches the version the writer began with. It
// never moves updated_at_ms backwards. A fence that is no longer current
// returns stale-fence, and a missing or terminal row returns not-found.
//
// claimOwnershipWhen runs a caller's decision over the nonterminal rows and the
// claim inside ONE IMMEDIATE transaction, so no other writer can begin an
// operation or claim between the read the decision saw and the claim.
//
// reservationGiB is admitted against a caller-supplied nodeBudgetGiB on
// beginOperation: the sum of pending and committed reservations, plus the new
// one, must not exceed it, else the write is refused as
// reservation-exceeds-budget. Terminal operations are not counted. A
// same-operationId replay returns before admission and is not double-counted.
// The check order is fence, then revision, then the per-model
// reservation-conflict, then the budget; a refusal leaves rows unchanged. When
// nodeBudgetGiB is absent the value is recorded but not admitted, preserving
// earlier behaviour. The budget is not persisted, so admission holds only if
// every writer passes the authoritative budget — the same caveat as group
// declarations. transitionResidencyState records no reservation and is not
// budget-gated. The profile-switch executor (apply-profile) passes the plan's
// resolved node budget; eviction rows reserve 0 GiB and are deliberately not
// budget-gated.
//
// A stale desiredRevision is refused as stale-revision by both writers. The
// check runs after the fence and before CAS and lifecycle checks, and the row
// is left unchanged. The reservation budget check runs after the revision and
// per-model conflict checks. Equal revisions are accepted;
// same-operationId replays stay idempotent even when the revision is older.
// The revision is a high-water mark taken over every operation, including
// terminal failed or cancelled ones, plus the residency rows. A terminal op
// at a high revision therefore blocks lower revisions, and no reset path
// exists. This is an interpretation of the issue's "desired profile revision"
// that later #276 follow-ups (contracts.ts / authority.ts) may refine. Note
// the shared (not per-model) scope the DF-03 contract tests pin: cross-model
// writes below the watermark are refused. transitionResidencyState still
// accepts a write that carries no desiredRevision, for backward compatibility;
// that write keeps the stored revision, so the stale-writer gap is closed only
// for writers that pass a revision. Making the field mandatory is a follow-up.
//
// readResidencyStoreSnapshot reports lastSucceededAtMs, the newest succeeded
// terminal finish per model, so the switchCooldownSeconds profile-switch
// cooldown can measure the node's last switch from this store (Part of #519).
import type { ResidencyAuditEntry } from "@llamactl/core/residency/leases";

import { llamactlHome } from "@llamactl/core/config/env";
import {
  evaluateResidencyTransition,
  isOccupyingResidencyState,
  isResidencyState,
  RESIDENCY_GROUPS,
  type ResidencyGroupDeclaration,
  type ResidencyMember,
  type ResidencyState,
  type ResidencyTransitionDecision,
} from "@llamactl/core/residency/lifecycle";
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";

import { existsSync, mkdirSync, statSync } from "../safe-fs.js";

const SCHEMA_VERSION = 1;
export const RESIDENCY_INFERENCE_HOLD_SCHEMA_VERSION = 2;

// Forced-unload lease audit (#278, DF-05). Newest rows win: the sink trims to
// this many after every append, and the busy timeout is short so a locked store
// costs an observability write at most this long (never an unload).
export const RESIDENCY_LEASE_AUDIT_RETENTION = 500;
export const RESIDENCY_LEASE_AUDIT_BUSY_TIMEOUT_MS = 250;

const PHASES = ["pending", "committed", "terminal"] as const;
const OUTCOMES = ["succeeded", "failed", "cancelled", "unknown"] as const;

export type ResidencyOperationPhase = (typeof PHASES)[number];
export type ResidencyOperationOutcome = (typeof OUTCOMES)[number];

export type ResidencyStoreFailure =
  | "duplicate-conflict"
  | "group-conflict"
  | "illegal-phase"
  | "invalid-input"
  | "not-found"
  | "reservation-conflict"
  | "reservation-exceeds-budget"
  | "stale-fence"
  | "stale-revision"
  | "version-conflict";

export type ResidencyStateRecord = {
  model: string;
  group: string | null;
  state: ResidencyState;
  ownerId: string;
  incarnation: string;
  fenceToken: number;
  version: number;
  updatedAtMs: number;
  desiredRevision?: number;
};

export type TransitionResidencyStateInput = {
  fenceToken: number;
  model: string;
  group?: string;
  to: ResidencyState;
  expectedVersion: number;
  nowMs: number;
  groups?: readonly ResidencyGroupDeclaration[];
  desiredRevision?: number;
};

export type TransitionResidencyStateResult =
  | { ok: true; record: ResidencyStateRecord }
  | { ok: false; reason: ResidencyStoreFailure }
  | {
      ok: false;
      reason: "lifecycle-refused";
      decision: Extract<ResidencyTransitionDecision, { ok: false }>;
    };

export type ResidencyOperationRecord = {
  operationId: string;
  model: string;
  targetState: string;
  desiredRevision: number;
  reservationGiB: number;
  phase: ResidencyOperationPhase;
  outcome: ResidencyOperationOutcome | null;
  detail: string | null;
  ownerId: string;
  incarnation: string;
  fenceToken: number;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
};

type Fence = {
  ownerId: string;
  incarnation: string;
  fenceToken: number;
};

type ClaimInput = {
  ownerId: string;
  incarnation: string;
};

type OperationSpec = {
  operationId: string;
  model: string;
  targetState: string;
  desiredRevision: number;
  reservationGiB: number;
  nowMs: number;
  nodeBudgetGiB?: number;
};

type BeginOperationInput = OperationSpec & { fenceToken: number };

type MutationInput = {
  fenceToken: number;
  operationId: string;
  expectedVersion: number;
  nowMs: number;
};

type TouchOperationInput = {
  fenceToken: number;
  operationId: string;
  nowMs: number;
};

type ClaimWhenResult = { claimed: true; fence: Fence } | { claimed: false };

type FinishOperationInput = MutationInput & {
  outcome: ResidencyOperationOutcome;
  detail?: string;
};

export type BeginOperationResult =
  | { ok: true; created: boolean; record: ResidencyOperationRecord }
  | { ok: false; reason: ResidencyStoreFailure };

type ClaimAndBeginOperationResult =
  | BeginOperationResult
  | { ok: false; reason: "busy"; operationId: string | null };

type MutationResult = { ok: true } | { ok: false; reason: ResidencyStoreFailure };

export type ResidencyOperationStore = {
  claimOwnership: (input: ClaimInput) => Fence;
  claimOwnershipWhen: (
    input: ClaimInput,
    decide: (nonterminal: ResidencyOperationRecord[]) => boolean,
  ) => ClaimWhenResult;
  currentFence: () => Fence | null;
  beginOperation: (input: BeginOperationInput) => BeginOperationResult;
  claimAndBeginOperation: (
    identity: ClaimInput,
    input: OperationSpec,
  ) => ClaimAndBeginOperationResult;
  commitReservation: (input: MutationInput) => MutationResult;
  finishOperation: (input: FinishOperationInput) => MutationResult;
  touchOperation: (input: TouchOperationInput) => MutationResult;
  getOperation: (operationId: string) => ResidencyOperationRecord | null;
  listNonterminal: () => ResidencyOperationRecord[];
  close: () => void;
};

// Per-model lifecycle states ride on the same fenced handle as operations.
// They live on a separate type so callers that only need operation mutations
// keep seeing the narrower shape.
export type ResidencyLifecycleStore = {
  getResidencyState: (model: string) => ResidencyStateRecord | null;
  listResidencyStates: () => ResidencyStateRecord[];
  transitionResidencyState: (
    input: TransitionResidencyStateInput,
  ) => TransitionResidencyStateResult;
};

interface AuthorityRow {
  owner_id: string;
  incarnation: string;
  fence_token: number;
}

interface OperationRow {
  operation_id: string;
  model: string;
  target_state: string;
  desired_revision: number;
  reservation_gib: number;
  phase: string;
  outcome: string | null;
  detail: string | null;
  owner_id: string;
  incarnation: string;
  fence_token: number;
  version: number;
  created_at_ms: number;
  updated_at_ms: number;
}

interface ResidencyStateRow {
  model: string;
  residency_group: string | null;
  state: string;
  owner_id: string;
  incarnation: string;
  fence_token: number;
  version: number;
  updated_at_ms: number;
  desired_revision: number | null;
}

const OPERATION_COLUMNS =
  "operation_id, model, target_state, desired_revision, reservation_gib, phase, " +
  "outcome, detail, owner_id, incarnation, fence_token, version, created_at_ms, updated_at_ms";

const RESIDENCY_STATE_COLUMNS =
  "model, residency_group, state, owner_id, incarnation, fence_token, version, updated_at_ms, desired_revision";

export function openResidencyOperationStore(input: {
  path: string;
  requireExisting?: boolean;
  busyTimeoutMs?: number;
}): ResidencyOperationStore & ResidencyLifecycleStore {
  const db = openDb(input.path, input.busyTimeoutMs ?? 15000, input.requireExisting === true);
  const claimTx = db.transaction(
    (claimInput: ClaimInput): Fence => claimOwnershipTx(db, claimInput),
  );
  const claimWhenTx = db.transaction(
    (
      claimInput: ClaimInput,
      decide: (nonterminal: ResidencyOperationRecord[]) => boolean,
    ): ClaimWhenResult => {
      if (!decide(listNonterminalRows(db))) {
        return { claimed: false };
      }
      return { claimed: true, fence: claimOwnershipTx(db, claimInput) };
    },
  );
  const beginTx = db.transaction(
    (beginInput: BeginOperationInput): BeginOperationResult => beginOperationTx(db, beginInput),
  );
  const claimAndBeginTx = db.transaction(
    (identity: ClaimInput, input: OperationSpec): ClaimAndBeginOperationResult =>
      claimAndBeginOperationTx(db, identity, input),
  );
  const commitTx = db.transaction(
    (mutationInput: MutationInput): MutationResult => commitReservationTx(db, mutationInput),
  );
  const finishTx = db.transaction(
    (finishInput: FinishOperationInput): MutationResult => finishOperationTx(db, finishInput),
  );
  const transitionTx = db.transaction(
    (transitionInput: TransitionResidencyStateInput): TransitionResidencyStateResult =>
      transitionResidencyStateTx(db, transitionInput),
  );
  const store: ResidencyOperationStore & ResidencyLifecycleStore = {
    beginOperation: (beginInput) => {
      const invalid = validateBeginInput(beginInput);
      if (invalid !== null) {
        return { ok: false, reason: invalid };
      }
      return beginTx.immediate(beginInput);
    },
    claimAndBeginOperation: (identity, beginInput) => {
      const { ownerId, incarnation } = identity;
      if (!isNonEmpty(ownerId) || !isNonEmpty(incarnation)) {
        throw new Error("claimAndBeginOperation requires a non-empty ownerId and incarnation");
      }
      const invalid = validateOperationSpec(beginInput);
      return invalid === null
        ? claimAndBeginTx.immediate({ ownerId, incarnation }, beginInput)
        : { ok: false, reason: invalid };
    },
    claimOwnership: (claimInput) => {
      if (!isNonEmpty(claimInput.ownerId) || !isNonEmpty(claimInput.incarnation)) {
        throw new Error("claimOwnership requires a non-empty ownerId and incarnation");
      }
      return claimTx.immediate(claimInput);
    },
    claimOwnershipWhen: (claimInput, decide) => {
      if (!isNonEmpty(claimInput.ownerId) || !isNonEmpty(claimInput.incarnation)) {
        throw new Error("claimOwnershipWhen requires a non-empty ownerId and incarnation");
      }
      return claimWhenTx.immediate(claimInput, decide);
    },
    close: () => {
      db.close();
    },
    commitReservation: (mutationInput) => {
      const invalid = validateMutationInput(mutationInput);
      if (invalid !== null) {
        return { ok: false, reason: invalid };
      }
      return commitTx.immediate(mutationInput);
    },
    currentFence: () => readAuthority(db),
    finishOperation: (finishInput) => {
      const invalid = validateFinishInput(finishInput);
      if (invalid !== null) {
        return { ok: false, reason: invalid };
      }
      return finishTx.immediate(finishInput);
    },
    getOperation: (operationId) => {
      const row = selectOperationRow(db, operationId);
      return row === null ? null : rowToRecord(row);
    },
    getResidencyState: (model) => {
      const row = selectResidencyStateRow(db, model);
      if (row === null) {
        return null;
      }
      return parseResidencyStateRow(row);
    },
    listNonterminal: () => listNonterminalRows(db),
    listResidencyStates: () => listResidencyStateRows(db),
    touchOperation: (touchInput) => {
      if (
        !isNonEmpty(touchInput.operationId) ||
        !isFenceToken(touchInput.fenceToken) ||
        !Number.isFinite(touchInput.nowMs)
      ) {
        return { ok: false, reason: "invalid-input" };
      }
      return touchOperationStmt(db, touchInput);
    },
    transitionResidencyState: (transitionInput) => {
      const invalid = validateTransitionInput(transitionInput);
      if (invalid !== null) {
        return { ok: false, reason: invalid };
      }
      return transitionTx.immediate(transitionInput);
    },
  };
  return store;
}

function openDb(path: string, busyTimeoutMs = 15000, requireExisting = false): Database {
  if (!requireExisting) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { readwrite: true, create: !requireExisting });
  try {
    if (requireExisting) db.query("SELECT version FROM schema_version").get();
    db.run("PRAGMA journal_mode = WAL");
    db.run(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
    migrate(db);
  } catch (error: unknown) {
    db.close();
    throw error;
  }
  return db;
}

// Single source of truth for the node-local residency store path. The file
// must resolve to node-local disk: a network path would silently rot the
// fence, so this resolver — not the caller's cwd — decides where it lives.
export function defaultResidencyStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["LLAMACTL_RESIDENCY_STORE"]?.trim();
  if (override) {
    return override;
  }
  return join(llamactlHome(env), "residency", "operations.sqlite");
}

export type ResidencyStoreSnapshot =
  | { path: string; present: false }
  | {
      path: string;
      present: true;
      nonterminal: ResidencyOperationRecord[];
      lastSucceededAtMs?: Readonly<Record<string, number>>;
      lifecycle?: ResidencyStateRecord[];
      lifecycleError?: string;
    }
  | { path: string; present: true; error: string };

// Newest terminal finish per model among operations that ended `succeeded`.
// Failed, cancelled, unknown and nonterminal rows are ignored, so this is the
// last *successful* switch the cooldown must measure against (Part of #519).
function lastSucceededAtMsByModel(db: Database): Record<string, number> {
  const rows = db
    .query(
      "SELECT model, MAX(updated_at_ms) AS at FROM operations WHERE phase = 'terminal' AND outcome = 'succeeded' GROUP BY model ORDER BY model",
    )
    .all() as { model: string; at: number }[];
  return Object.fromEntries(rows.map((row): [string, number] => [row.model, row.at]));
}

// Read-only view of an existing store. Never mkdir, never set journal_mode,
// never migrate, never claim ownership — a status read must leave the file
// byte-identical. Opened readonly but NOT immutable: immutable=1 skips the
// WAL, so rows a live writer has not checkpointed yet would go unseen.
// The snapshot now carries the per-model lifecycle rows too (Part of #517);
// a lifecycle-row read failure is isolated into lifecycleError so the
// operations section stays an ok snapshot — only an operations-table failure
// produces the whole-store error variant.
export function readResidencyStoreSnapshot(
  path: string,
  opts?: { busyTimeoutMs?: number },
): ResidencyStoreSnapshot {
  if (!existsSync(path)) {
    return { path, present: false };
  }
  const busyTimeoutMs = opts?.busyTimeoutMs ?? 15000;
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    db.run(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
    const nonterminal = listNonterminalRows(db);
    const lastSucceededAtMs = lastSucceededAtMsByModel(db);
    try {
      return {
        path,
        present: true,
        nonterminal,
        lastSucceededAtMs,
        lifecycle: listResidencyStateRowsReadOnly(db),
      };
    } catch (error: unknown) {
      return {
        path,
        present: true,
        nonterminal,
        lastSucceededAtMs,
        lifecycleError: (error as Error).message,
      };
    }
  } catch (error: unknown) {
    return { path, present: true, error: (error as Error).message };
  } finally {
    db?.close();
  }
}

type ProfileOperationView = {
  active: ResidencyOperationRecord | null;
  terminal: ResidencyOperationRecord | null;
  fenceToken: number | null;
};

function profileOperationsAt(
  db: Database,
  model: string,
  targetPrefix: string,
): ProfileOperationView {
  const active = db
    .query(`SELECT ${OPERATION_COLUMNS} FROM operations WHERE model = ? AND phase != 'terminal'`)
    .get(model) as OperationRow | null;
  // Switches on a model serialize. Insertion order survives wall-clock changes.
  // A pending row starts at v1. Only a committed row can finish at v3.
  const terminal = db
    .query(
      `SELECT ${OPERATION_COLUMNS} FROM operations
       WHERE model = ? AND phase = 'terminal' AND substr(target_state, 1, ?) = ?
         AND (outcome = 'succeeded' OR (outcome = 'unknown' AND version >= 3))
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(model, targetPrefix.length, targetPrefix) as OperationRow | null;
  return {
    active: active === null ? null : rowToRecord(active),
    terminal: terminal === null ? null : rowToRecord(terminal),
    fenceToken: readAuthority(db)?.fenceToken ?? null,
  };
}

function profileStorePresent(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export function readProfileOperations(
  path: string,
  model: string,
  targetPrefix: string,
): ProfileOperationView | null {
  if (!profileStorePresent(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    db.run(`PRAGMA busy_timeout = ${String(RESIDENCY_LEASE_AUDIT_BUSY_TIMEOUT_MS)}`);
    return db.transaction(() => profileOperationsAt(db, model, targetPrefix))();
  } finally {
    db.close();
  }
}

// ── Forced-unload lease audit persistence (#278, DF-05) ─────────────────

interface LeaseAuditRow {
  workload: string;
  epoch: number;
  revoked: string;
  reason: string | null;
  incarnation: string | null;
}

// Append + trim run together inside one IMMEDIATE transaction (the caller wraps
// this with db.transaction(...).immediate). Audit appends are observability, not
// ownership-gated, so there is no fence check here.
function appendLeaseAuditTx(db: Database, entry: ResidencyAuditEntry): void {
  db.query(
    "INSERT INTO lease_audit (workload, epoch, revoked, reason, incarnation) VALUES (?, ?, ?, ?, ?)",
  ).run(
    entry.workload,
    entry.epoch,
    JSON.stringify(entry.revoked),
    entry.reason ?? null,
    entry.incarnation ?? null,
  );
  db.query(
    `DELETE FROM lease_audit
     WHERE seq NOT IN (SELECT seq FROM lease_audit ORDER BY seq DESC LIMIT ?)`,
  ).run(RESIDENCY_LEASE_AUDIT_RETENTION);
}

// Defensive parse: revoked is trusted only as a JSON string array. Bad JSON or
// a non-array yields []; within an array, only string elements survive. A NULL
// reason or incarnation keeps the key omitted (exactOptionalPropertyTypes); a
// legacy row written before the incarnation column has none.
function rowToAuditEntry(row: LeaseAuditRow): ResidencyAuditEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.revoked) as unknown;
  } catch {
    parsed = null;
  }
  const revoked = Array.isArray(parsed)
    ? parsed.filter((element): element is string => typeof element === "string")
    : [];
  return {
    workload: row.workload,
    epoch: row.epoch,
    forced: true,
    revoked,
    ...(row.reason !== null ? { reason: row.reason } : {}),
    ...(row.incarnation !== null ? { incarnation: row.incarnation } : {}),
  };
}

// The reader never migrates, so a store written before the incarnation column
// existed is read as-is: its rows come back with a NULL incarnation.
function listLeaseAuditRows(db: Database): ResidencyAuditEntry[] {
  const incarnation = hasColumn(db, "lease_audit", "incarnation") ? "incarnation" : "NULL";
  const rows = db
    .query(
      `SELECT workload, epoch, revoked, reason, ${incarnation} AS incarnation FROM lease_audit ORDER BY seq ASC`,
    )
    .all() as LeaseAuditRow[];
  return rows.map((row) => rowToAuditEntry(row));
}

export type ResidencyLeaseAuditSink = {
  onAudit: (entry: ResidencyAuditEntry) => void;
  close: () => void;
};

// Node-local durability mirror of core's in-memory forced-unload audit. Opens
// its OWN connection lazily on the first write, so an agent that never forces
// an unload never touches the store file (the migrate step also runs under the
// short audit busy timeout). A failed open is not cached, so the next call
// retries. close() is idempotent and makes every later onAudit a permanent
// no-op. Open and write errors propagate to core's try/catch, never an unload.
export function createResidencyLeaseAuditSink(opts: {
  path: string;
  busyTimeoutMs?: number;
  requireExisting?: boolean;
}): ResidencyLeaseAuditSink {
  const busyTimeoutMs = opts.busyTimeoutMs ?? RESIDENCY_LEASE_AUDIT_BUSY_TIMEOUT_MS;
  let db: Database | null = null;
  let appendAudit: ((entry: ResidencyAuditEntry) => void) | null = null;
  let closed = false;

  return {
    onAudit: (entry): void => {
      if (closed) {
        return;
      }
      if (db === null) {
        const opened = openDb(opts.path, busyTimeoutMs, opts.requireExisting === true);
        const appendImmediate = opened.transaction((auditEntry: ResidencyAuditEntry): void => {
          appendLeaseAuditTx(opened, auditEntry);
        });
        db = opened;
        appendAudit = (auditEntry): void => {
          appendImmediate.immediate(auditEntry);
        };
      }
      appendAudit?.(entry);
    },
    close: (): void => {
      if (closed) {
        return;
      }
      closed = true;
      db?.close();
      db = null;
      appendAudit = null;
    },
  };
}

// Read-only view of the persisted audit, mirroring readResidencyStoreSnapshot:
// no mkdir, no journal_mode, no migrate, no ownership. A missing file, a missing
// table, or any read error returns an empty list, so status never fails on the
// audit section.
export function readResidencyLeaseAudit(path: string): ResidencyAuditEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    db.run(`PRAGMA busy_timeout = ${String(RESIDENCY_LEASE_AUDIT_BUSY_TIMEOUT_MS)}`);
    return listLeaseAuditRows(db);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function migrate(db: Database): void {
  db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const stored = db.query("SELECT version FROM schema_version LIMIT 1").get() as {
    version: number;
  } | null;
  if (stored === null) {
    createTables(db);
    db.query("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    return;
  }
  if (stored.version > RESIDENCY_INFERENCE_HOLD_SCHEMA_VERSION) {
    throw new Error(
      `residency store schema_version ${String(stored.version)} is newer than supported ${String(RESIDENCY_INFERENCE_HOLD_SCHEMA_VERSION)}`,
    );
  }
  createTables(db);
}

function createTables(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS authority (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      owner_id TEXT NOT NULL,
      incarnation TEXT NOT NULL,
      fence_token INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS operations (
      operation_id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      target_state TEXT NOT NULL,
      desired_revision INTEGER NOT NULL,
      reservation_gib REAL NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('pending','committed','terminal')),
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('succeeded','failed','cancelled','unknown')),
      detail TEXT,
      owner_id TEXT NOT NULL,
      incarnation TEXT NOT NULL,
      fence_token INTEGER NOT NULL,
      version INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      CHECK ((phase = 'terminal') = (outcome IS NOT NULL))
    )
  `);
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_model_nonterminal ON operations (model) WHERE phase != 'terminal'",
  );
  db.run(`
    CREATE TABLE IF NOT EXISTS residency_states (
      model TEXT PRIMARY KEY,
      residency_group TEXT,
      state TEXT NOT NULL CHECK (state IN ('unavailable','downloaded','loading','warming','ready','draining','unloading','failed')),
      owner_id TEXT NOT NULL,
      incarnation TEXT NOT NULL,
      fence_token INTEGER NOT NULL,
      version INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      desired_revision INTEGER
    )
  `);
  addColumnIfMissing(db, "residency_states", "desired_revision", "INTEGER");
  db.run(`
    CREATE TABLE IF NOT EXISTS lease_audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      workload TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      revoked TEXT NOT NULL,
      reason TEXT,
      incarnation TEXT
    )
  `);
  addColumnIfMissing(db, "lease_audit", "incarnation", "TEXT");
}

// Additive, in-place migration: a #662-era residency_states table predates
// desired_revision, and a first-cut lease_audit table predates incarnation, so
// ALTER them in (nullable) without bumping SCHEMA_VERSION.
function addColumnIfMissing(db: Database, table: string, column: string, decl: string): void {
  if (!hasColumn(db, table, column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const columns = db.query(`PRAGMA table_info('${table}')`).all() as { name: string }[];
  return columns.some((entry) => entry.name === column);
}

function readAuthority(db: Database): Fence | null {
  const row = db
    .query("SELECT owner_id, incarnation, fence_token FROM authority WHERE id = 1")
    .get() as AuthorityRow | null;
  if (row === null) {
    return null;
  }
  return { ownerId: row.owner_id, incarnation: row.incarnation, fenceToken: row.fence_token };
}

function claimOwnershipTx(db: Database, input: ClaimInput): Fence {
  const current = readAuthority(db);
  const fence: Fence = {
    ownerId: input.ownerId,
    incarnation: input.incarnation,
    fenceToken: current === null ? 1 : current.fenceToken + 1,
  };
  db.query(
    `INSERT INTO authority (id, owner_id, incarnation, fence_token) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, incarnation = excluded.incarnation, fence_token = excluded.fence_token`,
  ).run(fence.ownerId, fence.incarnation, fence.fenceToken);
  return fence;
}

function beginOperationTx(db: Database, input: BeginOperationInput): BeginOperationResult {
  const authority = readAuthority(db);
  if (authority?.fenceToken !== input.fenceToken) {
    return { ok: false, reason: "stale-fence" };
  }
  return checkBeginOperation(db, input) ?? createPendingOperation(db, input, authority);
}

function claimAndBeginOperationTx(
  db: Database,
  identity: ClaimInput,
  input: OperationSpec,
): ClaimAndBeginOperationResult {
  const operationId = nonterminalOperationIdForModel(db, input.model);
  if (operationId !== null) {
    return { ok: false, reason: "busy", operationId };
  }
  const current = readAuthority(db);
  if (current !== null && current.ownerId !== identity.ownerId) {
    return { ok: false, reason: "busy", operationId: null };
  }
  const checked = checkBeginOperation(db, input);
  if (checked !== null) {
    return checked;
  }

  // Commit the new fence and its blocking reservation as one write. A
  // rejected reservation must leave the preceding writer's fence intact.
  const authority = claimOwnershipTx(db, identity);
  return createPendingOperation(db, input, authority);
}

function checkBeginOperation(db: Database, input: OperationSpec): BeginOperationResult | null {
  const existing = selectOperationRow(db, input.operationId);
  if (existing !== null) {
    if (matchesImmutableFields(existing, input)) {
      return { ok: true, created: false, record: rowToRecord(existing) };
    }
    return { ok: false, reason: "duplicate-conflict" };
  }
  const watermark = storedDesiredRevision(db);
  if (watermark !== null && input.desiredRevision < watermark) {
    return { ok: false, reason: "stale-revision" };
  }
  if (nonterminalOperationIdForModel(db, input.model) !== null) {
    return { ok: false, reason: "reservation-conflict" };
  }
  if (
    input.nodeBudgetGiB !== undefined &&
    nonterminalReservationGiB(db) + input.reservationGiB > input.nodeBudgetGiB
  ) {
    return { ok: false, reason: "reservation-exceeds-budget" };
  }
  return null;
}

function createPendingOperation(
  db: Database,
  input: OperationSpec,
  authority: Fence,
): BeginOperationResult {
  insertPendingOperation(db, input, authority);
  return { ok: true, created: true, record: pendingRecord(input, authority) };
}

function commitReservationTx(db: Database, input: MutationInput): MutationResult {
  const authority = readAuthority(db);
  if (authority?.fenceToken !== input.fenceToken) {
    return { ok: false, reason: "stale-fence" };
  }
  const row = selectOperationRow(db, input.operationId);
  if (row === null) {
    return { ok: false, reason: "not-found" };
  }
  if (row.phase !== "pending") {
    return { ok: false, reason: "illegal-phase" };
  }
  if (row.version !== input.expectedVersion) {
    return { ok: false, reason: "version-conflict" };
  }
  db.query(
    `UPDATE operations SET phase = 'committed', owner_id = ?, incarnation = ?, fence_token = ?, version = version + 1, updated_at_ms = ?
     WHERE operation_id = ?`,
  ).run(
    authority.ownerId,
    authority.incarnation,
    authority.fenceToken,
    input.nowMs,
    input.operationId,
  );
  return { ok: true };
}

function finishOperationTx(db: Database, input: FinishOperationInput): MutationResult {
  const authority = readAuthority(db);
  if (authority?.fenceToken !== input.fenceToken) {
    return { ok: false, reason: "stale-fence" };
  }
  const row = selectOperationRow(db, input.operationId);
  if (row === null) {
    return { ok: false, reason: "not-found" };
  }
  if (row.phase === "terminal") {
    return { ok: false, reason: "illegal-phase" };
  }
  if (row.version !== input.expectedVersion) {
    return { ok: false, reason: "version-conflict" };
  }
  db.query(
    `UPDATE operations SET phase = 'terminal', outcome = ?, detail = ?, owner_id = ?, incarnation = ?, fence_token = ?, version = version + 1, updated_at_ms = ?
     WHERE operation_id = ?`,
  ).run(
    input.outcome,
    input.detail ?? null,
    authority.ownerId,
    authority.incarnation,
    authority.fenceToken,
    input.nowMs,
    input.operationId,
  );
  return { ok: true };
}

// One statement, so it is atomic without an explicit transaction: the fence
// comparison and the write happen together. The follow-up read only names the
// refusal.
function touchOperationStmt(db: Database, input: TouchOperationInput): MutationResult {
  const changed = db
    .query(
      `UPDATE operations SET updated_at_ms = MAX(updated_at_ms, ?)
       WHERE operation_id = ? AND phase != 'terminal'
         AND EXISTS (SELECT 1 FROM authority WHERE id = 1 AND fence_token = ?)`,
    )
    .run(input.nowMs, input.operationId, input.fenceToken);
  if (changed.changes > 0) {
    return { ok: true };
  }
  const authority = readAuthority(db);
  if (authority?.fenceToken !== input.fenceToken) {
    return { ok: false, reason: "stale-fence" };
  }
  return { ok: false, reason: "not-found" };
}

function transitionResidencyStateTx(
  db: Database,
  input: TransitionResidencyStateInput,
): TransitionResidencyStateResult {
  const authority = readAuthority(db);
  if (authority?.fenceToken !== input.fenceToken) {
    return { ok: false, reason: "stale-fence" };
  }
  if (input.desiredRevision !== undefined) {
    const watermark = storedDesiredRevision(db);
    if (watermark !== null && input.desiredRevision < watermark) {
      return { ok: false, reason: "stale-revision" };
    }
  }
  const rows = listResidencyStateRows(db);
  const stored = rows.find((row) => row.model === input.model) ?? null;
  const currentVersion = stored?.version ?? 0;
  if (currentVersion !== input.expectedVersion) {
    return { ok: false, reason: "version-conflict" };
  }
  const currentState: ResidencyState = stored?.state ?? "unavailable";
  const storedGroup = stored?.group ?? undefined;
  if (
    input.group !== undefined &&
    input.group !== storedGroup &&
    isOccupyingResidencyState(currentState)
  ) {
    return { ok: false, reason: "group-conflict" };
  }
  const group = input.group ?? storedGroup;
  const members = buildMembers(rows, input.model, group, currentState);
  const decision = evaluateResidencyTransition({
    groups: input.groups ?? RESIDENCY_GROUPS,
    members,
    id: input.model,
    to: input.to,
  });
  if (!decision.ok) {
    return { ok: false, reason: "lifecycle-refused", decision };
  }
  return upsertState(db, input, authority, group, stored?.desiredRevision ?? null);
}

function buildMembers(
  rows: readonly ResidencyStateRecord[],
  targetId: string,
  targetGroup: string | undefined,
  targetState: ResidencyState,
): ResidencyMember[] {
  const members: ResidencyMember[] = rows
    .filter((row) => row.model !== targetId)
    .map((row) => rowToMember(row));
  members.push({
    id: targetId,
    ...(targetGroup !== undefined ? { group: targetGroup } : {}),
    state: targetState,
  });
  return members;
}

function rowToMember(row: ResidencyStateRecord): ResidencyMember {
  return {
    id: row.model,
    ...(row.group !== null ? { group: row.group } : {}),
    state: row.state,
  };
}

function upsertState(
  db: Database,
  input: TransitionResidencyStateInput,
  authority: Fence,
  group: string | undefined,
  previousRevision: number | null,
): TransitionResidencyStateResult {
  const version = input.expectedVersion + 1;
  const storedGroup = group ?? null;
  const inputRevision = input.desiredRevision ?? null;
  db.query(
    `INSERT INTO residency_states (model, residency_group, state, owner_id, incarnation, fence_token, version, updated_at_ms, desired_revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(model) DO UPDATE SET residency_group = excluded.residency_group, state = excluded.state, owner_id = excluded.owner_id, incarnation = excluded.incarnation, fence_token = excluded.fence_token, version = excluded.version, updated_at_ms = excluded.updated_at_ms, desired_revision = COALESCE(excluded.desired_revision, residency_states.desired_revision)`,
  ).run(
    input.model,
    storedGroup,
    input.to,
    authority.ownerId,
    authority.incarnation,
    authority.fenceToken,
    version,
    input.nowMs,
    inputRevision,
  );
  const resultingRevision = inputRevision ?? previousRevision;
  const record: ResidencyStateRecord = {
    model: input.model,
    group: storedGroup,
    state: input.to,
    ownerId: authority.ownerId,
    incarnation: authority.incarnation,
    fenceToken: authority.fenceToken,
    version,
    updatedAtMs: input.nowMs,
    ...(resultingRevision !== null ? { desiredRevision: resultingRevision } : {}),
  };
  return { ok: true, record };
}

function listResidencyStateRows(db: Database): ResidencyStateRecord[] {
  const rows = db
    .query(`SELECT ${RESIDENCY_STATE_COLUMNS} FROM residency_states ORDER BY model ASC`)
    .all() as ResidencyStateRow[];
  return rows.map((row) => parseResidencyStateRow(row));
}

// Read-only twin of listResidencyStateRows for the status snapshot (#517).
// Never migrates: a pre-#662 file has no residency_states table at all (read
// as empty), and a #662-era table predates desired_revision, so that column is
// selected only when present — the same shape listLeaseAuditRows uses.
function listResidencyStateRowsReadOnly(db: Database): ResidencyStateRecord[] {
  const table = db
    .query("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'residency_states'")
    .get() as { hit: number } | null;
  if (table === null) {
    return [];
  }
  const desiredRevision = hasColumn(db, "residency_states", "desired_revision")
    ? "desired_revision"
    : "NULL";
  const rows = db
    .query(
      `SELECT model, residency_group, state, owner_id, incarnation, fence_token, version, updated_at_ms, ${desiredRevision} AS desired_revision FROM residency_states ORDER BY model ASC`,
    )
    .all() as ResidencyStateRow[];
  return rows.map((row) => parseResidencyStateRow(row));
}

function selectResidencyStateRow(db: Database, model: string): ResidencyStateRow | null {
  return db
    .query(`SELECT ${RESIDENCY_STATE_COLUMNS} FROM residency_states WHERE model = ?`)
    .get(model) as ResidencyStateRow | null;
}

function parseResidencyStateRow(row: ResidencyStateRow): ResidencyStateRecord {
  if (!isResidencyState(row.state)) {
    throw new Error(`residency store row has unknown state ${row.state}`);
  }
  return {
    model: row.model,
    group: row.residency_group,
    state: row.state,
    ownerId: row.owner_id,
    incarnation: row.incarnation,
    fenceToken: row.fence_token,
    version: row.version,
    updatedAtMs: row.updated_at_ms,
    ...(row.desired_revision !== null ? { desiredRevision: row.desired_revision } : {}),
  };
}

function validateTransitionInput(
  input: TransitionResidencyStateInput,
): ResidencyStoreFailure | null {
  if (!isNonEmpty(input.model)) {
    return "invalid-input";
  }
  if (!isResidencyState(input.to)) {
    return "invalid-input";
  }
  if (!isFenceToken(input.fenceToken)) {
    return "invalid-input";
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    return "invalid-input";
  }
  if (input.group !== undefined && !isNonEmpty(input.group)) {
    return "invalid-input";
  }
  if (
    input.desiredRevision !== undefined &&
    !(Number.isInteger(input.desiredRevision) && input.desiredRevision >= 0)
  ) {
    return "invalid-input";
  }
  return null;
}

function listNonterminalRows(db: Database): ResidencyOperationRecord[] {
  const rows = db
    .query(
      `SELECT ${OPERATION_COLUMNS} FROM operations WHERE phase != 'terminal' ORDER BY created_at_ms ASC, operation_id ASC`,
    )
    .all() as OperationRow[];
  return rows.map((row) => rowToRecord(row));
}

function selectOperationRow(db: Database, operationId: string): OperationRow | null {
  return db
    .query(`SELECT ${OPERATION_COLUMNS} FROM operations WHERE operation_id = ?`)
    .get(operationId) as OperationRow | null;
}

function nonterminalOperationIdForModel(db: Database, model: string): string | null {
  const row = db
    .query("SELECT operation_id FROM operations WHERE model = ? AND phase != 'terminal' LIMIT 1")
    .get(model) as { operation_id: string } | null;
  return row?.operation_id ?? null;
}

// The store is node-local, so this sum over nonterminal operations (pending
// and committed, never terminal) is the node's held reservation.
function nonterminalReservationGiB(db: Database): number {
  const row = db
    .query(
      "SELECT COALESCE(SUM(reservation_gib), 0) AS total FROM operations WHERE phase != 'terminal'",
    )
    .get() as { total: number } | null;
  return row?.total ?? 0;
}

// Shared desired-revision watermark: the max over every operation (all phases,
// including terminal) and every residency row. Owner and fence are ignored.
function storedDesiredRevision(db: Database): number | null {
  const operations = db
    .query("SELECT MAX(desired_revision) AS watermark FROM operations")
    .get() as { watermark: number | null } | null;
  const states = db
    .query("SELECT MAX(desired_revision) AS watermark FROM residency_states")
    .get() as { watermark: number | null } | null;
  const candidates = [operations?.watermark ?? null, states?.watermark ?? null];
  let watermark: number | null = null;
  for (const candidate of candidates) {
    if (candidate !== null && (watermark === null || candidate > watermark)) {
      watermark = candidate;
    }
  }
  return watermark;
}

function insertPendingOperation(db: Database, input: OperationSpec, authority: Fence): void {
  db.query(
    `INSERT INTO operations (operation_id, model, target_state, desired_revision, reservation_gib, phase, outcome, detail, owner_id, incarnation, fence_token, version, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?, 1, ?, ?)`,
  ).run(
    input.operationId,
    input.model,
    input.targetState,
    input.desiredRevision,
    input.reservationGiB,
    authority.ownerId,
    authority.incarnation,
    authority.fenceToken,
    input.nowMs,
    input.nowMs,
  );
}

function pendingRecord(input: OperationSpec, authority: Fence): ResidencyOperationRecord {
  return {
    operationId: input.operationId,
    model: input.model,
    targetState: input.targetState,
    desiredRevision: input.desiredRevision,
    reservationGiB: input.reservationGiB,
    phase: "pending",
    outcome: null,
    detail: null,
    ownerId: authority.ownerId,
    incarnation: authority.incarnation,
    fenceToken: authority.fenceToken,
    version: 1,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
  };
}

function rowToRecord(row: OperationRow): ResidencyOperationRecord {
  return {
    operationId: row.operation_id,
    model: row.model,
    targetState: row.target_state,
    desiredRevision: row.desired_revision,
    reservationGiB: row.reservation_gib,
    phase: parsePhase(row.phase),
    outcome: parseOutcome(row.outcome),
    detail: row.detail,
    ownerId: row.owner_id,
    incarnation: row.incarnation,
    fenceToken: row.fence_token,
    version: row.version,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function parsePhase(value: string): ResidencyOperationPhase {
  if (isPhase(value)) {
    return value;
  }
  throw new Error(`residency store row has unknown phase ${value}`);
}

function parseOutcome(value: string | null): ResidencyOperationOutcome | null {
  if (value === null) {
    return null;
  }
  if (isOutcome(value)) {
    return value;
  }
  throw new Error(`residency store row has unknown outcome ${value}`);
}

function isPhase(value: string): value is ResidencyOperationPhase {
  return (PHASES as readonly string[]).includes(value);
}

function isOutcome(value: string): value is ResidencyOperationOutcome {
  return (OUTCOMES as readonly string[]).includes(value);
}

function matchesImmutableFields(row: OperationRow, input: OperationSpec): boolean {
  return (
    row.model === input.model &&
    row.target_state === input.targetState &&
    row.desired_revision === input.desiredRevision &&
    row.reservation_gib === input.reservationGiB
  );
}

function validateBeginInput(input: BeginOperationInput): ResidencyStoreFailure | null {
  return isFenceToken(input.fenceToken) ? validateOperationSpec(input) : "invalid-input";
}

function validateOperationSpec(input: OperationSpec): ResidencyStoreFailure | null {
  if (
    !isNonEmpty(input.operationId) ||
    !isNonEmpty(input.model) ||
    !isNonEmpty(input.targetState)
  ) {
    return "invalid-input";
  }
  if (!Number.isFinite(input.reservationGiB) || input.reservationGiB < 0) {
    return "invalid-input";
  }
  if (!Number.isInteger(input.desiredRevision) || input.desiredRevision < 0) {
    return "invalid-input";
  }
  if (
    input.nodeBudgetGiB !== undefined &&
    !(Number.isFinite(input.nodeBudgetGiB) && input.nodeBudgetGiB >= 0)
  ) {
    return "invalid-input";
  }
  return null;
}

function validateFinishInput(input: FinishOperationInput): ResidencyStoreFailure | null {
  const invalid = validateMutationInput(input);
  if (invalid !== null) {
    return invalid;
  }
  if (!isOutcome(input.outcome)) {
    return "invalid-input";
  }
  return null;
}

function validateMutationInput(input: MutationInput): ResidencyStoreFailure | null {
  if (!isNonEmpty(input.operationId)) {
    return "invalid-input";
  }
  if (!isFenceToken(input.fenceToken)) {
    return "invalid-input";
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    return "invalid-input";
  }
  return null;
}

function isFenceToken(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

function isNonEmpty(value: string): boolean {
  return value.length > 0;
}
