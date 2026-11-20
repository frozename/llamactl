/**
 * #279 DF-06: crash recovery for interrupted profile-switch operation records.
 *
 * When a profile-switch operation crashes mid-flight, it leaves a nonterminal
 * `profile-switch:<node>` row that blocks every later switch on that node.
 * `recoverProfileSwitchOperations` scans for those orphaned rows and
 * terminalizes them — either `unknown` (with a reason like
 * `interrupted-unverified` or `readiness-check-failed`) or `succeeded`
 * (when an optional readiness verifier confirms the target profile is ready).
 * `recoverProfileSwitchOperationsUnverified` is the synchronous variant the
 * agent boot path uses: no verifier, every stale row terminalized as
 * `unknown`/`interrupted-unverified`. It also takes an optional
 * `minStaleAgeMs` live-switch guard: a stale row whose `updatedAtMs` is less
 * than that many ms before `nowMs` (including a row stamped in the future) is
 * reported `possiblyLive` and left nonterminal, because a CLI process running
 * apply-profile through its own router caller may still own it. Without
 * `minStaleAgeMs` no age check runs.
 *
 * Every nonterminal row is run through one shared classifier, in this fixed
 * order:
 * 1. Already-terminal rows are skipped (recovery is idempotent).
 * 2. Rows not prefixed `profile-switch:` are ignored, not reported.
 * 3. An empty node (`profile-switch:`) is reported `unrecognized` as
 *    `malformed-node`. This runs BEFORE the fence check, so an empty-node row
 *    owned by the current fence is still reported, never skipped.
 * 4. A row whose fenceToken equals the current fence is `skipped`
 *    (`owned-by-current-fence`), not terminalized.
 * 5. A `targetState` that is not `profile:<non-empty>` is reported
 *    `unrecognized` as `malformed-target`.
 * 6. Otherwise the row is stale and gets terminalized (the sync variant first
 *    applies its `minStaleAgeMs` guard, see above).
 *
 * An `unrecognized` row is never finished: it stays nonterminal so a later,
 * better-informed writer can repair or retire it. A `finishOperation` that
 * returns a refusal records `recorded: false` with the refusal reason; one
 * that throws records `recorded: false` with `finish-threw: <message>`. In
 * both cases the scan continues over the remaining rows.
 *
 * A verifier that throws (synchronously or asynchronously) or overruns
 * `verifyTimeoutMs` records the row as `unknown`/`readiness-check-failed`;
 * one row's failure never stops the scan of the remaining rows.
 *
 * The eviction variant (Part of #517) reuses this module's live-switch guard
 * and finish helper for `evict:<victim>` rows, whose `targetState` reads
 * `evicted-by:<replacement>`. `classifyEvictionRow` is the three-way classifier
 * (skip a terminal or non-eviction row, report an empty victim or a malformed
 * target `unrecognized` and never finish it, otherwise stale).
 * `previewEvictionRecovery` is the read-only count the boot pass runs before
 * claiming a fence, and `recoverEvictionOperationsUnverified` finishes each
 * stale, non-live row `unknown`/`interrupted-unverified`, returning counts only.
 * An `evict:` row has no node and no fence-owned skip, so the classifier never
 * reports `owned-by-current-fence`.
 */
import type { ResidencyOperationRecord } from "./store.js";

type RecoverStore = {
  finishOperation: (input: {
    fenceToken: number;
    operationId: string;
    expectedVersion: number;
    nowMs: number;
    outcome: "succeeded" | "unknown";
    detail?: string;
  }) => { ok: true } | { ok: false; reason: string };
  listNonterminal: () => ResidencyOperationRecord[];
};

type RecoverVerifyArg = { node: string; profile: string; operationId: string };
type RecoverVerifier = (arg: RecoverVerifyArg) => boolean | Promise<boolean>;

type RecoveredOperation = {
  operationId: string;
  node: string;
  profile: string;
  priorPhase: string;
  outcome: "succeeded" | "unknown";
  reason: "target-verified-ready" | "interrupted-unverified" | "readiness-check-failed";
  recorded: boolean;
  recordFailure?: string;
};

type SkippedOperation = {
  operationId: string;
  node: string;
  reason: "owned-by-current-fence";
};

type UnrecognizedOperation = {
  operationId: string;
  model: string;
  reason: "malformed-node" | "malformed-target";
};

type PossiblyLiveOperation = {
  operationId: string;
  node: string;
  reason: "possibly-live";
};

type RecoverResult = {
  recovered: RecoveredOperation[];
  skipped: SkippedOperation[];
  unrecognized: UnrecognizedOperation[];
};

