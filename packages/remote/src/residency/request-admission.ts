/** Async #281 queue driver. The queue owns execution permits even after a waiter settles. */
import {
  createRequestQueuePolicy,
  type QueueAction,
  type QueueRefuseReason,
  type QueueRequest,
  type QueueSnapshot,
  type RequestQueueLimits,
  type RequestQueuePolicy,
} from "@llamactl/core/residency/queue-policy";

// ── Types ──────────────────────────────────────────────────────────────────

export type AdmissionRejectCode =
  | QueueRefuseReason
  | "Aborted"
  | "ContextUnverified"
  | "DuplicateRequest"
  | "LoadFailed"
  | "QueueWaitExceeded";

export class RequestAdmissionError extends Error {
  public readonly code: AdmissionRejectCode;
  public readonly retryAfterMs: number | null;
  public readonly requestId: string;

  constructor(code: AdmissionRejectCode, retryAfterMs: number | null, requestId: string) {
    super(`${code}: request ${requestId}`);
    this.name = "RequestAdmissionError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.requestId = requestId;
  }
}

export type Release = () => void;

export interface AcquireOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
}

export type AdmissionRequest = Omit<QueueRequest, "deadlineMs">;

export interface RequestQueueWait {
  priority: QueueRequest["priority"];
  outcome: "admitted" | "refused" | "cancelled" | "expired" | "load_failed";
  waitMs: number;
}

