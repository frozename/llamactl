import type { TunnelReq } from './messages.js';

/**
 * Agent-side bridge between the reverse tunnel's `req` frames and a
 * tRPC `createCaller`-shaped surface. Given a tRPC caller
 * (`appRouter.createCaller(ctx)`), returns a function the tunnel
 * client can use as its `handleRequest`:
 *
 *   const caller = appRouter.createCaller({ env, auth });
 *   const handle = createTunnelRouterHandler(caller);
 *   const client = createTunnelClient({ url, bearer, nodeName,
 *                                       handleRequest: handle });
 *
 * Frame contract:
 *   req.method = "dot.separated.path.to.procedure"
 *   req.params = { type: 'query' | 'mutation', input: unknown }
 *
 * `type` disambiguates query vs mutation when a procedure name is
 * unique either way; the caller proxy is invoked the same way
 * regardless so we accept both and pass input straight through.
 *
 * Missing / unknown procedure → the handler throws, which the
 * tunnel client surfaces as `res.error`. Malformed params → throws.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCaller = any;

export interface TunnelRouterParams {
  /** 'query' | 'mutation' — informational; the caller proxy treats
   *  both identically for non-streaming procedures. */
  type?: 'query' | 'mutation';
  input?: unknown;
}

export function createTunnelRouterHandler(
  caller: AnyCaller,
): (req: TunnelReq) => Promise<unknown> {
  return async (req: TunnelReq) => {
    const method = req.method;
    const params = (req.params ?? {}) as TunnelRouterParams;
    const target = walkCaller(caller, method);
    if (target === undefined) {
      throw new Error(`unknown procedure: ${method}`);
    }
    // tRPC's caller exposes procedures as callables that accept the
    // input directly and return a promise; the method-name path is
    // traversal, not method-call magic.
    return await target(params.input);
  };
}

/**
 * Walk a dotted procedure path into the caller. Returns the
 * invokable at the leaf or undefined when any segment is missing /
 * non-callable. Narrow `any` usage — tRPC v11's caller types are
 * structurally callable but don't expose a typed walker.
 *
 * Property access is permitted on both 'object' and 'function'
 * cursors: tRPC v11's createCaller returns a Proxy whose top-level
 * `typeof` is 'function' (the callable target), even though property
 * access into procedures still works. Restricting to 'object' would
 * fail on the very first segment for any real caller.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walkCaller(caller: any, method: string): ((input: unknown) => Promise<unknown>) | undefined {
  const parts = method.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cursor: any = caller;
  for (const part of parts) {
    if (cursor == null) return undefined;
    if (typeof cursor !== 'object' && typeof cursor !== 'function') return undefined;
    cursor = cursor[part];
    if (cursor === undefined) return undefined;
  }
  if (typeof cursor !== 'function') return undefined;
  // Don't use cursor.bind(caller): tRPC v11's caller is a Proxy that
  // intercepts EVERY property access (including `.bind`) and treats
  // it as another procedure-path segment, so cursor.bind would walk
  // into the proxy and 404. Use the prototype method directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Function.prototype.bind.call(cursor, caller) as (input: unknown) => Promise<unknown>;
}
