/**
 * DF-08 (#281) pure cold-model request queue and execution admission policy.
 * Not wired into any ingress yet.
 *
 * Still open:
 * - the remote request-admission / request-queue async wrapper with
 *   AbortSignal and the overload / unavailable protocol mapping;
 * - the create-proxy.ts and inference/procedures.ts wiring, which composes
 *   with the DF-05 #278 leases;
 * - holding the execution slot until the terminal HTTP / RPC stream finish;
 * - execution-phase total-deadline enforcement (left to the ingress wrapper);
 * - mixed-ingress tests under packages/remote/test/residency.
 *
 * Actual memory admission stays with evaluateManagedAdmission.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type RequestPriority = "interactive" | "background";

export interface QueueModelRef {
  name: string;
  revision: string;
}

export function modelKeyOf(ref: QueueModelRef): string {
  return `${ref.name}@${ref.revision}`;
}

export interface RequestQueueLimits {
  maxExecutions: number;
  maxQueued: number;
  maxQueuedBytes: number;
  maxQueueWaitMs: number;
  maxPerPrincipal: number;
  starvationBoundMs: number;
  maxContextTokens: number;
  retryAfterMs: number;
}

export interface RequestQueuePolicyOptions {
  limits: RequestQueueLimits;
  now?: () => number;
  resident?: string[];
}

export interface QueueRequest {
  requestId: string;
  principal: string;
  priority: RequestPriority;
  model: QueueModelRef;
  bytes: number;
  promptTokens: number;
  maxCompletionTokens: number;
  deadlineMs: number;
}

export type QueueRefuseReason =
  | "ContextLimitExceeded"
  | "DeadlineExceeded"
  | "InvalidRequest"
  | "PrincipalShareExceeded"
  | "QueueBytesExceeded"
  | "QueueFull";

export type EnqueueResult =
  | { kind: "queued"; requestId: string }
  | { kind: "duplicate"; requestId: string; state: "queued" | "executing" }
  | { kind: "refused"; reason: QueueRefuseReason; retryAfterMs: number | null };

export type QueueAction =
  | {
      kind: "expire";
      requestId: string;
      reason: "DeadlineExceeded" | "QueueWaitExceeded";
      retryAfterMs: number | null;
    }
  | { kind: "fail"; requestId: string; reason: "LoadFailed"; retryAfterMs: number }
  | { kind: "start-execution"; requestId: string; modelKey: string }
  | { kind: "start-load"; loadId: string; modelKey: string };

export type CancelResult =
  | { kind: "cancelled"; state: "queued" | "executing" }
  | { kind: "unknown" };

export interface QueueSnapshot {
  queued: number;
  queuedBytes: number;
  executing: number;
  loading: string | null;
  resident: string[];
  byPrincipal: Record<string, number>;
}

export interface RequestQueuePolicy {
  enqueue: (request: QueueRequest) => EnqueueResult;
  schedule: () => QueueAction[];
  loadSettled: (loadId: string, outcome: "ready" | "failed") => QueueAction[];
  markEvicted: (modelKey: string) => void;
  cancel: (requestId: string) => CancelResult;
  finishExecution: (requestId: string) => boolean;
  snapshot: () => QueueSnapshot;
  limits: () => RequestQueueLimits;
}

// ── Internal structures ────────────────────────────────────────────────────

interface QueuedRequest {
  requestId: string;
  principal: string;
  priority: RequestPriority;
  modelKey: string;
  bytes: number;
  promptTokens: number;
  maxCompletionTokens: number;
  deadlineMs: number;
  seq: number;
  enqueuedAt: number;
}

interface ExecutingRequest {
  requestId: string;
  principal: string;
  priority: RequestPriority;
  modelKey: string;
  seq: number;
}

interface InFlightLoad {
  loadId: string;
  modelKey: string;
}

// ── Validation helpers ─────────────────────────────────────────────────────

function validateLimits(limits: RequestQueueLimits): void {
  const allFields = [
    "maxExecutions",
    "maxQueued",
    "maxQueuedBytes",
    "maxQueueWaitMs",
    "maxPerPrincipal",
    "starvationBoundMs",
    "maxContextTokens",
    "retryAfterMs",
  ] as const;
  const intFields = new Set(["maxExecutions", "maxQueued", "maxPerPrincipal", "maxContextTokens"]);
  for (const field of allFields) {
    const value = limits[field];
    const isInt = intFields.has(field);
    if (!Number.isFinite(value) || value <= 0 || (isInt && !Number.isInteger(value))) {
      throw new Error(
        `${field} must be a${isInt ? "n integer" : ""} positive finite number (got ${String(value)})`,
      );
    }
  }
}

function validateRequest(req: QueueRequest): boolean {
  if (req.requestId === "") return false;
  if (req.principal === "") return false;
  if (req.model.name === "") return false;
  if (req.model.revision === "") return false;
  if (!Number.isFinite(req.bytes) || req.bytes < 0) return false;
  if (req.bytes === Number.POSITIVE_INFINITY) return false;
  if (!Number.isFinite(req.promptTokens) || req.promptTokens < 0) return false;
  if (req.promptTokens === Number.POSITIVE_INFINITY) return false;
  if (!Number.isFinite(req.maxCompletionTokens) || req.maxCompletionTokens < 0) return false;
  if (req.maxCompletionTokens === Number.POSITIVE_INFINITY) return false;
  if (Number.isNaN(req.deadlineMs)) return false;
  return true;
}

// ── Implementation class ───────────────────────────────────────────────────

class RequestQueuePolicyImpl implements RequestQueuePolicy {
  private readonly queueLimits: RequestQueueLimits;
  private readonly now: () => number;
  private readonly resident: readonly string[];
  private readonly queue: Map<string, QueuedRequest>;
  private readonly executing: Map<string, ExecutingRequest>;
  private loaded: Set<string>;
  private evicted: Set<string>;
  private inFlight: InFlightLoad | null;
  private seq: number;
  private nextLoadId: number;

  constructor(opts: RequestQueuePolicyOptions) {
    validateLimits(opts.limits);
    this.queueLimits = opts.limits;
    this.now = opts.now ?? ((): number => Date.now());
    this.resident = opts.resident ?? [];
    this.queue = new Map();
    this.executing = new Map();
    this.loaded = new Set();
    this.evicted = new Set();
    this.inFlight = null;
    this.seq = 0;
    this.nextLoadId = 1;
  }

  // ── enqueue ──────────────────────────────────────────────────────────

  enqueue(req: QueueRequest): EnqueueResult {
    const requestId = req.requestId;

    // 1. Duplicate check (idempotent re-enqueue)
    if (this.queue.has(requestId)) {
      return { kind: "duplicate", requestId, state: "queued" };
    }
    if (this.executing.has(requestId)) {
      return { kind: "duplicate", requestId, state: "executing" };
    }

    // 2. Validate (includes NaN deadlineMs → InvalidRequest)
    if (!validateRequest(req)) {
      return { kind: "refused", reason: "InvalidRequest", retryAfterMs: null };
    }

    const now = this.now();
    const modelKey = modelKeyOf(req.model);

    // 3. Context tokens check (before deadline and capacity)
    if (req.promptTokens + req.maxCompletionTokens > this.queueLimits.maxContextTokens) {
      return {
        kind: "refused",
        reason: "ContextLimitExceeded",
        retryAfterMs: null,
      };
    }

    // 4. Bytes check: individual bytes > maxQueuedBytes → null retry
    if (req.bytes > this.queueLimits.maxQueuedBytes) {
      return {
        kind: "refused",
        reason: "QueueBytesExceeded",
        retryAfterMs: null,
      };
    }

    // 5. Deadline at or before now — refused (retryAfterMs null)
    if (req.deadlineMs !== Number.POSITIVE_INFINITY && req.deadlineMs <= now) {
      return {
        kind: "refused",
        reason: "DeadlineExceeded",
        retryAfterMs: null,
      };
    }

    // 6. Principal share check (queued + executing)
    if (this.principalCount(req.principal) >= this.queueLimits.maxPerPrincipal) {
      return {
        kind: "refused",
        reason: "PrincipalShareExceeded",
        retryAfterMs: this.queueLimits.retryAfterMs,
      };
    }

    // 7. Queue full (count only queued, not executing)
    if (this.queue.size >= this.queueLimits.maxQueued) {
      return {
        kind: "refused",
        reason: "QueueFull",
        retryAfterMs: this.queueLimits.retryAfterMs,
      };
    }

    // 8. Aggregate bytes > maxQueuedBytes (queue not full by entries)
    const aggregateBytes = this.queueBytes + req.bytes;
    if (aggregateBytes > this.queueLimits.maxQueuedBytes) {
      return {
        kind: "refused",
        reason: "QueueBytesExceeded",
        retryAfterMs: this.queueLimits.retryAfterMs,
      };
    }

    // 10. Enqueue
    const entry: QueuedRequest = {
      requestId,
      principal: req.principal,
      priority: req.priority,
      modelKey,
      bytes: req.bytes,
      promptTokens: req.promptTokens,
      maxCompletionTokens: req.maxCompletionTokens,
      deadlineMs: req.deadlineMs,
      seq: this.seq++,
      enqueuedAt: now,
    };
    this.queue.set(requestId, entry);

    return { kind: "queued", requestId };
  }

  // ── schedule ─────────────────────────────────────────────────────────

  schedule(): QueueAction[] {
    const now = this.now();
    const actions: QueueAction[] = [];

    // Step 1: Expire timed-out waiters
    this.expireDue(now, actions);

    // Step 2: Start executions for available models
    this.startExecutions(actions, now);

    // Step 3: At most one start-load
    this.maybeStartLoad(actions, now);

    return actions;
  }

  // ── loadSettled ──────────────────────────────────────────────────────

  loadSettled(loadId: string, outcome: "ready" | "failed"): QueueAction[] {
    // Idempotent: only the current in-flight load responds
    if (this.inFlight?.loadId !== loadId) {
      return [];
    }

    const modelKey = this.inFlight.modelKey;
    this.inFlight = null;

    if (outcome === "ready") {
      // Model is now loaded (available for execution)
      this.loaded.add(modelKey);
      this.evicted.delete(modelKey);
      return [];
    }

    // Failed: emit fail actions for all waiters of this model, remove them
    const actions: QueueAction[] = [];
    const toRemove: string[] = [];
    for (const [id, entry] of this.queue) {
      if (entry.modelKey === modelKey) {
        actions.push({
          kind: "fail",
          requestId: id,
          reason: "LoadFailed",
          retryAfterMs: this.queueLimits.retryAfterMs,
        });
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      this.queue.delete(id);
    }
    return actions;
  }

  // ── markEvicted ──────────────────────────────────────────────────────

  markEvicted(modelKey: string): void {
    this.evicted.add(modelKey);
  }

  // ── cancel ───────────────────────────────────────────────────────────

  cancel(requestId: string): CancelResult {
    const queued = this.queue.get(requestId);
    if (queued !== undefined) {
      this.queue.delete(requestId);
      return { kind: "cancelled", state: "queued" };
    }
    const executing = this.executing.get(requestId);
    if (executing !== undefined) {
      this.executing.delete(requestId);
      return { kind: "cancelled", state: "executing" };
    }
    return { kind: "unknown" };
  }

  // ── finishExecution ──────────────────────────────────────────────────

  finishExecution(requestId: string): boolean {
    if (!this.executing.has(requestId)) return false;
    this.executing.delete(requestId);
    return true;
  }

  // ── snapshot ─────────────────────────────────────────────────────────

  snapshot(): QueueSnapshot {
    // Resident = constructor-resident + successfully loaded, minus evicted
    const residentList: string[] = [];
    for (const key of this.resident) {
      if (!this.evicted.has(key)) {
        residentList.push(key);
      }
    }
    for (const key of this.loaded) {
      if (!this.evicted.has(key) && !residentList.includes(key)) {
        residentList.push(key);
      }
    }

    // byPrincipal: count queued + executing per principal, omit zeros
    const principalMap = new Map<string, number>();
    for (const [_id, entry] of this.queue) {
      principalMap.set(entry.principal, (principalMap.get(entry.principal) ?? 0) + 1);
    }
    for (const [_id, entry] of this.executing) {
      principalMap.set(entry.principal, (principalMap.get(entry.principal) ?? 0) + 1);
    }

    const byPrincipalEntries: [string, number][] = [];
    for (const [key, count] of principalMap) {
      if (count > 0) {
        byPrincipalEntries.push([key, count]);
      }
    }
    byPrincipalEntries.sort((a, b) => (a[0] < b[0] ? -1 : 1));

    return {
      queued: this.queue.size,
      queuedBytes: this.queueBytes,
      executing: this.executing.size,
      loading: this.inFlight?.modelKey ?? null,
      resident: residentList.sort(),
      byPrincipal: Object.fromEntries(byPrincipalEntries),
    };
  }

  // ── limits ───────────────────────────────────────────────────────────

  limits(): RequestQueueLimits {
    return { ...this.queueLimits };
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private get queueBytes(): number {
    let total = 0;
    for (const [_id, entry] of this.queue) {
      total += entry.bytes;
    }
    return total;
  }

  private principalCount(principal: string): number {
    let count = 0;
    for (const [_id, entry] of this.queue) {
      if (entry.principal === principal) count++;
    }
    for (const [_id, entry] of this.executing) {
      if (entry.principal === principal) count++;
    }
    return count;
  }

  // ── Expire timed-out waiters ─────────────────────────────────────────

  private expireDue(now: number, actions: QueueAction[]): void {
    const toExpire: {
      entry: QueuedRequest;
      reason: "DeadlineExceeded" | "QueueWaitExceeded";
    }[] = [];

    for (const [_id, entry] of this.queue) {
      // Deadline expiry
      if (entry.deadlineMs !== Number.POSITIVE_INFINITY && entry.deadlineMs <= now) {
        toExpire.push({ entry, reason: "DeadlineExceeded" });
        continue;
      }
      // Queue-wait expiry
      const waitMs = now - entry.enqueuedAt;
      if (waitMs >= this.queueLimits.maxQueueWaitMs) {
        toExpire.push({ entry, reason: "QueueWaitExceeded" });
      }
    }

    // Sort by enqueue order (seq) for fairness
    toExpire.sort((a, b) => a.entry.seq - b.entry.seq);

    for (const { entry, reason } of toExpire) {
      const retryAfterMs = reason === "DeadlineExceeded" ? null : this.queueLimits.retryAfterMs;
      actions.push({
        kind: "expire",
        requestId: entry.requestId,
        reason,
        retryAfterMs,
      });
      this.queue.delete(entry.requestId);
    }
  }

  // ── Start executions for available models ────────────────────────────

  private startExecutions(actions: QueueAction[], now: number): void {
    const execSlots = this.queueLimits.maxExecutions - this.executing.size;
    if (execSlots <= 0) return;

    // Gather ALL candidates sorted by urgency then enqueue order,
    // then walk the whole list skipping unavailable models until
    // slots are filled (work-conserving).
    const candidates = this.candidatesForExecution(now);

    let filled = 0;
    for (const candidate of candidates) {
      if (filled >= execSlots) break;
      const isAvailable = this.isModelAvailable(candidate.modelKey);
      if (!isAvailable) continue;

      actions.push({
        kind: "start-execution",
        requestId: candidate.requestId,
        modelKey: candidate.modelKey,
      });
      this.executing.set(candidate.requestId, {
        requestId: candidate.requestId,
        principal: candidate.principal,
        priority: candidate.priority,
        modelKey: candidate.modelKey,
        seq: candidate.seq,
      });
      this.queue.delete(candidate.requestId);
      filled++;
    }
  }

  private candidatesForExecution(now: number): QueuedRequest[] {
    const entries: QueuedRequest[] = [];
    for (const [_id, entry] of this.queue) {
      entries.push(entry);
    }
    entries.sort((a, b) => this.compareUrgency(a, b, now));
    return entries;
  }

  private compareUrgency(a: QueuedRequest, b: QueuedRequest, now: number): number {
    const rankDiff = this.urgencyRank(a, now) - this.urgencyRank(b, now);
    return rankDiff !== 0 ? rankDiff : a.seq - b.seq;
  }

  // Interactive waiters and starved background waiters share the top tier;
  // enqueue sequence breaks ties, so a starved background only overtakes
  // interactive waiters enqueued after it.
  private urgencyRank(entry: QueuedRequest, now: number): number {
    if (entry.priority === "interactive") return 0;
    return now - entry.enqueuedAt >= this.queueLimits.starvationBoundMs ? 0 : 1;
  }

  // ── Start at most one load ───────────────────────────────────────────

  private maybeStartLoad(actions: QueueAction[], now: number): void {
    if (this.inFlight !== null) return;

    const modelKey = this.modelKeyForNextLoad(now);
    if (modelKey === null) return;

    const loadId = `load-${String(this.nextLoadId++)}`;
    this.inFlight = { loadId, modelKey };
    actions.push({ kind: "start-load", loadId, modelKey });
  }

  private modelKeyForNextLoad(now: number): string | null {
    // Pick the load target from the most urgent queued waiter
    // (same compareUrgency ordering used for execution), so
    // starvation bounds and priority also cover loads.
    const entries: QueuedRequest[] = [];
    for (const [_id, entry] of this.queue) {
      entries.push(entry);
    }
    if (entries.length === 0) return null;
    entries.sort((a, b) => this.compareUrgency(a, b, now));
    // Walk from most urgent; return the first model that needs loading
    for (const entry of entries) {
      const isAvailable = this.isModelAvailable(entry.modelKey);
      if (!isAvailable) {
        return entry.modelKey;
      }
    }
    return null;
  }

  private isModelAvailable(modelKey: string): boolean {
    const isResident = this.resident.includes(modelKey);
    const isLoadingLoaded = this.loaded.has(modelKey);
    const isEvicted = this.evicted.has(modelKey);
    return (isResident || isLoadingLoaded) && !isEvicted;
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createRequestQueuePolicy(opts: RequestQueuePolicyOptions): RequestQueuePolicy {
  return new RequestQueuePolicyImpl(opts);
}
