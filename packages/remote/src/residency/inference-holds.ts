import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import {
  RESIDENCY_INFERENCE_HOLD_SCHEMA_VERSION,
  RESIDENCY_LEASE_AUDIT_BUSY_TIMEOUT_MS,
} from "./store.js";

export type InferenceHoldState = "clear" | "current" | "prior" | "unknown";

export interface InferenceHoldReceipt {
  confirmCompletion(): boolean;
}

export interface InferenceHolds {
  begin(workload: string): InferenceHoldReceipt | undefined;
  state(workload: string): InferenceHoldState;
}

function schemaVersion(db: Database): number | undefined {
  const versions = db.query<{ version: number }, []>("SELECT version FROM schema_version").all();
  return versions.length === 1 ? versions[0]?.version : undefined;
}

function upgradeSchema(db: Database): void {
  db.transaction(() => {
    // An older writable operation store must refuse this journal once it holds
    // inference evidence that the older runtime does not know to consult.
    if (schemaVersion(db) !== 1) return;
    db.run(`
      CREATE TABLE inference_holds (
        hold_id TEXT PRIMARY KEY NOT NULL,
        workload TEXT NOT NULL,
        incarnation TEXT NOT NULL
      )
    `);
    db.run("CREATE INDEX idx_inference_holds_workload ON inference_holds (workload)");
    db.run("UPDATE schema_version SET version = ?", [RESIDENCY_INFERENCE_HOLD_SCHEMA_VERSION]);
  }).immediate();
}

// These holds have no expiry. Only the original receipt can settle a dial
// with confirmed completion; a new mount must treat prior holds as unresolved.
export function createDurableInferenceHolds(opts: {
  path: string;
  verifyJournal: () => string | undefined;
}): InferenceHolds & { initialize(): boolean } {
  const incarnation = randomUUID();
  let initialized = false;
  const withJournal = <T>(use: (db: Database) => T): T | undefined => {
    let db: Database | undefined;
    try {
      if (opts.verifyJournal() !== undefined) return undefined;
      db = new Database(opts.path, { readwrite: true, create: false });
      db.run(`PRAGMA busy_timeout = ${String(RESIDENCY_LEASE_AUDIT_BUSY_TIMEOUT_MS)}`);
      db.run("PRAGMA synchronous = FULL");
      if (opts.verifyJournal() !== undefined) return undefined;
      if (!initialized && schemaVersion(db) === 1) upgradeSchema(db);
      if (schemaVersion(db) !== RESIDENCY_INFERENCE_HOLD_SCHEMA_VERSION) return undefined;
      initialized = true;
      const result = use(db);
      return opts.verifyJournal() === undefined ? result : undefined;
    } catch {
      return undefined;
    } finally {
      db?.close();
    }
  };

  return {
    initialize: () =>
      withJournal((db) => {
        db.query("SELECT hold_id FROM inference_holds LIMIT 0").all();
        return true;
      }) === true,
    begin(workload): InferenceHoldReceipt | undefined {
      if (workload.trim().length === 0) return undefined;
      const id = randomUUID();
      const inserted = withJournal(
        (db) =>
          db.run(
            `INSERT INTO inference_holds (hold_id, workload, incarnation)
             SELECT ?, ?, ? WHERE NOT EXISTS (
               SELECT 1 FROM inference_holds WHERE workload = ? AND incarnation != ?
             )`,
            [id, workload, incarnation, workload, incarnation],
          ).changes === 1,
      );
      if (inserted !== true) return undefined;
      return {
        confirmCompletion: () =>
          withJournal(
            (db) =>
              db.run(
                "DELETE FROM inference_holds WHERE hold_id = ? AND workload = ? AND incarnation = ?",
                [id, workload, incarnation],
              ).changes === 1,
          ) === true,
      };
    },
    state(workload): InferenceHoldState {
      if (workload.trim().length === 0) return "unknown";
      return (
        withJournal((db): InferenceHoldState => {
          const result = db
            .query<
              { prior: number | null },
              [string, string]
            >("SELECT MAX(incarnation != ?) AS prior FROM inference_holds WHERE workload = ?")
            .get(incarnation, workload);
          if (result === null) return "unknown";
          if (result.prior === null) return "clear";
          return result.prior === 0 ? "current" : "prior";
        }) ?? "unknown"
      );
    },
  };
}
