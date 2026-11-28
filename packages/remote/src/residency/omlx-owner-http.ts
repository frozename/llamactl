import { type IncomingMessage, request } from "node:http";

import { buildBaseUrl } from "./engine-client.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;

async function readResponse(response: IncomingMessage): Promise<Response> {
  const status = response.statusCode ?? 502;
  if (status >= 300 && status < 400) {
    response.destroy();
    throw new Error("Owner oMLX endpoint redirected");
  }

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

export function createOmlxOwnerFetch(endpoint: {
  host: string;
  port: number;
}): typeof globalThis.fetch {
  const origin = new URL(buildBaseUrl(endpoint.host, endpoint.port)).origin;
  async function directFetch(input: Request | URL | string, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== origin || url.username || url.password) {
      throw new Error("Owner oMLX endpoint changed");
    }

    // Bun's ordinary fetch can proxy even a numeric loopback address.
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        {
          hostname: endpoint.host,
          port: endpoint.port,
          path: url.pathname + url.search,
          method: init?.method ?? "GET",
          headers: Object.fromEntries(new Headers(init?.headers)),
          agent: false,
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        resolve,
      );
      req.once("error", reject);
      req.end();
    });
    return await readResponse(response);
  }
  return Object.assign(directFetch, { preconnect: (): void => undefined });
}