export type UnverifiedRecoverResult = RecoverResult & {
  possiblyLive: PossiblyLiveOperation[];
};

type RecoverOpts = {
  store: RecoverStore;
  fenceToken: number;
  nowMs?: () => number;
  verifyTargetReady?: RecoverVerifier;
  verifyTimeoutMs?: number;
};

type UnverifiedRecoverOpts = {
  store: RecoverStore;
  fenceToken: number;
  nowMs?: () => number;
  minStaleAgeMs?: number;
};

const SWITCH_PREFIX = "profile-switch:";
const EVICT_PREFIX = "evict:";
const EVICTED_BY_PREFIX = "evicted-by:";

// The one shared classifier every scan (async and sync) routes rows through.
// The order below is the contract; see the header comment.
type RowClassification =
  | { kind: "skip" }
  | { kind: "stale"; node: string; profile: string }
  | { kind: "owned-current-fence"; node: string }
  | { kind: "unrecognized"; reason: "malformed-node" | "malformed-target" };

// `fenceToken` null matches no row: the boot preview classifies before it has
// claimed a fence, and once it claims, no existing row can carry the new token.
function classifyRow(
  record: ResidencyOperationRecord,
  fenceToken: number | null,
): RowClassification {
  // A row already terminal is never finished a second time.
  if (record.phase === "terminal") {
    return { kind: "skip" };
  }
  if (!record.model.startsWith(SWITCH_PREFIX)) {
    return { kind: "skip" };
  }
  const node = record.model.slice(SWITCH_PREFIX.length);
  // Empty-node rows are classified before the fence check, so one owned by the
  // current fence is reported rather than skipped.
  if (node.length === 0) {
    return { kind: "unrecognized", reason: "malformed-node" };
  }
  if (record.fenceToken === fenceToken) {
    return { kind: "owned-current-fence", node };
  }
  const profile = extractProfile(record.targetState);
  if (profile === null) {
    return { kind: "unrecognized", reason: "malformed-target" };
  }
  return { kind: "stale", node, profile };
}

export async function recoverProfileSwitchOperations(opts: RecoverOpts): Promise<RecoverResult> {
  const store = opts.store;
  const fenceToken = opts.fenceToken;
  const nowMs = opts.nowMs ?? Date.now;
  const verifyTargetReady = opts.verifyTargetReady;
  const verifyTimeoutMs = opts.verifyTimeoutMs;

  const recovered: RecoveredOperation[] = [];
  const skipped: SkippedOperation[] = [];
  const unrecognized: UnrecognizedOperation[] = [];

  for (const record of store.listNonterminal()) {
    const classification = classifyRow(record, fenceToken);
    if (classification.kind === "skip") {
      continue;
    }
    if (classification.kind !== "stale") {
      collectNonStaleRow(classification, record, skipped, unrecognized);
      continue;
    }
    recovered.push(
      await recoverStaleAsync(
        store,
        record,
        classification.node,
        classification.profile,
        fenceToken,
        nowMs(),
        verifyTargetReady,
        verifyTimeoutMs,
      ),
    );
  }

  return { recovered, skipped, unrecognized };
}

// Shared by both scans: routes an unrecognized or current-fence row into the
// matching output list. Unrecognized rows are never finished: they stay
// nonterminal for a later writer to repair.
function collectNonStaleRow(
  classification: Exclude<RowClassification, { kind: "skip" } | { kind: "stale" }>,
  record: ResidencyOperationRecord,
  skipped: SkippedOperation[],
  unrecognized: UnrecognizedOperation[],
): void {
  if (classification.kind === "unrecognized") {
    unrecognized.push({
      operationId: record.operationId,
      model: record.model,
      reason: classification.reason,
    });
    return;
  }
  skipped.push({
    operationId: record.operationId,
    node: classification.node,
    reason: "owned-by-current-fence",
  });
}

async function recoverStaleAsync(
  store: RecoverStore,
  record: ResidencyOperationRecord,
  node: string,
  profile: string,
  fenceToken: number,
  nowMs: number,
  verifyTargetReady: RecoverVerifier | undefined,
  verifyTimeoutMs: number | undefined,
): Promise<RecoveredOperation> {
  const verification = await runVerification(
    verifyTargetReady,
    { node, profile, operationId: record.operationId },
    verifyTimeoutMs,
  );
  const outcome = verification.isReady ? "succeeded" : "unknown";
  const reason: RecoveredOperation["reason"] = verification.isReady
    ? "target-verified-ready"
    : verification.checkFailed
      ? "readiness-check-failed"
      : "interrupted-unverified";

  return finishStaleRow(store, record, node, profile, { fenceToken, nowMs, outcome, reason });
}

