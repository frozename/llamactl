/**
 * #279 DF-06: agent-startup crash recovery for profile-switch operations.
 * #517: lifecycle-row boot recovery — terminalizes interrupted residency
 * states (loading / warming / draining / unloading) under the same claimed
 * fence.
 *
 * `runProfileSwitchBootRecovery` runs synchronously inside `startAgentServer`,
 * before it returns, so a leftover `profile-switch:<node>` row from a crashed
 * switch is terminalized before any request can be served. It probes the store
 * read-only first (short busy timeout, never creates a file) and only opens a
 * writable handle when such a row actually exists.
 *
 * Fence identity. It claims the operation fence as
 * `RESIDENCY_APPLY_PROFILE_FENCE_OWNER`, the owner every apply-profile call
 * uses: apply-profile refuses Busy whenever the current fence has any other
 * owner, so a recovery claim under its own identity would make every later
 * wet apply-profile Busy until something else re-claimed.
 *
 * When it claims. Only when at least one recognized stale row needs finishing
 * AND no profile-switch row looks possibly live. A store holding only
 * unrecognized rows, or nothing to recover, is never claimed: the fence and
 * every row stay exactly as they were.
 *
 * Live-switch guard. Boot cannot tell a crashed switch from one a CLI process
 * is still running through its own router caller: there is no owner liveness
 * check. What it has is step progress: the executor refreshes the row's
 * `updatedAtMs` through a fenced heartbeat at every step boundary (each fence,
 * each drain settle, each stop, each start). So the rule is a fixed staleness
 * window over step progress: a row whose `updatedAtMs` is less than
 * `PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS` (30 minutes) before boot, or is
 * stamped in the future, is `possibly-live`. In words, a row is recovered only
 * when its switch has made no step progress for 30 minutes. A switch whose
 * total run is longer than the window is safe as long as each step finishes
 * inside it. The window is more than twice the planner's default per-workload
 * budget (drain 30s + unload 60s + load 600s + ready 120s = 13.5 min).
 *
 * The remaining limit: a single step's duration is now bounded by its budget
 * when the caller sets `stepTimeouts` — a stop by `unloadMs`, a start by
 * `loadMs`. The staleness guard above holds only if that budget sits below
 * `PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS`; the executor does not validate
 * this, and a later wiring slice should clamp or validate it. The residual risk
 * is any unbudgeted step: a caller with no `stepTimeouts` (today including
 * apply-profile), a budget at or above the window, or a deferred step. A
 * timed-out dep can also keep running after its row goes terminal, because the
 * abort signal handed to it is advisory.
 *
 * A possibly-live row is never finished, and because a claim would also
 * stale-fence the live switch's own heartbeat and finishOperation, any
 * possibly-live row makes the whole pass defer without claiming. The cost is
 * that a genuinely crashed row younger than the window stays nonterminal (the
 * node stays Busy) until an agent boot after the window has passed.
 *
 * Claim atomicity. The writable-handle re-check and the claim run as ONE
 * IMMEDIATE store transaction (`claimOwnershipWhen`): the decision is taken
 * over the nonterminal rows read inside that transaction, so a CLI cannot
 * claim or begin a switch between the re-check and the claim. The recovery
 * finishes run afterwards under the claimed fence; a CLI claim after it only
 * makes those finishes fail stale-fence, which never touches a live switch.
 *
 * Lifecycle-row sweep (Part of #517). After the profile-switch operations are
 * terminalized, the same claimed pass walks every residency_states row stuck
 * in an interrupted transient state (`loading`, `warming`, `draining`,
 * `unloading`) and transitions it to `failed`, releasing the exclusive-group
 * occupancy a crashed switch left behind. Per-row write failures or refusals
 * are contained and counted without stopping the sweep. The sweep runs under
 * the same fence token as the operation recovery, so a concurrent CLI
 * apply-profile will stale-fence the sweep — this is the desired safety
 * property: the CLI owns the fence, not boot recovery.
 *
 * Safety. The sweep touches only transient states; stable states
 * (`unavailable`, `downloaded`, `ready`, `failed`) are never modified. A
 * per-row refusal (e.g., `version-conflict`) is counted as a record failure
 * but does not abort the sweep. A per-row throw is caught and counted as a
 * record failure, then the sweep continues to the next row. A throw while
 * listing the rows is contained and counted as one record failure; the
 * profile-switch recovery has already run and still reports `recovered`.
 *
 * Reasoning. A crashed switch can leave residency rows in any transient state,
 * holding exclusive-group capacity and preventing new models from loading.
 * Boot recovery must release these rows so the node can accept new workloads.
 * The sweep uses the same fence as the operation recovery, ensuring that a
 * concurrent CLI apply-profile (which holds the fence) is not interfered with.
 *
 * Caveats. The sweep is a best-effort cleanup: when no row is in an
 * interrupted transient state it changes nothing and writes no lifecycle line.
 * It runs only on a claimed pass, i.e. only when a stale profile-switch row
 * exists: lifecycle rows interrupted outside a switch are not swept. It does
 * not validate group consistency — it only transitions states. Group cleanup
 * is the responsibility of the normal executor path.
 *
 * Logging. An absent store or a store with no profile-switch row logs nothing.
 * A deferred or recovered pass logs one line of counts only (no operation ids,
 * no model or node names). A failure logs one `failed:` line with the first
 * line of the error. A throwing write sink is swallowed. It never throws: any
 * failure is logged and boot continues. A recovered pass whose lifecycle
 * sweep moved at least one row to `failed` or recorded at least one failure
 * (N + M > 0) logs a second line
 * `[residency] lifecycle boot recovery {"failed":N,"recordFailures":M}\n`
 * after the profile-switch recovery line, with the same counts-only constraint
 * (no model or group names). The two lines' `recordFailures` are separate:
 * the profile-switch line counts operation rows only, the lifecycle line
 * counts lifecycle rows only.
 */
