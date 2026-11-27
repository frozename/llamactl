import type { GenerationRecord } from "@llamactl/core/residency/generation-evidence";

/**
 * Target-owned managed-admission authority store (plan v3, "Store" package).
 * Tests live in test/residency/admission-store.test.ts.
 *
 * One durable SQLite ledger per canonical runtime root. `claim` runs the
 * read → evaluateManagedAdmission → insert-pending → commit pipeline inside
 * a single synchronous BEGIN IMMEDIATE transaction; no await, probe or spawn
 * occurs inside it. Pending, resident and uncertain rows all charge against
 * the caller-supplied budget.
 *
 * Ownership: opening another connection never rotates the owner epoch (a
 * persisted counter that only ever increases) and never sweeps pending
 * rows. An owning open records its owner only on a vacant ledger — still
 * with no rotation and no sweep. Only recoverOwnership, invoked after the
 * caller verifies the previous owner is gone, may rotate the epoch and
 * convert orphan pending rows to uncertain. A second live owner is refused
 * rather than stolen from. The persisted authorityId never changes for a
 * file.
 *
 * Fencing: each row carries an opaque fenceToken bound to
 * (claimId, ownerEpoch, generationVersion). Every successful CAS mutation
 * rotates it, so a stale or foreign token is rejected without mutation.
 *
 * Generations: captured process identities persist keyed by claim_id in
 * the same transaction family as the claim transitions. recordGeneration
 * appends under the fence check without rotating the token;
 * releaseVerified deletes them with the claim; reopen and recovery keep
 * them.
 *
 * Fails closed (#383): a failed ledger read, a stored state or kind
 * outside the enums, and a file that fails PRAGMA quick_check at open all
 * surface as AuthorityUnavailableError — never a silently empty snapshot,
 * a default-mapped state, or an adopted corrupt file.
 */
import {
  evaluateManagedAdmission,
  type ManagedAdmissionClaim,
  type ManagedAdmissionRefuseReason,
  type ManagedWorkloadKind,
} from "@llamactl/core/residency/admission";
import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";

export type ClaimState = "pending" | "resident" | "uncertain";

export interface ClaimRow {
  claimId: string;
  runtimeKey: string;
  specDigest: string;
  kind?: ManagedWorkloadKind;
  state: ClaimState;
  allocationGiB: number;
  ownerEpoch: number;
  generationVersion: number;
  fenceToken: string;
}

export type ClaimRefuseReason =
  | ManagedAdmissionRefuseReason
  | "AuthorityUnavailable"
  | "InvalidKind";

export type OwnerIdentity = GenerationRecord;
export type { GenerationRecord };

export interface InspectedOwnership {
  epoch: number;
  owner: OwnerIdentity | undefined;
}

export type RecoverOwnershipResult =
  | { kind: "recovered"; epoch: number }
  | { kind: "refused"; reason: "OwnerLive" | "OwnerUnknown" | "OwnerChanged" };

export type ClaimResult =
  | {
      kind: "admitted";
      claimId: string;
      fenceToken: string;
      chargedGiB: number;
      /** Committed total after charging this claim. */
      committedGiB: number;
    }
  | { kind: "join-pending"; claimId: string }
  | { kind: "already-resident"; claimId: string }
  | { kind: "refuse"; reason: ClaimRefuseReason; detail: string };

export class AuthorityUnavailableError extends Error {
  readonly code = "AuthorityUnavailable" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthorityUnavailable";
  }
}

export interface ClaimInput {
  runtimeKey: string;
  specDigest: string;
  kind?: ManagedWorkloadKind;
  allocationGiB: number;
  budgetGiB: number;
}

export interface ReleaseEvidence {
  /** Whole-runtime absence proof produced by the target-owned observer. */
  verification: "runtime-absent";
  generationVersion: number;
  observedAt?: number;
}