// The live-switch guard: a row touched less than `minStaleAgeMs` before `now`
// (or stamped after `now`) may belong to a switch another process is still
// running, so it is never terminalized from a timestamp alone.
function isPossiblyLive(
  record: ResidencyOperationRecord,
  nowMs: number,
  minStaleAgeMs: number | undefined,
): boolean {
  if (minStaleAgeMs === undefined) {
    return false;
  }
  return nowMs - record.updatedAtMs < minStaleAgeMs;
}

export type ProfileSwitchRecoveryPreview = {
  stale: number;
  possiblyLive: number;
  unrecognized: number;
};

// Read-only classification for the boot pass, run before any fence is claimed:
// how many rows the sync scan would finish, leave as possibly live, or report
// unrecognized. It never touches a store.
export function previewProfileSwitchRecovery(
  records: readonly ResidencyOperationRecord[],
  opts: { nowMs: number; minStaleAgeMs?: number },
): ProfileSwitchRecoveryPreview {
  const preview: ProfileSwitchRecoveryPreview = { stale: 0, possiblyLive: 0, unrecognized: 0 };
  for (const record of records) {
    const classification = classifyRow(record, null);
    if (classification.kind === "unrecognized") {
      preview.unrecognized += 1;
    } else if (classification.kind === "stale") {
      if (isPossiblyLive(record, opts.nowMs, opts.minStaleAgeMs)) {
        preview.possiblyLive += 1;
      } else {
        preview.stale += 1;
      }
    }
  }
  return preview;
}

// The synchronous variant backing agent boot: no verifier, so every stale row
// is terminalized as unknown/interrupted-unverified. It shares the classifier
// and finish helper with the async path.
export function recoverProfileSwitchOperationsUnverified(
  opts: UnverifiedRecoverOpts,
): UnverifiedRecoverResult {
  const store = opts.store;
  const fenceToken = opts.fenceToken;
  const nowMs = opts.nowMs ?? Date.now;

  const recovered: RecoveredOperation[] = [];
  const skipped: SkippedOperation[] = [];
  const unrecognized: UnrecognizedOperation[] = [];
  const possiblyLive: PossiblyLiveOperation[] = [];

  for (const record of store.listNonterminal()) {
    const classification = classifyRow(record, fenceToken);
    if (classification.kind === "skip") {
      continue;
    }
    if (classification.kind !== "stale") {
      collectNonStaleRow(classification, record, skipped, unrecognized);
      continue;
    }

    const now = nowMs();
    if (isPossiblyLive(record, now, opts.minStaleAgeMs)) {
      possiblyLive.push({
        operationId: record.operationId,
        node: classification.node,
        reason: "possibly-live",
      });
      continue;
    }

    recovered.push(
      finishStaleRow(store, record, classification.node, classification.profile, {
        fenceToken,
        nowMs: now,
        outcome: "unknown",
        reason: "interrupted-unverified",
      }),
    );
  }

  return { recovered, skipped, unrecognized, possiblyLive };
}

type FinishArgs = {
  fenceToken: number;
  nowMs: number;
  outcome: "succeeded" | "unknown";
  reason: RecoveredOperation["reason"];
};

function finishStaleRow(
  store: RecoverStore,
  record: ResidencyOperationRecord,
  node: string,
  profile: string,
  args: FinishArgs,
): RecoveredOperation {
  const detail = `recovered: ${args.reason} (was ${record.phase})`;

  const finished = finishOperationSafe(store, {
    fenceToken: args.fenceToken,
    operationId: record.operationId,
    expectedVersion: record.version,
    nowMs: args.nowMs,
    outcome: args.outcome,
    detail,
  });

  return {
    operationId: record.operationId,
    node,
    profile,
    priorPhase: record.phase,
    outcome: args.outcome,
    reason: args.reason,
    ...finished,
  };
}

// The one shared finish helper. A refusal records the reason; a throw is
// contained as `finish-threw: <message>` so a locked store never escapes the
// scan.
function finishOperationSafe(
  store: RecoverStore,
  input: Parameters<RecoverStore["finishOperation"]>[0],
): { recorded: true } | { recorded: false; recordFailure: string } {
  try {
    const finished = store.finishOperation(input);
    if (finished.ok) {
      return { recorded: true };
    }
    return { recorded: false, recordFailure: finished.reason };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { recorded: false, recordFailure: `finish-threw: ${message}` };
  }
}

function extractProfile(targetState: string): string | null {
  const prefix = "profile:";
  if (!targetState.startsWith(prefix)) {
    return null;
  }
  const profile = targetState.slice(prefix.length);
  return profile.length > 0 ? profile : null;
}

