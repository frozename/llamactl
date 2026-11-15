/**
 * #281 (DF-08) the remote async request-admission wrapper over the #576 pure
 * queue policy: acquire() hands back a release-once closure, an AbortSignal or
 * a per-request deadline rejects a queued waiter, and overload surfaces as a
 * typed RequestAdmissionError code. This is only the wrapper; it is not wired
 * into any ingress yet.
 *
 * Still open:
 * - the create-proxy.ts and inference/procedures.ts wiring, which composes
 *   with the DF-05 #278 leases;
 * - holding the execution slot through the terminal HTTP / RPC stream;
 * - the mixed-ingress total-execution cap;
 * - queue fairness across ingress;
 * - no-orphan-load on cancellation.
 */

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

export interface RequestAdmissionOptions {
  limits: RequestQueueLimits;
  resident?: string[];
  load: (modelKey: string) => Promise<void>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface RequestAdmission {
  acquire: (request: AdmissionRequest, options?: AcquireOptions) => Promise<Release>;
  snapshot: () => QueueSnapshot;
}

// ── Internals ──────────────────────────────────────────────────────────────

const MAX_TIMER_MS = 2_147_483_647;

interface Waiter {
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

class RequestAdmissionImpl implements RequestAdmission {
  private readonly opts: RequestAdmissionOptions;
  private readonly now: Now;
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private readonly policy: RequestQueuePolicy;
  private readonly waiters = new Map<string, Waiter>();

  constructor(opts: RequestAdmissionOptions) {
    this.opts = opts;
    this.now = opts.now ?? defaultNow;
    this.setTimer = opts.setTimer ?? defaultSetTimer;
    this.clearTimer = opts.clearTimer ?? defaultClearTimer;
    this.policy = createRequestQueuePolicy({
      limits: opts.limits,
      now: this.now,
      ...(opts.resident !== undefined ? { resident: opts.resident } : {}),
    });
  }

  acquire(request: AdmissionRequest, options: AcquireOptions = {}): Promise<Release> {
    const id = request.requestId;
    if (options.signal?.aborted === true) {
      return Promise.reject(new RequestAdmissionError("Aborted", null, id));
    }
    const deadlineMs = options.deadlineMs ?? Number.POSITIVE_INFINITY;
    const result = this.policy.enqueue({ ...request, deadlineMs });
    if (result.kind === "duplicate") {
      return Promise.reject(new RequestAdmissionError("DuplicateRequest", null, id));
    }
    if (result.kind === "refused") {
      return Promise.reject(new RequestAdmissionError(result.reason, result.retryAfterMs, id));
    }
    return this.acquireQueued(id, deadlineMs, options.signal);
  }

  snapshot(): QueueSnapshot {
    return this.policy.snapshot();
  }

  // ── enqueue path ─────────────────────────────────────────────────────

  private acquireQueued(
    id: string,
    deadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<Release> {
    const promise = new Promise<Release>((resolve, reject) => {
      this.attachWaiter(id, deadlineMs, signal, resolve, reject);
    });
    this.pump();
    return promise;
  }

  private attachWaiter(
    id: string,
    deadlineMs: number,
    signal: AbortSignal | undefined,
    resolve: Waiter["resolve"],
    reject: Waiter["reject"],
  ): void {
    const waiter: Waiter = {
      resolve,
      reject,
      timer: null,
      due: Math.min(deadlineMs, this.now() + this.opts.limits.maxQueueWaitMs),
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
      this.settle(id);
      reject(new RequestAdmissionError("Aborted", null, id));
      this.pump();
    };
  }

  // ── waiter lifecycle ─────────────────────────────────────────────────

  private settle(id: string): Waiter | undefined {
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
  }

  private apply(actions: QueueAction[]): void {
    for (const action of actions) {
      this.applyAction(action);
    }
  }

  private runLoad(action: StartLoadAction): void {
    void Promise.resolve()
      .then(() => this.opts.load(action.modelKey))
      .then(
        () => "ready" as const,
        () => "failed" as const,
      )
      .then((outcome) => {
        this.apply(this.policy.loadSettled(action.loadId, outcome));
        this.pump();
      });
  }

  private applyAction(action: QueueAction): void {
    switch (action.kind) {
      case "start-execution": {
        this.settle(action.requestId)?.resolve(this.makeRelease(action.requestId));
        return;
      }
      case "expire": {
        this.settle(action.requestId)?.reject(
          new RequestAdmissionError(action.reason, action.retryAfterMs, action.requestId),
        );
        return;
      }
      case "fail": {
        this.settle(action.requestId)?.reject(
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

export function createRequestAdmission(opts: RequestAdmissionOptions): RequestAdmission {
  return new RequestAdmissionImpl(opts);
}
