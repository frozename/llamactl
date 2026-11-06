// packages/app/e2e/harness/fixtures/test.ts — #410 P5b part 2a.
// The single test entry for every console spec: an auto `control`
// fixture wrapping the loopback control routes of serve.ts (reset runs
// before EVERY test) and an auto `sentinelGuard` that fails the test
// post-hoc if any P2b-RED-9 sentinel reaches the rendered page or any
// same-origin response body. Specs never touch the control server by
// hand, and never import serve.ts or fixture-backend.ts (they pull in
// @trpc/server and Bun).

import type {
  APIRequestContext,
  APIResponse,
  Request as PlaywrightRequest,
  Route,
} from "@playwright/test";

import { test as base, expect } from "@playwright/test";

import { E2E_CONSOLE_PORT, E2E_CONTROL_PORT, E2E_SENTINEL_VALUES } from "./seed";

export type ServerStopMode = "not-stopped" | "ok" | "throw";

export interface RecordedCall {
  input: unknown;
  node: string;
  procedure: string;
}

export interface StreamEntry {
  node: string;
  open: boolean;
  workload: string;
}

export interface ControlClient {
  calls(node: string): Promise<RecordedCall[]>;
  dropStream(node: string, workload: string): Promise<void>;
  emitLog(node: string, workload: string, line: string): Promise<void>;
  reset(): Promise<void>;
  setReachable(node: string, reachable: boolean): Promise<void>;
  setServerStopMode(mode: ServerStopMode): Promise<void>;
  streams(node: string): Promise<StreamEntry[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function failed(path: string, res: APIResponse): Promise<never> {
  const status = String(res.status());
  await res.dispose();
  throw new Error(`control ${path} failed with status ${status}`);
}

async function postControl(
  context: APIRequestContext,
  path: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const res = await context.post(path, data === undefined ? {} : { data });
  if (!res.ok()) return await failed(path, res);
  await res.dispose();
}

async function getControl(context: APIRequestContext, path: string): Promise<unknown> {
  const res = await context.get(path);
  if (!res.ok()) return await failed(path, res);
  return await res.json();
}

function callsFrom(body: unknown): RecordedCall[] {
  const list = isRecord(body) ? body["calls"] : undefined;
  if (!Array.isArray(list)) throw new Error("control /calls response missing calls array");
  const out: RecordedCall[] = [];
  for (const item of list) {
    if (
      !isRecord(item) ||
      typeof item["procedure"] !== "string" ||
      typeof item["node"] !== "string"
    ) {
      throw new Error("control /calls entry malformed");
    }
    out.push({ input: item["input"], node: item["node"], procedure: item["procedure"] });
  }
  return out;
}

function streamsFrom(body: unknown): StreamEntry[] {
  const list = isRecord(body) ? body["streams"] : undefined;
  if (!Array.isArray(list)) throw new Error("control /streams response missing streams array");
  const out: StreamEntry[] = [];
  for (const item of list) {
    if (
      !isRecord(item) ||
      typeof item["node"] !== "string" ||
      typeof item["open"] !== "boolean" ||
      typeof item["workload"] !== "string"
    ) {
      throw new Error("control /streams entry malformed");
    }
    out.push({ node: item["node"], open: item["open"], workload: item["workload"] });
  }
  return out;
}

function createControlClient(context: APIRequestContext): ControlClient {
  return {
    calls: (node) => getControl(context, `/calls?node=${encodeURIComponent(node)}`).then(callsFrom),
    dropStream: (node, workload) => postControl(context, "/drop-stream", { node, workload }),
    emitLog: (node, workload, line) => postControl(context, "/emit-log", { line, node, workload }),
    reset: () => postControl(context, "/reset"),
    setReachable: (node, reachable) => postControl(context, "/reachability", { node, reachable }),
    setServerStopMode: (mode) => postControl(context, "/server-stop-mode", { mode }),
    streams: (node) =>
      getControl(context, `/streams?node=${encodeURIComponent(node)}`).then(streamsFrom),
  };
}

const CONSOLE_ORIGIN = `http://127.0.0.1:${String(E2E_CONSOLE_PORT)}`;

const TRPC_API = /\/api\/n\/[^/]+\/trpc\//;

function trpcSegments(url: URL): string[] | null {
  const at = url.pathname.indexOf("/trpc/");
  if (at < 0) return null;
  try {
    return decodeURIComponent(url.pathname.slice(at + "/trpc/".length)).split(",");
  } catch {
    return null;
  }
}

function batchInputs(request: PlaywrightRequest, url: URL): Record<string, unknown> | null {
  const raw = request.method() === "GET" ? url.searchParams.get("input") : request.postData();
  if (raw === null || raw === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// The console guard rejects any batch that repeats a procedure name
// (checkConsoleTrpcPath → 400 bad_batch, pinned by remote's batch
// tests), while the fleet + nodes views fire one nodeTest query per
// row and tRPC's batch link folds them into `nodeTest,nodeTest,…` —
// every reachability probe would error. The harness splits exactly
// those batches into one sub-request per segment and reassembles the
// array response; every other request passes through untouched.
async function fetchSplitItem(
  route: Route,
  request: PlaywrightRequest,
  url: URL,
  proc: string,
  input: unknown,
): Promise<unknown> {
  const sub = new URL(url.href);
  sub.pathname = `${url.pathname.slice(0, url.pathname.indexOf("/trpc/"))}/trpc/${proc}`;
  const headers: Record<string, string> = {
    ...request.headers(),
    "sec-fetch-site": "same-origin",
  };
  let postData: string | undefined;
  if (request.method() === "GET") {
    if (input === undefined) sub.searchParams.delete("input");
    else sub.searchParams.set("input", JSON.stringify({ "0": input }));
  } else {
    delete headers["content-length"];
    postData = JSON.stringify(input === undefined ? {} : { "0": input });
  }
  const options: Parameters<Route["fetch"]>[0] =
    postData === undefined ? { headers, url: sub.href } : { headers, postData, url: sub.href };
  const res = await route.fetch(options);
  return await firstBatchItem(res);
}

async function splitDuplicateBatch(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const segments = trpcSegments(url);
  const inputs = segments === null ? null : batchInputs(request, url);
  if (
    segments === null ||
    inputs === null ||
    segments.length < 2 ||
    new Set(segments).size === segments.length
  ) {
    await route.fallback();
    return;
  }
  const results: unknown[] = [];
  try {
    for (const [index, proc] of segments.entries()) {
      results.push(await fetchSplitItem(route, request, url, proc, inputs[String(index)]));
    }
  } catch {
    await route.fulfill({
      body: JSON.stringify({ error: { message: "e2e_batch_split_failed" } }),
      contentType: "application/json",
      status: 502,
    });
    return;
  }
  await route.fulfill({
    body: JSON.stringify(results),
    contentType: "application/json",
    status: 200,
  });
}

async function firstBatchItem(res: APIResponse): Promise<unknown> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = null;
  }
  if (Array.isArray(body)) {
    const items = body as unknown[];
    return items[0] ?? null;
  }
  return body;
}

// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- void is the Playwright fixture spelling.
export const test = base.extend<{ control: ControlClient; sentinelGuard: void }>({
  control: [
    async ({ playwright }, use): Promise<void> => {
      const context = await playwright.request.newContext({
        baseURL: `http://127.0.0.1:${String(E2E_CONTROL_PORT)}`,
      });
      try {
        await postControl(context, "/reset");
        await use(createControlClient(context));
      } finally {
        await context.dispose();
      }
    },
    { auto: true },
  ],
  sentinelGuard: [
    async ({ page }, use): Promise<void> => {
      await page.route(TRPC_API, splitDuplicateBatch);
      const bodies: Promise<string>[] = [];
      page.on("response", (response) => {
        const contentType = response.headers()["content-type"] ?? "";
        if (
          !response.url().startsWith(CONSOLE_ORIGIN) ||
          contentType.includes("text/event-stream")
        ) {
          return;
        }
        bodies.push(response.text().catch(() => ""));
      });
      await use();
      const rendered = await page.content();
      const collected: string[] = [];
      for (const pending of bodies) collected.push(await pending);
      for (const sentinel of E2E_SENTINEL_VALUES) {
        expect(rendered).not.toContain(sentinel);
        for (const body of collected) {
          expect(body).not.toContain(sentinel);
        }
      }
    },
    { auto: true },
  ],
});

export { expect };
