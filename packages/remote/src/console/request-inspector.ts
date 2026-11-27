import { loadConfig, resolveNode, resolveToken } from "@llamactl/core/config/kubeconfig";
import { LOCAL_NODE_ENDPOINT } from "@llamactl/core/config/schema";

import { makePinnedFetch } from "../client/links.js";
import { CAPTURE_PATH, captureResponse, REQUEST_ID } from "../request-capture/store.js";
import { jsonError } from "./guards.js";
import { CONSOLE_NODE_SEGMENT, validateConsoleNode } from "./node-route.js";

const ROUTE = /^\/api\/n\/([^/]*)\/requests(?:\/([^/]+))?$/;

export function routeRequestInspector(req: Request, pathname: string): Promise<Response> | null {
  const match = ROUTE.exec(pathname);
  return match ? inspect(req, match[1] ?? "", match[2]) : null;
}

async function inspect(req: Request, nodeName: string, id: string | undefined): Promise<Response> {
  if (!CONSOLE_NODE_SEGMENT.test(nodeName)) return jsonError(400, "bad_node");
  if (id !== undefined && !REQUEST_ID.test(id)) return jsonError(404, "request_not_found");
  if (req.method !== "GET") return jsonError(405, "method_not_allowed");
  try {
    const cfg = loadConfig();
    const valid = validateConsoleNode(nodeName, cfg);
    if (!valid.ok) return jsonError(valid.status, valid.error);
    const { node, user } = resolveNode(cfg, nodeName);
    if (node.endpoint === LOCAL_NODE_ENDPOINT) return captureResponse(id);
    return await remoteCapture(req, node, resolveToken(user), id);
  } catch {
    return jsonError(502, "capture_unavailable");
  }
}

async function remoteCapture(
  req: Request,
  node: ReturnType<typeof resolveNode>["node"],
  token: string,
  id: string | undefined,
): Promise<Response> {
  const path = id === undefined ? CAPTURE_PATH : `${CAPTURE_PATH}/${id}`;
  const result = await makePinnedFetch(node)(node.endpoint.replace(/\/$/, "") + path, {
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.any([req.signal, AbortSignal.timeout(5000)]),
  });
  const headers = { "cache-control": "no-store", "content-type": "application/json" };
  if (result.ok && result.headers.get("content-type")?.includes("application/json")) {
    return new Response(result.body, { headers });
  }
  void result.body?.cancel().catch(() => undefined);
  if (id === undefined && result.status === 404) {
    return Response.json({ enabled: false, requests: [] }, { headers });
  }
  return new Response(
    JSON.stringify({ error: result.status === 404 ? "request_not_found" : "capture_unavailable" }),
    { headers, status: result.status === 404 ? 404 : 502 },
  );
}