export interface AdmissionStore {
  /** Persisted id of this ledger. Stable across reopen of the same file. */
  authorityId(): string;
  /** Owner epoch of this connection. Rotates only through recoverOwnership. */
  epoch(): number;
  /** Owner recorded in the ledger, if any. */
  recordedOwner(): OwnerIdentity | undefined;
  /** Read the owner and epoch in a single snapshot, or null on an unavailable ledger. */
  inspectOwnership(): InspectedOwnership | null;
  /**
   * Explicit authority recovery — the sole epoch rotation and orphan sweep.
   * In one BEGIN IMMEDIATE, compare the inspected owner and epoch. If unchanged
   * and vacant or verified gone, record `owner`, rotate the epoch and convert
   * every pending row to uncertain with a fresh fence token each; otherwise
   * refuse without mutating anything. Whether the previous owner is gone is
   * judged by the caller outside this transaction.
   */
  recoverOwnership(
    owner: OwnerIdentity,
    previousOwnerGone: boolean,
    inspected: InspectedOwnership,
  ): RecoverOwnershipResult;
  /**
   * Atomic check-and-insert of a pending claim. Never throws for a refusal:
   * busy/lock contention, a closed store and invalid input all return
   * {kind:"refuse"} — refused before effects. Pending rows owned by other
   * epochs are NOT converted here — the recovery sweep is the only orphan
   * conversion point, so a second live connection can still join them.
   */
  claim(input: ClaimInput): ClaimResult;
  /** CAS pending→resident. Rotates the row's fenceToken on success. */
  commitResident(claimId: string, fenceToken: string): boolean;
  /** CAS pending→uncertain. Rotates the row's fenceToken on success. */
  markUncertain(claimId: string, fenceToken: string): boolean;
  /** Delete a pristine reservation after the trusted caller proves it never started. */
  abandonUnstarted(claimId: string, fenceToken: string): boolean;
  /**
   * Append one captured generation to the claim's persisted evidence. The
   * fence token still drives the subsequent CAS transitions. Increment the
   * generation version so any concurrent release proof is invalidated.
   */
  recordGeneration(claimId: string, fenceToken: string, generation: GenerationRecord): boolean;
  /**
   * CAS delete a settled claim against the proved generation version. Its
   * generation rows are deleted in the same transaction.
   */
  releaseVerified(claimId: string, fenceToken: string, evidence: ReleaseEvidence): boolean;
  /**
   * Detached copies; mutating them never changes stored state. A failed
   * read, or a stored state or kind outside the enums, throws
   * AuthorityUnavailableError — never a silently empty ledger.
   */
  snapshot(): readonly ClaimRow[];
  /** Detached generation rows for the claim, oldest first; empty when none. */
  generationsOf(claimId: string): readonly GenerationRecord[];
  /** Idempotent. Calls after close refuse/return false rather than write. */
  close(): void;
}

const defaultBusyTimeoutMs = 5_000;

