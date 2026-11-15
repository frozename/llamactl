/**
 * #279 DF-06: crash recovery for interrupted profile-switch operation records.
 *
 * When a profile-switch operation crashes mid-flight, it leaves a nonterminal
 * `profile-switch:<node>` row that blocks every later switch on that node.
 * `recoverProfileSwitchOperations` scans for those orphaned rows and
 * terminalizes them — either `unknown` (with a reason like
 * `interrupted-unverified` or `readiness-check-failed`) or `succeeded`
 * (when an optional readiness verifier confirms the target profile is ready).
 *
 * Rows owned by the current fence are skipped (not terminalized). Rows that
 * are not profile-switch operations are ignored. Already-terminal rows are
 * left untouched and recovery is idempotent.
 *
 * A verifier that throws (synchronously or asynchronously) or overruns
 * `verifyTimeoutMs` records the row as `unknown`/`readiness-check-failed`;
 * one row's failure never stops the scan of the remaining rows.
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

type RecoverResult = { recovered: RecoveredOperation[]; skipped: SkippedOperation[] };

type RecoverOpts = {
  store: RecoverStore;
  fenceToken: number;
  nowMs?: () => number;
  verifyTargetReady?: RecoverVerifier;
  verifyTimeoutMs?: number;
};

export async function recoverProfileSwitchOperations(opts: RecoverOpts): Promise<RecoverResult> {
  const store = opts.store;
  const fenceToken = opts.fenceToken;
  const nowMs = opts.nowMs ?? Date.now;
  const verifyTargetReady = opts.verifyTargetReady;
  const verifyTimeoutMs = opts.verifyTimeoutMs;

  const recovered: RecoveredOperation[] = [];
  const skipped: SkippedOperation[] = [];

  for (const record of store.listNonterminal()) {
    // A row already terminal is never finished a second time.
    if (record.phase === "terminal") {
      continue;
    }

    const node = profileSwitchNode(record.model);
    if (node === null) {
      continue;
    }

    if (record.fenceToken === fenceToken) {
      skipped.push({ operationId: record.operationId, node, reason: "owned-by-current-fence" });
      continue;
    }

    const result = await terminalizeRecord(
      store,
      record,
      node,
      fenceToken,
      nowMs,
      verifyTargetReady,
      verifyTimeoutMs,
    );
    if (result !== null) {
      recovered.push(result);
    }
  }

  return { recovered, skipped };
}

function profileSwitchNode(model: string): string | null {
  const prefix = "profile-switch:";
  if (!model.startsWith(prefix)) {
    return null;
  }
  const node = model.slice(prefix.length);
  return node.length > 0 ? node : null;
}

async function terminalizeRecord(
  store: RecoverStore,
  record: ResidencyOperationRecord,
  node: string,
  fenceToken: number,
  nowMs: () => number,
  verifyTargetReady: RecoverVerifier | undefined,
  verifyTimeoutMs: number | undefined,
): Promise<RecoveredOperation | null> {
  const profile = extractProfile(record.targetState);
  if (profile === null) {
    return null;
  }

  const verificationOutcome = await runVerification(
    verifyTargetReady,
    { node, profile, operationId: record.operationId },
    verifyTimeoutMs,
  );

  const outcome: "succeeded" | "unknown" = verificationOutcome.isReady ? "succeeded" : "unknown";

  const reason = verificationOutcome.isReady
    ? "target-verified-ready"
    : verificationOutcome.checkFailed
      ? "readiness-check-failed"
      : "interrupted-unverified";

  const detail = `recovered: ${reason} (was ${record.phase})`;

  const finished = store.finishOperation({
    fenceToken,
    operationId: record.operationId,
    expectedVersion: record.version,
    nowMs: nowMs(),
    outcome,
    detail,
  });

  const recorded = finished.ok;
  const recordFailure = finished.ok ? undefined : finished.reason;

  return {
    operationId: record.operationId,
    node,
    profile,
    priorPhase: record.phase,
    outcome,
    reason,
    recorded,
    ...(recordFailure !== undefined ? { recordFailure } : {}),
  };
}

function extractProfile(targetState: string): string | null {
  const prefix = "profile:";
  if (!targetState.startsWith(prefix)) {
    return null;
  }
  const profile = targetState.slice(prefix.length);
  return profile.length > 0 ? profile : null;
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
