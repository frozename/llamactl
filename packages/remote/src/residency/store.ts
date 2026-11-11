// Node-local fenced operation storage for the residency planner (#276, DF-03).
//
// The SQLite file must live on node-local disk: it must never sit on a
// network filesystem, where SQLite locking cannot be trusted and the fence
// below silently rots. The fence token is monotonic — every claimOwnership
// bumps it — and any mutation carrying a fenceToken that differs from the
// stored one fails closed as stale-fence.
//
// Lifecycle-edge legality is the caller's job (#573/#517): this store
// enforces phase shape and compare-and-set ordering only, never which phase
// transitions the residency policy allows.
//
// reservationGiB is recorded, not admitted: nothing here checks the value
// against a node memory budget — that is the job of #274 and the #276
// follow-ups.
import { llamactlHome } from "@llamactl/core/config/env";
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";

import { existsSync, mkdirSync } from "../safe-fs.js";

const SCHEMA_VERSION = 1;

const PHASES = ["pending", "committed", "terminal"] as const;
const OUTCOMES = ["succeeded", "failed", "cancelled", "unknown"] as const;

export type ResidencyOperationPhase = (typeof PHASES)[number];
export type ResidencyOperationOutcome = (typeof OUTCOMES)[number];

export type ResidencyStoreFailure =
  | "duplicate-conflict"
  | "illegal-phase"
  | "invalid-input"
  | "not-found"
  | "reservation-conflict"
  | "stale-fence"
  | "version-conflict";

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

type BeginOperationInput = {
  fenceToken: number;
  operationId: string;
  model: string;
  targetState: string;
  desiredRevision: number;
  reservationGiB: number;
  nowMs: number;
};

type MutationInput = {
  fenceToken: number;
  operationId: string;
  expectedVersion: number;
  nowMs: number;
};

type FinishOperationInput = MutationInput & {
  outcome: ResidencyOperationOutcome;
  detail?: string;
};

type BeginOperationResult =
  | { ok: true; created: boolean; record: ResidencyOperationRecord }
  | { ok: false; reason: ResidencyStoreFailure };

type MutationResult = { ok: true } | { ok: false; reason: ResidencyStoreFailure };

export type ResidencyOperationStore = {
  claimOwnership: (input: ClaimInput) => Fence;
  currentFence: () => Fence | null;
  beginOperation: (input: BeginOperationInput) => BeginOperationResult;
  commitReservation: (input: MutationInput) => MutationResult;
  finishOperation: (input: FinishOperationInput) => MutationResult;
  getOperation: (operationId: string) => ResidencyOperationRecord | null;
  listNonterminal: () => ResidencyOperationRecord[];
  close: () => void;
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

const OPERATION_COLUMNS =
  "operation_id, model, target_state, desired_revision, reservation_gib, phase, " +
  "outcome, detail, owner_id, incarnation, fence_token, version, created_at_ms, updated_at_ms";

export function openResidencyOperationStore(input: { path: string }): ResidencyOperationStore {
  const db = openDb(input.path);
  const claimTx = db.transaction(
    (claimInput: ClaimInput): Fence => claimOwnershipTx(db, claimInput),
  );
  const beginTx = db.transaction(
    (beginInput: BeginOperationInput): BeginOperationResult => beginOperationTx(db, beginInput),
  );
  const commitTx = db.transaction(
    (mutationInput: MutationInput): MutationResult => commitReservationTx(db, mutationInput),
  );
  const finishTx = db.transaction(
    (finishInput: FinishOperationInput): MutationResult => finishOperationTx(db, finishInput),
  );
  const store: ResidencyOperationStore = {
    beginOperation: (beginInput) => {
      const invalid = validateBeginInput(beginInput);
      if (invalid !== null) {
        return { ok: false, reason: invalid };
      }
      return beginTx.immediate(beginInput);
    },
    claimOwnership: (claimInput) => {
      if (!isNonEmpty(claimInput.ownerId) || !isNonEmpty(claimInput.incarnation)) {
        throw new Error("claimOwnership requires a non-empty ownerId and incarnation");
      }
      return claimTx.immediate(claimInput);
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
      if (row === null) {
        return null;
      }
      return rowToRecord(row);
    },
    listNonterminal: () => listNonterminalRows(db),
  };
  return store;
}

function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 15000");
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
  | { path: string; present: true; nonterminal: ResidencyOperationRecord[] }
  | { path: string; present: true; error: string };

// Read-only view of an existing store. Never mkdir, never set journal_mode,
// never migrate, never claim ownership — a status read must leave the file
// byte-identical. Opened readonly but NOT immutable: immutable=1 skips the
// WAL, so rows a live writer has not checkpointed yet would go unseen.
export function readResidencyStoreSnapshot(path: string): ResidencyStoreSnapshot {
  if (!existsSync(path)) {
    return { path, present: false };
  }
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    db.run("PRAGMA busy_timeout = 15000");
    return { path, present: true, nonterminal: listNonterminalRows(db) };
  } catch (error: unknown) {
    return { path, present: true, error: (error as Error).message };
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
  if (stored.version > SCHEMA_VERSION) {
    throw new Error(
      `residency store schema_version ${String(stored.version)} is newer than supported ${String(SCHEMA_VERSION)}`,
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
  const existing = selectOperationRow(db, input.operationId);
  if (existing !== null) {
    if (matchesImmutableFields(existing, input)) {
      return { ok: true, created: false, record: rowToRecord(existing) };
    }
    return { ok: false, reason: "duplicate-conflict" };
  }
  if (hasNonterminalForModel(db, input.model)) {
    return { ok: false, reason: "reservation-conflict" };
  }
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

function hasNonterminalForModel(db: Database, model: string): boolean {
  const hit = db
    .query("SELECT 1 AS hit FROM operations WHERE model = ? AND phase != 'terminal' LIMIT 1")
    .get(model) as { hit: number } | null;
  return hit !== null;
}

function insertPendingOperation(db: Database, input: BeginOperationInput, authority: Fence): void {
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

function pendingRecord(input: BeginOperationInput, authority: Fence): ResidencyOperationRecord {
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

function matchesImmutableFields(row: OperationRow, input: BeginOperationInput): boolean {
  return (
    row.model === input.model &&
    row.target_state === input.targetState &&
    row.desired_revision === input.desiredRevision &&
    row.reservation_gib === input.reservationGiB
  );
}

function validateBeginInput(input: BeginOperationInput): ResidencyStoreFailure | null {
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
  if (!isFenceToken(input.fenceToken)) {
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