import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "./apply-profile.js";
import {
  previewProfileSwitchRecovery,
  type ProfileSwitchRecoveryPreview,
  recoverProfileSwitchOperationsUnverified,
} from "./recovery.js";
import {
  openResidencyOperationStore,
  readResidencyStoreSnapshot,
  RESIDENCY_LEASE_AUDIT_BUSY_TIMEOUT_MS,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
} from "./store.js";

export const PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS = 30 * 60_000;

export const INTERRUPTED_LIFECYCLE_STATES: ReadonlySet<string> = new Set([
  "loading",
  "warming",
  "draining",
  "unloading",
]);

export type BootRecoverySummary = {
  status: "absent" | "clean" | "deferred" | "recovered" | "failed";
  recovered: number;
  recordFailures: number;
  skipped: number;
  unrecognized: number;
  possiblyLive: number;
};

type BootRecoveryStore = ResidencyOperationStore & ResidencyLifecycleStore;

export type BootRecoveryOpts = {
  path: string;
  incarnation: string;
  nowMs?: () => number;
  minStaleAgeMs?: number;
  write?: (line: string) => void;
  openStore?: (storePath: string) => BootRecoveryStore;
};

type Counts = Omit<BootRecoverySummary, "status">;

const SWITCH_PREFIX = "profile-switch:";
const MAX_FAILURE_MESSAGE_CHARS = 200;
const NO_COUNTS: Counts = {
  recovered: 0,
  recordFailures: 0,
  skipped: 0,
  unrecognized: 0,
  possiblyLive: 0,
};

type LifecycleContext = { counts: LifecycleCounts | undefined };

export function runProfileSwitchBootRecovery(opts: BootRecoveryOpts): BootRecoverySummary {
  const write = opts.write ?? defaultWrite;
  const openStore = opts.openStore ?? defaultOpenStore;
  const nowMs = opts.nowMs ?? Date.now;
  const minStaleAgeMs = opts.minStaleAgeMs ?? PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS;

  try {
    const snapshot = readResidencyStoreSnapshot(opts.path, {
      busyTimeoutMs: RESIDENCY_LEASE_AUDIT_BUSY_TIMEOUT_MS,
    });
    if (!snapshot.present) {
      return { status: "absent", ...NO_COUNTS };
    }
    if ("error" in snapshot) {
      throw new Error(snapshot.error);
    }
    if (!snapshot.nonterminal.some((record) => record.model.startsWith(SWITCH_PREFIX))) {
      return { status: "clean", ...NO_COUNTS };
    }

    const preview = previewProfileSwitchRecovery(snapshot.nonterminal, {
      nowMs: nowMs(),
      minStaleAgeMs,
    });
    const lifecycle: LifecycleContext = { counts: undefined };
    const result = shouldClaim(preview)
      ? scanWithStore(openStore, opts, nowMs, minStaleAgeMs, lifecycle)
      : deferred(preview);

    safeWrite(write, `[residency] profile-switch boot recovery ${countsJson(result)}\n`);
    if (
      result.status === "recovered" &&
      lifecycle.counts &&
      lifecycle.counts.failed + lifecycle.counts.recordFailures > 0
    ) {
      safeWrite(
        write,
        `[residency] lifecycle boot recovery ${lifecycleCountsJson(lifecycle.counts)}\n`,
      );
    }
    return result;
  } catch (error: unknown) {
    safeWrite(write, `[residency] profile-switch boot recovery failed: ${failureMessage(error)}\n`);
    return { status: "failed", ...NO_COUNTS };
  }
}

