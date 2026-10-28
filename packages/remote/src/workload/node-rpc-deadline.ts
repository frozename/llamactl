/**
 * Per-call deadlines for controller → node RPCs. A node that stops
 * answering without closing the TCP connection (suspend, Wi-Fi drop)
 * would otherwise stall the whole reconcile pass for minutes.
 * Subscriptions are already bounded by timers in apply.ts; this
 * covers the unbounded .query / .mutate calls. Within one reconcile
 * pass, once a node has timed out, the remaining calls to it in that
 * pass fail fast via NodeRpcSkippedError (see NodeRpcPassState).
 * A null mutateMs leaves mutations unbounded.
 * When the deadline fires, the AbortSignal passed to the call as its { signal } option is aborted, so the transport drops the request.
 */

export const DEFAULT_NODE_RPC_QUERY_TIMEOUT_MS = 10_000;
export const DEFAULT_NODE_RPC_MUTATE_TIMEOUT_MS = 30_000;

export interface NodeRpcTimeouts {
  queryMs: number;
  /** null leaves .mutate unbounded: the wrapper hands back the procedure's own mutate.
   *  Never use Infinity or a huge number for that: setTimeout clamps delays above
   *  2^31-1 ms to 1 ms. */
  mutateMs: number | null;
}

export class NodeRpcTimeoutError extends Error {
  override name = "NodeRpcTimeoutError";
  readonly node: string;
  readonly procedure: string;
  readonly timeoutMs: number;

  constructor(node: string, procedure: string, timeoutMs: number) {
    super(`node '${node}' did not respond to ${procedure} within ${String(timeoutMs)} ms`);
    this.node = node;
    this.procedure = procedure;
    this.timeoutMs = timeoutMs;
  }
}

/** One instance per reconcile pass; records the first timeout seen for each node. */
export interface NodeRpcPassState {
  timedOut: Map<string, NodeRpcTimeoutError>;
}

export class NodeRpcSkippedError extends Error {
  override name = "NodeRpcSkippedError";
  readonly node: string;
  readonly procedure: string;
  readonly earlier: NodeRpcTimeoutError;

  constructor(node: string, procedure: string, earlier: NodeRpcTimeoutError) {
    super(
      `node '${node}' skipped ${procedure} for this pass: ${earlier.procedure} timed out after ${String(earlier.timeoutMs)} ms`,
    );
    this.node = node;
    this.procedure = procedure;
    this.earlier = earlier;
  }
}

export function withNodeRpcDeadline<T extends object>(
  client: T,
  node: string,
  timeouts: NodeRpcTimeouts,
  pass?: NodeRpcPassState,
): T {
  return new Proxy(client, {
    get(target, prop): unknown {
      const value: unknown = Reflect.get(target, prop);
      if (typeof prop !== "string") return value;
      if (typeof value === "function" || (typeof value === "object" && value !== null)) {
        return wrapProcedure(value, prop, node, timeouts, pass);
      }
      return value;
    },
  });
}

function wrapProcedure<T extends object>(
  procedure: T,
  name: string,
  node: string,
  timeouts: NodeRpcTimeouts,
  pass?: NodeRpcPassState,
): T {
  return new Proxy(procedure, {
    get(target, prop): unknown {
      const value: unknown = Reflect.get(target, prop);
      if (typeof prop !== "string" || (prop !== "query" && prop !== "mutate")) return value;
      const timeoutMs = prop === "query" ? timeouts.queryMs : timeouts.mutateMs;
      // #221: a null deadline leaves the call unbounded; return the procedure's own function.
      if (typeof value !== "function" || timeoutMs === null) return value;
      const label = `${name}.${prop}`;
      return (...args: unknown[]): Promise<unknown> => {
        const earlier = pass?.timedOut.get(node);
        if (earlier) return Promise.reject(new NodeRpcSkippedError(node, label, earlier));
        // #221: abort the underlying request (and free its socket) when the deadline fires.
        const controller = new AbortController();
        const callArgs: unknown[] = [args[0], withAbortSignal(args[1], controller.signal)];
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject): void => {
          timer = setTimeout((): void => {
            const err = new NodeRpcTimeoutError(node, label, timeoutMs);
            if (pass !== undefined && !pass.timedOut.has(node)) {
              pass.timedOut.set(node, err);
            }
            reject(err);
            controller.abort(err);
          }, timeoutMs);
        });
        const call = Promise.resolve().then((): unknown => Reflect.apply(value, target, callArgs));
        return Promise.race([deadline, call]).finally((): void => {
          clearTimeout(timer);
        });
      };
    },
  });
}

/** #221: the caller's request options with `signal` replaced by ours, composed with any caller signal. */
function withAbortSignal(options: unknown, signal: AbortSignal): Record<string, unknown> {
  const base =
    typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
  const callerSignal = base["signal"];
  return {
    ...base,
    signal: callerSignal instanceof AbortSignal ? AbortSignal.any([signal, callerSignal]) : signal,
  };
}
