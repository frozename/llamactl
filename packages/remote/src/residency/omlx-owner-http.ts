import { OMLX_ACTIVITY_PATH } from "@llamactl/core/engines";
import { type IncomingMessage, request } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { z } from "zod";

import { buildBaseUrl } from "./engine-client.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const VERSION = "0.8.4";
const MODELS_PATH = "/v1/models";
const statusSchema = z.object({ version: z.literal(VERSION) });
const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

function isPrivateHost(host: string): boolean {
  return host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}

function responseStatus(response: IncomingMessage): number {
  const status = response.statusCode ?? 502;
  if (status >= 300 && status < 400) {
    response.destroy();
    throw new Error("Owner oMLX endpoint redirected");
  }

  return status;
}

async function readResponse(response: IncomingMessage): Promise<Response> {
  const status = responseStatus(response);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response as AsyncIterable<Buffer>) {
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) throw new Error("Owner oMLX response too large");
    chunks.push(chunk);
  }
  const body = bytes === 0 ? null : new Uint8Array(Buffer.concat(chunks, bytes));
  return new Response(body, { status });
}

const COMPLETION_PATHS = new Set(["/v1/chat/completions", "/v1/completions"]);

function inferenceHeaders(init: RequestInit | undefined, key: string): Headers {
  const incoming = new Headers(init?.headers);
  const headers = new Headers({ authorization: `Bearer ${key}` });
  for (const name of ["accept", "content-type"]) {
    const value = incoming.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function streamResponse(response: IncomingMessage): Response {
  const status = responseStatus(response);
  const headers = new Headers();
  const contentType = response.headers["content-type"];
  if (contentType !== undefined) headers.set("content-type", contentType);
  if (status === 204 || status === 205) {
    response.resume();
    return new Response(null, { status, headers });
  }
  // Node's stream declarations differ from the DOM type, but Bun returns a Web stream.
  const body = Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
}

export function createOmlxOwnerFetch(
  endpoint: { host: string; port: number },
  options?: { inferenceKey: string },
): typeof globalThis.fetch {
  const { host, port } = endpoint;
  const origin = new URL(buildBaseUrl(host, port)).origin;
  const key = options?.inferenceKey;
  if (key !== undefined && (key.trim().length === 0 || !isPrivateHost(host))) {
    throw new Error("Owner oMLX inference requires an authenticated numeric loopback endpoint");
  }
  async function directFetch(input: Request | URL | string, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== origin || url.username || url.password) {
      throw new Error("Owner oMLX endpoint changed");
    }
    const body = key === undefined ? undefined : init?.body;
    if (
      key !== undefined &&
      (init?.method !== "POST" ||
        !COMPLETION_PATHS.has(url.pathname) ||
        url.search !== "" ||
        typeof body !== "string")
    ) {
      throw new Error("Unsupported owner oMLX inference request");
    }
    const headers = key === undefined ? new Headers(init?.headers) : inferenceHeaders(init, key);

    // Bun's ordinary fetch can proxy even a numeric loopback address.
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        {
          hostname: host,
          port,
          path: url.pathname + url.search,
          method: init?.method ?? "GET",
          headers: Object.fromEntries(headers),
          agent: false,
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        resolve,
      );
      req.once("error", reject);
      req.end(typeof body === "string" ? body : undefined);
    });
    return key === undefined ? await readResponse(response) : streamResponse(response);
  }
  return Object.assign(directFetch, { preconnect: (): void => undefined });
}

export async function verifyOmlxOwnerAuthentication({
  endpoint,
  apiKey,
  modelId,
  signal,
}: {
  endpoint: { host: string; port: number };
  apiKey: string;
  modelId: string;
  signal: AbortSignal;
}): Promise<boolean> {
  if (!isPrivateHost(endpoint.host) || apiKey.trim().length === 0 || signal.aborted) return false;
  try {
    const base = buildBaseUrl(endpoint.host, endpoint.port);
    const read = createOmlxOwnerFetch(endpoint);
    const owner = { signal, headers: { authorization: `Bearer ${apiKey}` } };
    const [anonymousStatus, anonymousModels, status, models] = await Promise.all([
      read(base + OMLX_ACTIVITY_PATH, { signal }),
      read(base + MODELS_PATH, { signal }),
      read(base + OMLX_ACTIVITY_PATH, owner),
      read(base + MODELS_PATH, owner),
    ]);
    signal.throwIfAborted();
    if (
      anonymousStatus.status !== 401 ||
      anonymousModels.status !== 401 ||
      !status.ok ||
      !models.ok
    ) {
      return false;
    }
    const modelList = modelsSchema.safeParse(await models.json());
    return (
      statusSchema.safeParse(await status.json()).success &&
      modelList.success &&
      modelList.data.data.some(({ id }) => id === modelId)
    );
  } catch {
    return false;
  }
}