// Part of #517: the eviction classifier beside classifyRow. An `evict:` row
// carries no node or fence-owned skip, so it is a three-way decision: skip a
// terminal row or a non-eviction row, report an empty victim or a malformed
// target as unrecognized (never finished), and treat everything else as stale.
type EvictionRowClassification = { kind: "skip" } | { kind: "stale" } | { kind: "unrecognized" };

function classifyEvictionRow(record: ResidencyOperationRecord): EvictionRowClassification {
  if (record.phase === "terminal" || !record.model.startsWith(EVICT_PREFIX)) {
    return { kind: "skip" };
  }
  const victim = record.model.slice(EVICT_PREFIX.length);
  if (victim.length === 0 || extractReplacement(record.targetState) === null) {
    return { kind: "unrecognized" };
  }
  return { kind: "stale" };
}

function extractReplacement(targetState: string): string | null {
  if (!targetState.startsWith(EVICTED_BY_PREFIX)) {
    return null;
  }
  const replacement = targetState.slice(EVICTED_BY_PREFIX.length);
  return replacement.length > 0 ? replacement : null;
}

export type EvictionRecoveryPreview = {
  stale: number;
  possiblyLive: number;
  unrecognized: number;
};

// Read-only eviction classification for the boot pass, run before any fence is
// claimed. It reuses the live-switch guard: a stale row touched inside the
// window (or stamped in the future) is possibly live, and the window edge is
// stale. It never touches a store.
export function previewEvictionRecovery(
  records: readonly ResidencyOperationRecord[],
  opts: { nowMs: number; minStaleAgeMs?: number },
): EvictionRecoveryPreview {
  const preview: EvictionRecoveryPreview = { stale: 0, possiblyLive: 0, unrecognized: 0 };
  for (const record of records) {
    const classification = classifyEvictionRow(record);
    if (classification.kind === "unrecognized") {
      preview.unrecognized += 1;
    } else if (classification.kind === "stale") {
      if (isPossiblyLive(record, opts.nowMs, opts.minStaleAgeMs)) {
        preview.possiblyLive += 1;
      } else {
        preview.stale += 1;
      }
    }
  }
  return preview;
}

export type EvictionRecoveryResult = {
  recovered: number;
  recordFailures: number;
};

// The synchronous eviction variant backing agent boot: every stale, non-live
// `evict:` row is finished unknown/interrupted-unverified. Unrecognized rows
// are never finished. A refusal or throw (caught by finishOperationSafe) counts
// as a record failure; the scan continues over the remaining rows.
export function recoverEvictionOperationsUnverified(opts: {
  store: RecoverStore;
  fenceToken: number;
  nowMs?: () => number;
  minStaleAgeMs?: number;
}): EvictionRecoveryResult {
  const nowMs = opts.nowMs ?? Date.now;
  let recovered = 0;
  let recordFailures = 0;

  for (const record of opts.store.listNonterminal()) {
    if (classifyEvictionRow(record).kind !== "stale") {
      continue;
    }
    const now = nowMs();
    if (isPossiblyLive(record, now, opts.minStaleAgeMs)) {
      continue;
    }
    const finished = finishOperationSafe(opts.store, {
      fenceToken: opts.fenceToken,
      operationId: record.operationId,
      expectedVersion: record.version,
      nowMs: now,
      outcome: "unknown",
      detail: `recovered: interrupted-unverified (was ${record.phase})`,
    });
    if (finished.recorded) {
      recovered += 1;
    } else {
      recordFailures += 1;
    }
  }

  return { recovered, recordFailures };
}

type VerificationOutcome = { isReady: boolean; checkFailed: boolean };

async function runVerification(
  verifyTargetReady: RecoverVerifier | undefined,
  arg: RecoverVerifyArg,
  verifyTimeoutMs: number | undefined,
): Promise<VerificationOutcome> {
  if (verifyTargetReady === undefined) {
    return { isReady: false, checkFailed: false };
  }

  // The executor turns a synchronous throw into a rejection, so it is
  // classified below instead of escaping the scan.
  const probe = new Promise<boolean>((resolve) => {
    resolve(verifyTargetReady(arg));
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded =
    verifyTimeoutMs !== undefined && verifyTimeoutMs > 0
      ? Promise.race([
          probe,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error("readiness verifier timed out"));
            }, verifyTimeoutMs);
          }),
        ])
      : probe;

  try {
    // Only a literal `true` counts as ready: an untyped verifier that
    // returns any other value must not mark the target verified.
    const ready: unknown = await bounded;
    return ready === true
      ? { isReady: true, checkFailed: false }
      : { isReady: false, checkFailed: false };
  } catch {
    return { isReady: false, checkFailed: true };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