interface ClaimRecord {
  claim_id: string;
  runtime_key: string;
  spec_digest: string;
  kind: string | null;
  state: string;
  allocation_gib: number;
  owner_epoch: number;
  generation_version: number;
  fence_token: string;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const newFenceToken = (): string => randomBytes(32).toString("hex");

const isManagedWorkloadKind = (value: unknown): value is ManagedWorkloadKind =>
  value === "ModelRun" || value === "ModelHost";

const asKind = (value: string | null): ManagedWorkloadKind | undefined => {
  if (value === null) {
    return undefined;
  }
  if (isManagedWorkloadKind(value)) {
    return value;
  }
  throw new AuthorityUnavailableError(
    `admission ledger corruption: stored kind ${value} is outside ManagedWorkloadKind`,
  );
};

const asState = (value: string): ClaimState => {
  if (value === "pending" || value === "resident" || value === "uncertain") {
    return value;
  }
  throw new AuthorityUnavailableError(
    `admission ledger corruption: stored state ${value} is outside ClaimState`,
  );
};

function toPolicyClaim(record: ClaimRecord): ManagedAdmissionClaim {
  const claim: ManagedAdmissionClaim = {
    claimId: record.claim_id,
    runtimeKey: record.runtime_key,
    specDigest: record.spec_digest,
    state: asState(record.state),
    allocationGiB: record.allocation_gib,
  };
  const kind = asKind(record.kind);
  return kind === undefined ? claim : { ...claim, kind };
}

function toClaimRow(record: ClaimRecord): ClaimRow {
  const row: ClaimRow = {
    claimId: record.claim_id,
    runtimeKey: record.runtime_key,
    specDigest: record.spec_digest,
    state: asState(record.state),
    allocationGiB: record.allocation_gib,
    ownerEpoch: record.owner_epoch,
    generationVersion: record.generation_version,
    fenceToken: record.fence_token,
  };
  const kind = asKind(record.kind);
  return kind === undefined ? row : { ...row, kind };
}

function incomingOf(input: ClaimInput): {
  runtimeKey: string;
  specDigest: string;
  allocationGiB: number;
  kind?: ManagedWorkloadKind;
} {
  const incoming = {
    runtimeKey: input.runtimeKey,
    specDigest: input.specDigest,
    allocationGiB: input.allocationGiB,
  };
  return input.kind === undefined ? incoming : { ...incoming, kind: input.kind };
}

function readClaimRecords(db: Database): ClaimRecord[] {
  return db
    .query<ClaimRecord, []>(
      `SELECT claim_id, runtime_key, spec_digest, kind, state, allocation_gib,
              owner_epoch, generation_version, fence_token
       FROM claims ORDER BY rowid`,
    )
    .all();
}

function ensureSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS authority_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    authority_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    owner_pid INTEGER,
    owner_start_time_ms INTEGER,
    owner_executable TEXT,
    owner_birth_id TEXT
  )`);
  const columns = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(authority_meta)")
      .all()
      .map((c) => c.name),
  );
  if (!columns.has("owner_pid")) {
    db.run("ALTER TABLE authority_meta ADD COLUMN owner_pid INTEGER");
  }
  if (!columns.has("owner_start_time_ms")) {
    db.run("ALTER TABLE authority_meta ADD COLUMN owner_start_time_ms INTEGER");
  }
  if (!columns.has("owner_executable")) {
    db.run("ALTER TABLE authority_meta ADD COLUMN owner_executable TEXT");
  }
  if (!columns.has("owner_birth_id")) {
    db.run("ALTER TABLE authority_meta ADD COLUMN owner_birth_id TEXT");
  }
  db.run(`CREATE TABLE IF NOT EXISTS claims (
    claim_id TEXT PRIMARY KEY,
    runtime_key TEXT NOT NULL,
    spec_digest TEXT NOT NULL,
    kind TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'resident', 'uncertain')),
    allocation_gib REAL NOT NULL,
    owner_epoch INTEGER NOT NULL,
    generation_version INTEGER NOT NULL,
    fence_token TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS claim_generations (
    claim_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    start_time_ms INTEGER,
    executable TEXT,
    birth_id TEXT,
    PRIMARY KEY (claim_id, seq)
  )`);
  const generationColumns = db
    .query<{ name: string }, []>("PRAGMA table_info(claim_generations)")
    .all();
  if (!generationColumns.some((column) => column.name === "birth_id")) {
    db.run("ALTER TABLE claim_generations ADD COLUMN birth_id TEXT");
  }
}

function initAuthority(db: Database): { authorityId: string; epoch: number } {
  const existing = db
    .query<
      { authority_id: string; epoch: number },
      []
    >("SELECT authority_id, epoch FROM authority_meta WHERE id = 1")
    .get();
  if (existing === null) {
    const authorityId = randomUUID();
    db.run("INSERT INTO authority_meta (id, authority_id, epoch) VALUES (1, ?, 1)", [authorityId]);
    return { authorityId, epoch: 1 };
  }
  return { authorityId: existing.authority_id, epoch: existing.epoch };
}

interface OwnerRecord {
  epoch: number;
  owner_pid: number | null;
  owner_start_time_ms: number | null;
  owner_executable: string | null;
  owner_birth_id: string | null;
}

function readOwnerRecord(db: Database): OwnerRecord | null {
  return db
    .query<OwnerRecord, []>(
      `SELECT epoch, owner_pid, owner_start_time_ms, owner_executable, owner_birth_id
         FROM authority_meta WHERE id = 1`,
    )
    .get();
}

function toOwnerIdentity(record: OwnerRecord | null): OwnerIdentity | undefined {
  const ownerPid = record?.owner_pid ?? null;
  const startTimeMs = record?.owner_start_time_ms ?? null;
  const executable = record?.owner_executable ?? null;
  const birthId = record?.owner_birth_id ?? null;
  if (ownerPid === null) {
    return undefined;
  }
  return {
    pid: ownerPid,
    ...(startTimeMs === null ? {} : { startTimeMs }),
    ...(executable === null ? {} : { executable }),
    ...(birthId === null ? {} : { birthId }),
  };
}

function isInspectedOwner(record: OwnerRecord, inspected: OwnerIdentity | undefined): boolean {
  return (
    record.owner_pid === (inspected?.pid ?? null) &&
    record.owner_start_time_ms === (inspected?.startTimeMs ?? null) &&
    record.owner_executable === (inspected?.executable ?? null) &&
    record.owner_birth_id === (inspected?.birthId ?? null)
  );
}

function stakeOwner(db: Database, owner: OwnerIdentity): void {
  db.run(
    `UPDATE authority_meta
        SET owner_pid = ?, owner_start_time_ms = ?, owner_executable = ?, owner_birth_id = ?
      WHERE id = 1 AND owner_pid IS NULL`,
    [owner.pid, owner.startTimeMs ?? null, owner.executable ?? null, owner.birthId ?? null],
  );
}

const resolveBusyTimeoutMs = (requested: number | undefined): number =>
  requested !== undefined && Number.isFinite(requested) && requested >= 0
    ? Math.trunc(requested)
    : defaultBusyTimeoutMs;

class SqliteAdmissionStore implements AdmissionStore {
  #db: Database | null;
  readonly #authorityId: string;
  #epoch: number;

  constructor(db: Database, authorityId: string, epoch: number) {
    this.#db = db;
    this.#authorityId = authorityId;
    this.#epoch = epoch;
  }

  authorityId(): string {
    return this.#authorityId;
  }

  epoch(): number {
    return this.#epoch;
  }

  recordedOwner(): OwnerIdentity | undefined {
    return this.inspectOwnership()?.owner;
  }

  inspectOwnership(): InspectedOwnership | null {
    const db = this.#db;
    if (db === null) {
      return null;
    }
    try {
      const record = readOwnerRecord(db);
      return record === null ? null : { epoch: record.epoch, owner: toOwnerIdentity(record) };
    } catch {
      return null;
    }
  }

  recoverOwnership(
    owner: OwnerIdentity,
    previousOwnerGone: boolean,
    inspected: InspectedOwnership,
  ): RecoverOwnershipResult {
    const db = this.#db;
    if (db === null) {
      return { kind: "refused", reason: "OwnerUnknown" };
    }
    try {
      const recovered = db
        .transaction(() => this.#recoverUnderWriteLock(db, owner, previousOwnerGone, inspected))
        .immediate();
      if (recovered.kind === "recovered") this.#epoch = recovered.epoch;
      return recovered;
    } catch {
      return { kind: "refused", reason: "OwnerUnknown" };
    }
  }

  #recoverUnderWriteLock(
    db: Database,
    owner: OwnerIdentity,
    previousOwnerGone: boolean,
    inspected: InspectedOwnership,
  ): RecoverOwnershipResult {
    const recorded = readOwnerRecord(db);
    if (recorded === null) return { kind: "refused", reason: "OwnerUnknown" };
    if (recorded.epoch !== inspected.epoch || !isInspectedOwner(recorded, inspected.owner)) {
      return { kind: "refused", reason: "OwnerChanged" };
    }
    if (recorded.owner_pid !== null && !previousOwnerGone) {
      return { kind: "refused", reason: "OwnerLive" };
    }
    const epoch = recorded.epoch + 1;
    db.run(
      `UPDATE authority_meta
          SET epoch = ?, owner_pid = ?, owner_start_time_ms = ?, owner_executable = ?, owner_birth_id = ?
        WHERE id = 1`,
      [
        epoch,
        owner.pid,
        owner.startTimeMs ?? null,
        owner.executable ?? null,
        owner.birthId ?? null,
      ],
    );
    const pendingRows = db
      .query<{ claim_id: string }, []>("SELECT claim_id FROM claims WHERE state = 'pending'")
      .all();
    for (const row of pendingRows) {
      db.run(
        `UPDATE claims
            SET state = 'uncertain', fence_token = ?, generation_version = generation_version + 1
          WHERE claim_id = ? AND state = 'pending'`,
        [newFenceToken(), row.claim_id],
      );
    }
    return { kind: "recovered", epoch };
  }

  #writeCurrentEpoch<T>(db: Database, refused: T, write: () => T): T {
    return db
      .transaction(() => {
        if (readOwnerRecord(db)?.epoch !== this.#epoch) return refused;
        return write();
      })
      .immediate();
  }

  claim(input: ClaimInput): ClaimResult {
    const db = this.#db;
    if (db === null) {
      return {
        kind: "refuse",
        reason: "AuthorityUnavailable",
        detail: "admission store is closed",
      };
    }
    const kind: unknown = input.kind;
    if (kind !== undefined && !isManagedWorkloadKind(kind)) {
      const shown = typeof kind === "string" ? kind : errText(kind);
      return {
        kind: "refuse",
        reason: "InvalidKind",
        detail: `workload kind ${shown} is outside ManagedWorkloadKind`,
      };
    }
    try {
      return this.#writeCurrentEpoch<ClaimResult>(
        db,
        {
          kind: "refuse",
          reason: "AuthorityUnavailable",
          detail: "admission authority ownership changed",
        },
        () => this.#claimUnderWriteLock(db, input),
      );
    } catch (e) {
      return {
        kind: "refuse",
        reason: "AuthorityUnavailable",
        detail: `admission authority busy or unavailable: ${errText(e)}`,
      };
    }
  }

  commitResident(claimId: string, fenceToken: string): boolean {
    return this.#cas(claimId, fenceToken, "pending", "resident");
  }

  markUncertain(claimId: string, fenceToken: string): boolean {
    return this.#cas(claimId, fenceToken, "pending", "uncertain");
  }

  abandonUnstarted(claimId: string, fenceToken: string): boolean {
    const db = this.#db;
    if (db === null) return false;
    try {
      return this.#writeCurrentEpoch(db, false, () => {
        const deleted = db.run(
          `DELETE FROM claims
            WHERE claim_id = ? AND fence_token = ? AND state = 'pending'
              AND generation_version = 1
              AND NOT EXISTS (SELECT 1 FROM claim_generations WHERE claim_id = claims.claim_id)`,
          [claimId, fenceToken],
        );
        return deleted.changes === 1;
      });
    } catch {
      return false;
    }
  }

  releaseVerified(claimId: string, fenceToken: string, evidence: ReleaseEvidence): boolean {
    const db = this.#db;
    if (db === null) {
      return false;
    }
    try {
      return this.#writeCurrentEpoch(db, false, () => {
        const deleted = db.run(
          `DELETE FROM claims
            WHERE claim_id = ? AND fence_token = ? AND generation_version = ? AND state != 'pending'`,
          [claimId, fenceToken, evidence.generationVersion],
        );
        if (deleted.changes !== 1) return false;
        db.run("DELETE FROM claim_generations WHERE claim_id = ?", [claimId]);
        return true;
      });
    } catch {
      return false;
    }
  }

  recordGeneration(claimId: string, fenceToken: string, generation: GenerationRecord): boolean {
    const db = this.#db;
    if (db === null) {
      return false;
    }
    try {
      return this.#writeCurrentEpoch(db, false, () => {
        const updated = db.run(
          `UPDATE claims SET generation_version = generation_version + 1
            WHERE claim_id = ? AND fence_token = ?`,
          [claimId, fenceToken],
        );
        if (updated.changes !== 1) return false;
        const maxSeq = db
          .prepare("SELECT MAX(seq) AS max_seq FROM claim_generations WHERE claim_id = ?")
          .get(claimId) as { max_seq: number | null } | null;
        const nextSeq = (maxSeq?.max_seq ?? 0) + 1;
        db.run(
          "INSERT INTO claim_generations (claim_id, seq, pid, start_time_ms, executable, birth_id) VALUES (?, ?, ?, ?, ?, ?)",
          [
            claimId,
            nextSeq,
            generation.pid,
            generation.startTimeMs ?? null,
            generation.executable ?? null,
            generation.birthId ?? null,
          ],
        );
        return true;
      });
    } catch {
      return false;
    }
  }

  generationsOf(claimId: string): readonly GenerationRecord[] {
    const db = this.#db;
    if (db === null) {
      return [];
    }
    try {
      const rows = db
        .prepare<
          {
            seq: number;
            pid: number;
            start_time_ms: number | null;
            executable: string | null;
            birth_id: string | null;
          },
          [string]
        >(
          "SELECT seq, pid, start_time_ms, executable, birth_id FROM claim_generations WHERE claim_id = ? ORDER BY seq",
        )
        .all(claimId);
      return rows.map((row) => ({
        pid: row.pid,
        ...(row.start_time_ms === null ? {} : { startTimeMs: row.start_time_ms }),
        ...(row.executable === null ? {} : { executable: row.executable }),
        ...(row.birth_id === null ? {} : { birthId: row.birth_id }),
      }));
    } catch {
      return [];
    }
  }

  snapshot(): readonly ClaimRow[] {
    const db = this.#db;
    if (db === null) {
      return [];
    }
    try {
      return readClaimRecords(db).map(toClaimRow);
    } catch (e) {
      if (e instanceof AuthorityUnavailableError) {
        throw e;
      }
      throw new AuthorityUnavailableError(`admission ledger read failed: ${errText(e)}`, {
        cause: e,
      });
    }
  }

  close(): void {
    const db = this.#db;
    if (db === null) {
      return;
    }
    this.#db = null;
    try {
      db.close();
    } catch {
      // close is best-effort; a handle SQLite already dropped stays dropped.
    }
  }

  #claimUnderWriteLock(db: Database, input: ClaimInput): ClaimResult {
    const decision = evaluateManagedAdmission({
      budgetGiB: input.budgetGiB,
      claims: readClaimRecords(db).map(toPolicyClaim),
      incoming: incomingOf(input),
    });
    if (decision.kind !== "admit") {
      return decision.kind === "refuse"
        ? { kind: "refuse", reason: decision.reason, detail: decision.detail }
        : { kind: decision.kind, claimId: decision.claimId };
    }
    const claimId = randomUUID();
    const fenceToken = newFenceToken();
    db.run(
      `INSERT INTO claims (claim_id, runtime_key, spec_digest, kind, state,
                           allocation_gib, owner_epoch, generation_version, fence_token)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, 1, ?)`,
      [
        claimId,
        input.runtimeKey,
        input.specDigest,
        input.kind ?? null,
        input.allocationGiB,
        this.#epoch,
        fenceToken,
      ],
    );
    return {
      kind: "admitted",
      claimId,
      fenceToken,
      chargedGiB: decision.chargedGiB,
      committedGiB: decision.committedGiB,
    };
  }

  #cas(claimId: string, fenceToken: string, from: ClaimState, to: ClaimState): boolean {
    const db = this.#db;
    if (db === null) {
      return false;
    }
    try {
      return this.#writeCurrentEpoch(db, false, () => {
        const result = db.run(
          `UPDATE claims
              SET state = ?, fence_token = ?, generation_version = generation_version + 1
            WHERE claim_id = ? AND fence_token = ? AND state = ?`,
          [to, newFenceToken(), claimId, fenceToken, from],
        );
        return result.changes === 1;
      });
    } catch {
      return false;
    }
  }
}

/** SQLite application_id stamped on every admission store ("LMAD"). */
const ADMISSION_APPLICATION_ID = 0x4c4d4144;
const ADMISSION_SCHEMA_VERSION = 2;

/**
 * Refuse a file whose pages fail PRAGMA quick_check before the open path
 * writes anything to it. Malformed pages can throw out of the pragma
 * itself or surface as error rows; neither may be adopted.
 */
function assertQuickCheck(db: Database): void {
  let rows: { quick_check: string }[];
  try {
    rows = db.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
  } catch (e) {
    throw new AuthorityUnavailableError(`integrity check failed: ${errText(e)}`, { cause: e });
  }
  const verdict = rows.map((r) => r.quick_check).join("; ");
  if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
    throw new AuthorityUnavailableError(`integrity check failed: ${verdict}`);
  }
}

function validateAndStampSchema(
  db: Database,
  expectedApplicationId: number,
  expectedSchemaVersion: number,
): void {
  const application_id =
    db.query<{ application_id: number }, []>("PRAGMA application_id").get()?.application_id ?? 0;
  const user_version =
    db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  const tableNames = db
    .query<
      { name: string },
      []
    >("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  const knownTables = new Set(["authority_meta", "claims", "claim_generations"]);
  const foreignTables = tableNames.filter((t) => !knownTables.has(t.name));
  if (application_id === 0) {
    if (foreignTables.length > 0) {
      throw new AuthorityUnavailableError("foreign database");
    }
    db.run(`PRAGMA application_id = ${String(expectedApplicationId)}`);
    db.run(`PRAGMA user_version = ${String(expectedSchemaVersion)}`);
  } else if (application_id !== expectedApplicationId) {
    throw new AuthorityUnavailableError("foreign database");
  } else if (user_version > expectedSchemaVersion) {
    throw new AuthorityUnavailableError(`unsupported schema version ${String(user_version)}`);
  } else if (user_version < expectedSchemaVersion) {
    db.run(`PRAGMA user_version = ${String(expectedSchemaVersion)}`);
  }
}

/**
 * Open a ledger connection. A plain open (no `owner`) is non-owning: it
 * never rotates the epoch and never sweeps pending rows. An owning open
 * records `owner` only on a vacant ledger — still without rotating or
 * sweeping; ownership transfer goes through recoverOwnership.
 */
export function openAdmissionStore(opts: {
  path: string;
  busyTimeoutMs?: number | undefined;
  owner?: OwnerIdentity | undefined;
}): AdmissionStore {
  let db: Database;
  try {
    db = new Database(opts.path);
  } catch (e) {
    throw new AuthorityUnavailableError(
      `cannot open admission authority at ${opts.path}: ${errText(e)}`,
      { cause: e },
    );
  }
  try {
    db.run(`PRAGMA busy_timeout = ${String(resolveBusyTimeoutMs(opts.busyTimeoutMs))}`);
    assertQuickCheck(db);
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = FULL");
    db.run("BEGIN IMMEDIATE");
    try {
      ensureSchema(db);
      validateAndStampSchema(db, ADMISSION_APPLICATION_ID, ADMISSION_SCHEMA_VERSION);
      const { authorityId, epoch } = initAuthority(db);
      if (opts.owner !== undefined) {
        stakeOwner(db, opts.owner);
      }
      db.run("COMMIT");
      return new SqliteAdmissionStore(db, authorityId, epoch);
    } catch (e) {
      try {
        db.run("ROLLBACK");
      } catch {
        // Statement errors abort the transaction on their own; nothing else to undo.
      }
      throw e;
    }
  } catch (e) {
    try {
      db.close();
    } catch {
      // The handle may already be dead; the typed error below names the cause.
    }
    throw new AuthorityUnavailableError(
      `cannot open admission authority at ${opts.path}: ${errText(e)}`,
      { cause: e },
    );
  }
}
