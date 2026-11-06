// packages/app/e2e/harness/fixtures/test.ts — #410 P5b part 2a.
// The single test entry for every console spec: an auto `control`
// fixture wrapping the loopback control routes of serve.ts (reset runs
// before EVERY test) and an auto `sentinelGuard` that fails the test
// post-hoc if any P2b-RED-9 sentinel reaches the rendered page or any
// same-origin response body. Specs never touch the control server by
// hand, and never import serve.ts or fixture-backend.ts (they pull in
// @trpc/server and Bun).

import type { APIRequestContext, APIResponse } from "@playwright/test";

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
