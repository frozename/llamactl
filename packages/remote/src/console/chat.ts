import { openaiProxy } from "@llamactl/core";
import { loadConfig, resolveNode, resolveToken } from "@llamactl/core/config/kubeconfig";
import { LOCAL_NODE_ENDPOINT } from "@llamactl/core/config/schema";
import { z } from "zod";

import { makePinnedFetch } from "../client/links.js";
import { dispatchProxyRequest } from "../proxy/create-proxy.js";
import { jsonError } from "./guards.js";
import { CONSOLE_NODE_SEGMENT, validateConsoleNode } from "./node-route.js";

const CHAT_PATH = /^\/api\/n\/([^/]*)\/chat\/(models|completions)$/;
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const chatRequest = z.strictObject({
  model: z.string().min(1).max(512),
  messages: z
    .array(z.strictObject({ role: z.enum(["user", "assistant"]), content: z.string().min(1) }))
    .min(1)
    .max(100)
    .refine((messages) => messages.at(-1)?.role === "user"),
});
const modelCatalog = z.object({ data: z.array(z.object({ id: z.string().min(1).max(512) })) });

async function readJson(source: Request | Response, limit: number): Promise<unknown> {
  if (source.body === null) throw new Error("Missing body");
  const reader = source.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode()) as unknown;
      size += value.byteLength;
      if (size > limit) throw new RangeError("Body too large");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function forward(
  cfg: ReturnType<typeof loadConfig>,
  nodeName: string,
  path: "/v1/models" | "/v1/chat/completions",
  signal: AbortSignal,
  body?: string,
): Promise<Response> {
  const { node, user } = resolveNode(cfg, nodeName);
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  const method = body === undefined ? "GET" : "POST";
  const init = {
    method,
    headers,
    body: body ?? null,
    signal,
    redirect: "error",
  } satisfies RequestInit;
  if (node.endpoint === LOCAL_NODE_ENDPOINT) {
    if (path === "/v1/models") return Response.json(await openaiProxy.listServingOpenAIModels());
    return await dispatchProxyRequest(new Request(`http://local${path}`, init));
  }
  headers.set("authorization", `Bearer ${resolveToken(user)}`);
  return await makePinnedFetch(node)(`${node.endpoint.replace(/\/$/, "")}${path}`, init);
}

async function listModels(
  req: Request,
  cfg: ReturnType<typeof loadConfig>,
  node: string,
): Promise<Response> {
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(5000)]);
  const upstream = await forward(cfg, node, "/v1/models", signal);
  if (!upstream.ok) {
    void upstream.body?.cancel().catch(() => undefined);
    return jsonError(502, "model_catalog_unavailable");
  }
  const { data } = modelCatalog.parse(await readJson(upstream, MAX_CATALOG_BYTES));
  return Response.json(
    { models: [...new Set(data.map(({ id }) => id))] },
    { headers: { "cache-control": "no-store" } },
  );
}

async function complete(
  req: Request,
  cfg: ReturnType<typeof loadConfig>,
  node: string,
): Promise<Response> {
  let payload: z.infer<typeof chatRequest>;
  try {
    payload = chatRequest.parse(await readJson(req, MAX_PROMPT_BYTES));
  } catch (error) {
    return error instanceof RangeError
      ? jsonError(413, "chat_request_too_large")
      : jsonError(400, "invalid_chat_request");
  }
  const body = JSON.stringify({
    ...payload,
    stream: true,
    stream_options: { include_usage: true },
  });
  const upstream = await forward(cfg, node, "/v1/chat/completions", req.signal, body);
  const type = upstream.headers.get("content-type")?.split(";")[0]?.trim();
  if (upstream.ok && upstream.body && type === "text/event-stream") {
    return new Response(upstream.body, {
      headers: { "cache-control": "no-store", "content-type": "text/event-stream" },
    });
  }
  void upstream.body?.cancel().catch(() => undefined);
  if (upstream.status === 429 || upstream.status === 503) {
    return jsonError(upstream.status, "model_busy");
  }
  if (upstream.status === 404) return jsonError(404, "model_unavailable");
  if (upstream.status === 400) return jsonError(400, "model_rejected_chat");
  return jsonError(502, "chat_unavailable");
}

export function routeConsoleChat(req: Request, pathname: string): Promise<Response> | null {
  const match = CHAT_PATH.exec(pathname);
  return match === null ? null : handleChat(req, match[1] ?? "", match[2] === "models");
}

async function handleChat(req: Request, node: string, catalog: boolean): Promise<Response> {
  if (!CONSOLE_NODE_SEGMENT.test(node)) return jsonError(400, "bad_node");
  if (req.method !== (catalog ? "GET" : "POST")) return jsonError(405, "method_not_allowed");
  try {
    const cfg = loadConfig();
    const valid = validateConsoleNode(node, cfg);
    if (!valid.ok) return jsonError(valid.status, valid.error);
    return catalog ? await listModels(req, cfg, node) : await complete(req, cfg, node);
  } catch {
    return jsonError(502, catalog ? "model_catalog_unavailable" : "chat_unavailable");
  }
}