// Counts only, in a fixed key order: never an operation id, model or node.
function countsJson(result: BootRecoverySummary): string {
  return JSON.stringify({
    recovered: result.recovered,
    recordFailures: result.recordFailures,
    skipped: result.skipped,
    unrecognized: result.unrecognized,
    possiblyLive: result.possiblyLive,
  });
}

interface LifecycleCounts {
  failed: number;
  recordFailures: number;
}

function lifecycleCountsJson(counts: LifecycleCounts): string {
  return JSON.stringify({ failed: counts.failed, recordFailures: counts.recordFailures });
}

function failInterruptedLifecycleRows(
  store: BootRecoveryStore,
  fenceToken: number,
  nowMs: number,
): LifecycleCounts {
  const states = store.listResidencyStates();
  let failed = 0;
  let recordFailures = 0;
  for (const stateRecord of states) {
    if (!INTERRUPTED_LIFECYCLE_STATES.has(stateRecord.state)) {
      continue;
    }
    try {
      const result = store.transitionResidencyState({
        fenceToken,
        model: stateRecord.model,
        to: "failed",
        expectedVersion: stateRecord.version,
        nowMs,
      });
      if (result.ok) {
        failed++;
      } else {
        recordFailures++;
      }
    } catch {
      recordFailures++;
    }
  }
  return { failed, recordFailures };
}

function shouldClaim(preview: ProfileSwitchRecoveryPreview): boolean {
  return preview.stale > 0 && preview.possiblyLive === 0;
}

function deferred(preview: ProfileSwitchRecoveryPreview): BootRecoverySummary {
  return {
    status: "deferred",
    ...NO_COUNTS,
    unrecognized: preview.unrecognized,
    possiblyLive: preview.possiblyLive,
  };
}

function scanWithStore(
  openStore: (storePath: string) => BootRecoveryStore,
  opts: BootRecoveryOpts,
  nowMs: () => number,
  minStaleAgeMs: number,
  lifecycle: LifecycleContext,
): BootRecoverySummary {
  const store = openStore(opts.path);
  try {
    // Re-check on the writable handle: the snapshot may be stale by now, and a
    // claim must never land while a possibly-live switch row exists. The
    // re-check and the claim share one IMMEDIATE transaction.
    let preview: ProfileSwitchRecoveryPreview = { stale: 0, possiblyLive: 0, unrecognized: 0 };
    const claim = store.claimOwnershipWhen(
      { ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER, incarnation: opts.incarnation },
      (nonterminal) => {
        preview = previewProfileSwitchRecovery(nonterminal, { nowMs: nowMs(), minStaleAgeMs });
        return shouldClaim(preview);
      },
    );
    if (!claim.claimed) {
      return deferred(preview);
    }
    const fence = claim.fence;
    const result = recoverProfileSwitchOperationsUnverified({
      store,
      fenceToken: fence.fenceToken,
      nowMs,
      minStaleAgeMs,
    });
    const recovered = result.recovered.filter((row) => row.recorded).length;
    let lifecycleCounts: LifecycleCounts;
    try {
      lifecycleCounts = failInterruptedLifecycleRows(store, fence.fenceToken, nowMs());
    } catch {
      /* per-row throws are caught inside the sweep, so this is a failure to
         list the rows: it is contained (the profile-switch recovery already
         ran) and counted as one lifecycle record failure, so the lifecycle
         line surfaces it */
      lifecycleCounts = { failed: 0, recordFailures: 1 };
    }
    lifecycle.counts = lifecycleCounts;
    return {
      status: "recovered",
      recovered,
      recordFailures: result.recovered.length - recovered,
      skipped: result.skipped.length,
      unrecognized: result.unrecognized.length,
      possiblyLive: result.possiblyLive.length,
    };
  } finally {
    try {
      store.close();
    } catch {
      /* the rows are already written: a close failure never fails recovery or boot */
    }
  }
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
