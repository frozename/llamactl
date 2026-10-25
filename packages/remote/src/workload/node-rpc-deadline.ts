/**
 * Per-call deadlines for controller → node RPCs. A node that stops
 * answering without closing the TCP connection (suspend, Wi-Fi drop)
 * would otherwise stall the whole reconcile pass for minutes.
 * Subscriptions are already bounded by timers in apply.ts; this
 * covers the unbounded .query / .mutate calls.
 */

export const DEFAULT_NODE_RPC_QUERY_TIMEOUT_MS = 10_000;
export const DEFAULT_NODE_RPC_MUTATE_TIMEOUT_MS = 30_000;

export interface NodeRpcTimeouts {
  queryMs: number;
  mutateMs: number;
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

export function withNodeRpcDeadline<T extends object>(
  client: T,
  node: string,
  timeouts: NodeRpcTimeouts,
): T {
  return new Proxy(client, {
    get(target, prop): unknown {
      const value: unknown = Reflect.get(target, prop);
      if (typeof prop !== "string") return value;
      if (typeof value === "function" || (typeof value === "object" && value !== null)) {
        return wrapProcedure(value, prop, node, timeouts);
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
): T {
  return new Proxy(procedure, {
    get(target, prop): unknown {
      const value: unknown = Reflect.get(target, prop);
      if (typeof prop !== "string" || (prop !== "query" && prop !== "mutate")) return value;
      if (typeof value !== "function") return value;
      const timeoutMs = prop === "query" ? timeouts.queryMs : timeouts.mutateMs;
      const label = `${name}.${prop}`;
      return (...args: unknown[]): Promise<unknown> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject): void => {
          timer = setTimeout((): void => {
            reject(new NodeRpcTimeoutError(node, label, timeoutMs));
          }, timeoutMs);
        });
        const call = Promise.resolve().then((): unknown => Reflect.apply(value, target, args));
        return Promise.race([deadline, call]).finally((): void => {
          clearTimeout(timer);
        });
      };
    },
  });
}
