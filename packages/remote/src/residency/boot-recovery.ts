/**
 * #279 DF-06: agent-startup crash recovery for profile-switch operations.
 *
 * `runProfileSwitchBootRecovery` runs synchronously inside `startAgentServer`,
 * before it returns, so a leftover `profile-switch:<node>` row from a crashed
 * switch is terminalized before any request can be served. It probes the store
 * read-only first (short busy timeout, never creates a file) and only opens a
 * writable handle, claims a fence and terminalizes stale rows when such a row
 * actually exists. It logs exactly one line of counts and never throws: any
 * failure is logged and boot continues.
 */
import { recoverProfileSwitchOperationsUnverified } from "./recovery.js";
import {
  openResidencyOperationStore,
  readResidencyStoreSnapshot,
  RESIDENCY_LEASE_AUDIT_BUSY_TIMEOUT_MS,
  type ResidencyOperationStore,
} from "./store.js";

export type BootRecoverySummary = {
  status: "absent" | "clean" | "recovered" | "failed";
  recovered: number;
  recordFailures: number;
  skipped: number;
  unrecognized: number;
};

type BootRecoveryStore = ResidencyOperationStore;

export type BootRecoveryOpts = {
  path: string;
  ownerId: string;
  incarnation: string;
  nowMs?: () => number;
  write?: (line: string) => void;
  openStore?: (storePath: string) => BootRecoveryStore;
};

const SWITCH_PREFIX = "profile-switch:";
const MAX_FAILURE_MESSAGE_CHARS = 200;

export function runProfileSwitchBootRecovery(opts: BootRecoveryOpts): BootRecoverySummary {
  const write = opts.write ?? defaultWrite;
  const openStore = opts.openStore ?? defaultOpenStore;

  try {
    const snapshot = readResidencyStoreSnapshot(opts.path, {
      busyTimeoutMs: RESIDENCY_LEASE_AUDIT_BUSY_TIMEOUT_MS,
    });
    if (!snapshot.present) {
      return summary("absent", 0, 0, 0, 0);
    }
    if ("error" in snapshot) {
      throw new Error(snapshot.error);
    }
    if (!snapshot.nonterminal.some((record) => record.model.startsWith(SWITCH_PREFIX))) {
      return summary("clean", 0, 0, 0, 0);
    }

    const result = scanWithStore(openStore, opts);
    const recovered = result.recovered.filter((row) => row.recorded).length;
    const recordFailures = result.recovered.length - recovered;
    const skipped = result.skipped.length;
    const unrecognized = result.unrecognized.length;

    safeWrite(
      write,
      `[residency] profile-switch boot recovery ${JSON.stringify({ recovered, recordFailures, skipped, unrecognized })}\n`,
    );
    return summary("recovered", recovered, recordFailures, skipped, unrecognized);
  } catch (error: unknown) {
    safeWrite(write, `[residency] profile-switch boot recovery failed: ${failureMessage(error)}\n`);
    return summary("failed", 0, 0, 0, 0);
  }
}

function scanWithStore(
  openStore: (storePath: string) => BootRecoveryStore,
  opts: BootRecoveryOpts,
): ReturnType<typeof recoverProfileSwitchOperationsUnverified> {
  const store = openStore(opts.path);
  try {
    const fence = store.claimOwnership({ ownerId: opts.ownerId, incarnation: opts.incarnation });
    return recoverProfileSwitchOperationsUnverified({
      store,
      fenceToken: fence.fenceToken,
      ...(opts.nowMs === undefined ? {} : { nowMs: opts.nowMs }),
    });
  } finally {
    try {
      store.close();
    } catch {
      /* never let a close failure crash boot */
    }
  }
}

function summary(
  status: BootRecoverySummary["status"],
  recovered: number,
  recordFailures: number,
  skipped: number,
  unrecognized: number,
): BootRecoverySummary {
  return { status, recovered, recordFailures, skipped, unrecognized };
}

function failureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split("\n")[0] ?? "";
  return firstLine.slice(0, MAX_FAILURE_MESSAGE_CHARS);
}

function defaultOpenStore(storePath: string): BootRecoveryStore {
  return openResidencyOperationStore({
    path: storePath,
    busyTimeoutMs: RESIDENCY_LEASE_AUDIT_BUSY_TIMEOUT_MS,
  });
}

function defaultWrite(line: string): void {
  process.stderr.write(line);
}

function safeWrite(write: (line: string) => void, line: string): void {
  try {
    write(line);
  } catch {
    /* logging must never crash boot */
  }
}