export interface RequestAdmissionOptions {
  observeWait?: (sample: RequestQueueWait) => void;
  limits: RequestQueueLimits;
  resident?: string[];
  exclusiveBackground?: boolean;
  /** Completion acknowledges the owner's ready/failed outcome and releases the load gate. */
  load: (modelKey: string, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export type AdmissionReservation =
  | { pending: Promise<Release> }
  | { refusal: RequestAdmissionError };

export interface ReservableRequestAdmission extends RequestAdmission {
  invalidateModel: (modelKey: string) => void;
  oldestQueuedWaitMs: () => number | null;
  reserve: (request: AdmissionRequest, options?: AcquireOptions) => AdmissionReservation;
}

export interface RequestAdmission {
  acquire: (request: AdmissionRequest, options?: AcquireOptions) => Promise<Release>;
  snapshot: () => QueueSnapshot;
}

// ── Internals ──────────────────────────────────────────────────────────────

const MAX_TIMER_MS = 2_147_483_647;

interface Waiter {
  priority: AdmissionRequest["priority"];
  queuedAt: number;
  resolve: (release: Release) => void;
  reject: (error: RequestAdmissionError) => void;
  timer: unknown;
  due: number;
  detachAbort: () => void;
}

interface StartLoadAction {
  loadId: string;
  modelKey: string;
}

type SetTimer = (fn: () => void, ms: number) => unknown;
type ClearTimer = (handle: unknown) => void;
type Now = () => number;

const defaultNow = (): number => Date.now();

const defaultSetTimer = (fn: () => void, ms: number): unknown => setTimeout(fn, ms);

const defaultClearTimer = (handle: unknown): void => {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
};

// Waiters without an AbortSignal still carry a detach handle.
const noopDetach = (): void => undefined;

class RequestAdmissionImpl implements ReservableRequestAdmission {
  private readonly opts: RequestAdmissionOptions;
  private readonly now: Now;
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private readonly policy: RequestQueuePolicy;
  private readonly waiters = new Map<string, Waiter>();
  private activeLoad: { id: string; controller: AbortController } | undefined;

  constructor(opts: RequestAdmissionOptions) {
    this.opts = opts;
    this.now = opts.now ?? defaultNow;
    this.setTimer = opts.setTimer ?? defaultSetTimer;
    this.clearTimer = opts.clearTimer ?? defaultClearTimer;
    this.policy = createRequestQueuePolicy({
      limits: opts.limits,
      exclusiveBackground: opts.exclusiveBackground === true,
      now: this.now,
      ...(opts.resident !== undefined ? { resident: opts.resident } : {}),
    });
  }

  acquire(request: AdmissionRequest, options: AcquireOptions = {}): Promise<Release> {
    const reservation = this.reserve(request, options);
    return "refusal" in reservation ? Promise.reject(reservation.refusal) : reservation.pending;
  }

  reserve(request: AdmissionRequest, options: AcquireOptions = {}): AdmissionReservation {
    const id = request.requestId;
    if (options.signal?.aborted === true) {
      this.observeWait(request.priority, "cancelled", 0);
      return { refusal: new RequestAdmissionError("Aborted", null, id) };
    }
    const deadlineMs = options.deadlineMs ?? Number.POSITIVE_INFINITY;
    const result = this.policy.enqueue({ ...request, deadlineMs });
    if (result.kind === "duplicate") {
      this.observeWait(request.priority, "refused", 0);
      return { refusal: new RequestAdmissionError("DuplicateRequest", null, id) };
    }
    if (result.kind === "refused") {
      this.observeWait(request.priority, "refused", 0);
      return { refusal: new RequestAdmissionError(result.reason, result.retryAfterMs, id) };
    }
    return { pending: this.acquireQueued(request, deadlineMs, options.signal) };
  }

  snapshot(): QueueSnapshot {
    return this.policy.snapshot();
  }

  oldestQueuedWaitMs(): number | null {
    return this.policy.oldestQueuedWaitMs?.() ?? null;
  }

  invalidateModel(modelKey: string): void {
    this.policy.markEvicted(modelKey);
  }

  // ── enqueue path ─────────────────────────────────────────────────────

  private acquireQueued(
    request: AdmissionRequest,
    deadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<Release> {
    const promise = new Promise<Release>((resolve, reject) => {
      this.attachWaiter(request, deadlineMs, signal, resolve, reject);
    });
    this.pump();
    return promise;
  }

  private attachWaiter(
    request: AdmissionRequest,
    deadlineMs: number,
    signal: AbortSignal | undefined,
    resolve: Waiter["resolve"],
    reject: Waiter["reject"],
  ): void {
    const id = request.requestId;
    const queuedAt = this.now();
    const waiter: Waiter = {
      priority: request.priority,
      queuedAt,
      resolve,
      reject,
      timer: null,
      due: Math.min(deadlineMs, queuedAt + this.opts.limits.maxQueueWaitMs),
      detachAbort: noopDetach,
    };
    if (signal !== undefined) {
      const handler = this.onAbort(id, reject);
      signal.addEventListener("abort", handler, { once: true });
      waiter.detachAbort = (): void => {
        signal.removeEventListener("abort", handler);
      };
    }
    this.waiters.set(id, waiter);
    this.armTimer(id);
  }

  private onAbort(id: string, reject: Waiter["reject"]): () => void {
    return (): void => {
      if (!this.waiters.has(id)) {
        return;
      }
      this.policy.cancel(id);
      this.settle(id, "cancelled");
      reject(new RequestAdmissionError("Aborted", null, id));
      this.pump();
    };
  }

  // ── waiter lifecycle ─────────────────────────────────────────────────

  private observeWait(
    priority: RequestQueueWait["priority"],
    outcome: RequestQueueWait["outcome"],
    waitMs: number,
  ): void {
    try {
      this.opts.observeWait?.({ priority, outcome, waitMs });
    } catch {
      // A failed observation must not interrupt a reservation.
    }
  }

  private settle(id: string, outcome: RequestQueueWait["outcome"]): Waiter | undefined {
    const waiter = this.waiters.get(id);
    if (waiter === undefined) {
      return undefined;
    }
    this.waiters.delete(id);
    if (waiter.timer !== null) {
      this.clearTimer(waiter.timer);
      waiter.timer = null;
    }
    waiter.detachAbort();
    if (this.opts.observeWait !== undefined) {
      this.observeWait(waiter.priority, outcome, Math.max(0, this.now() - waiter.queuedAt));
    }
    return waiter;
  }

  private armTimer(id: string): void {
    const waiter = this.waiters.get(id);
    if (waiter === undefined) {
      return;
    }
    const delay = Math.min(MAX_TIMER_MS, Math.max(1, waiter.due - this.now()));
    waiter.timer = this.setTimer(() => {
      waiter.timer = null;
      this.pump();
      if (this.waiters.has(id)) {
        this.armTimer(id);
      }
    }, delay);
  }

  private makeRelease(id: string): Release {
    let released = false;
    return (): void => {
      if (released) {
        return;
      }
      released = true;
      this.policy.finishExecution(id);
      this.pump();
    };
  }

  // ── policy action application ────────────────────────────────────────

  private pump(): void {
    this.apply(this.policy.schedule());
    const active = this.activeLoad;
    if (active !== undefined && !this.policy.hasLoadDemand(active.id)) {
      active.controller.abort();
    }
  }

  private apply(actions: QueueAction[]): void {
    for (const action of actions) {
      this.applyAction(action);
    }
  }

  private runLoad(action: StartLoadAction): void {
    const controller = new AbortController();
    this.activeLoad = { id: action.loadId, controller };
    void Promise.resolve()
      .then(async () => {
        this.pump();
        if (controller.signal.aborted) return "abandoned" as const;
        try {
          await this.opts.load(action.modelKey, controller.signal);
          return "ready" as const;
        } catch {
          return "failed" as const;
        }
      })
      .then((outcome) => {
        this.activeLoad = undefined;
        this.apply(this.policy.loadSettled(action.loadId, outcome));
        this.pump();
      });
  }

  private applyAction(action: QueueAction): void {
    switch (action.kind) {
      case "start-execution": {
        this.settle(action.requestId, "admitted")?.resolve(this.makeRelease(action.requestId));
        return;
      }
      case "expire": {
        this.settle(action.requestId, "expired")?.reject(
          new RequestAdmissionError(action.reason, action.retryAfterMs, action.requestId),
        );
        return;
      }
      case "fail": {
        this.settle(action.requestId, "load_failed")?.reject(
          new RequestAdmissionError("LoadFailed", action.retryAfterMs, action.requestId),
        );
        return;
      }
      case "start-load": {
        this.runLoad({ loadId: action.loadId, modelKey: action.modelKey });
        return;
      }
    }
  }
}

export function createRequestAdmission(opts: RequestAdmissionOptions): ReservableRequestAdmission {
  return new RequestAdmissionImpl(opts);
}
