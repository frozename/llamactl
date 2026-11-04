// Node-scoped console mount for #410 P3: `/api/n/:node/trpc/*`. The
// segment is validated raw (no decoding, so `%2F`/`%2C`/`%` fail) and
// against the kubeconfig on every request — no caching, so a rotated
// kubeconfig takes effect on the next call. Credentials are never read
// here; token resolution stays in resolveDispatchTarget.

import * as kubecfg from "@llamactl/core/config/kubeconfig";
import { LOCAL_NODE_ENDPOINT, resolveNodeKind } from "@llamactl/core/config/schema";

export const CONSOLE_NODE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

const NODE_PATH = /^\/api\/n\/([^/]*)\/trpc\/(.*)$/;

export function parseConsoleNodePath(
  pathname: string,
):
  | { kind: "none" }
  | { kind: "bad" }
  | { kind: "ok"; node: string; endpoint: string; procPath: string } {
  const match = NODE_PATH.exec(pathname);
  if (match === null) return { kind: "none" };
  const node = match[1] ?? "";
  if (!CONSOLE_NODE_SEGMENT.test(node)) return { kind: "bad" };
  return {
    endpoint: `/api/n/${node}/trpc`,
    kind: "ok",
    node,
    procPath: match[2] ?? "",
  };
}

export type ConsoleNodeCheck =
  | { ok: true; node: string }
  | {
      ok: false;
      status: 400 | 404 | 412;
      error:
        | "node_not_dispatchable"
        | "unknown_node"
        | "kubeconfig_unreadable"
        | "no_current_context";
    };

export function validateConsoleNode(name: string): ConsoleNodeCheck {
  let config;
  try {
    config = kubecfg.loadConfig();
  } catch {
    return { error: "kubeconfig_unreadable", ok: false, status: 412 };
  }
  const ctx = config.contexts.find((c) => c.name === config.currentContext);
  if (ctx === undefined) return { error: "no_current_context", ok: false, status: 412 };
  const cluster = config.clusters.find((c) => c.name === ctx.cluster);
  const node = cluster?.nodes.find((n) => n.name === name);
  if (node === undefined) return { error: "unknown_node", ok: false, status: 404 };
  if (node.endpoint === LOCAL_NODE_ENDPOINT || resolveNodeKind(node) === "agent") {
    return { node: name, ok: true };
  }
  return { error: "node_not_dispatchable", ok: false, status: 400 };
}
