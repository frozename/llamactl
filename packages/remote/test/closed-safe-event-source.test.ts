import type { ClusterNode } from "@llamactl/core/config/schema";

import { createTRPCClient, httpSubscriptionLink } from "@trpc/client";
import { initTRPC } from "@trpc/server";
import { expect, test } from "bun:test";

import { ClosedSafeEventSource } from "../src/client/closed-safe-event-source.js";
import { buildPinnedLinks, type PinnedFetch } from "../src/client/links.js";

const t = initTRPC.create();
const router = t.router({
  s: t.procedure.subscription(async function* () {
    await Promise.resolve();
    yield 1;
  }),
});

type Router = typeof router;

function makeAbortIgnoringStream(): { fetch: PinnedFetch; push: (chunk: string) => void } {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const fetch: PinnedFetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(c): void {
            controller = c;
            queueMicrotask(() => {
              c.enqueue(encoder.encode("event: connected\ndata: {}\n\ndata: 1\n\n"));
            });
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
  return {
    fetch,
    push: (chunk: string): void => {
      controller.enqueue(encoder.encode(chunk));
    },
  };
}

async function runLateReturnScenario(
  links: ReturnType<typeof buildPinnedLinks>,
  stream: ReturnType<typeof makeAbortIgnoringStream>,
  lateChunk = "event: return\ndata: \n\n",
): Promise<void> {
  const client = createTRPCClient<Router>({ links });
  let dataCount = 0;
  let sub: ReturnType<typeof client.s.subscribe> | undefined;
  const dataReceived = new Promise<void>((resolve, reject) => {
    sub = client.s.subscribe(undefined, {
      onData: () => {
        dataCount++;
        sub?.unsubscribe();
        resolve();
      },
      onError: reject,
    });
  });
  await dataReceived;
  stream.push(lateChunk);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(dataCount).toBe(1);
}

test("ClosedSafeEventSource ignores a late return event after unsubscribe", async () => {
  const stream = makeAbortIgnoringStream();
  const links: ReturnType<typeof buildPinnedLinks> = [
    httpSubscriptionLink({
      url: "http://127.0.0.1:1/trpc",
      EventSource: ClosedSafeEventSource,
      eventSourceOptions: { fetch: stream.fetch },
    }),
  ];
  await runLateReturnScenario(links, stream);
});

test("buildPinnedLinks ignores a late return event after unsubscribe", async () => {
  const node: ClusterNode = { name: "n", endpoint: "http://127.0.0.1:1" };
  const stream = makeAbortIgnoringStream();
  await runLateReturnScenario(
    buildPinnedLinks(node, "tok", () => stream.fetch),
    stream,
  );
});

test("buildPinnedLinks drops a late chunk carrying data and return after unsubscribe", async () => {
  const node: ClusterNode = { name: "n", endpoint: "http://127.0.0.1:1" };
  const stream = makeAbortIgnoringStream();
  await runLateReturnScenario(
    buildPinnedLinks(node, "tok", () => stream.fetch),
    stream,
    "data: 2\n\nevent: return\ndata: \n\n",
  );
});

test("buildPinnedLinks reports a failed SSE response as an error", async () => {
  const node: ClusterNode = { name: "n", endpoint: "http://127.0.0.1:1" };
  const failing: PinnedFetch = () => Promise.resolve(new Response("nope", { status: 500 }));
  const client = createTRPCClient<Router>({ links: buildPinnedLinks(node, "tok", () => failing) });
  const outcome = await new Promise<string>((resolve) => {
    let settled = false;
    const settle = (value: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const sub = client.s.subscribe(undefined, {
      onData: () => {
        settle("data");
      },
      onError: () => {
        settle("error");
      },
      onComplete: () => {
        settle("complete");
      },
    });
    const timer = setTimeout(() => {
      sub.unsubscribe();
      settle("timeout");
    }, 2000);
  });
  expect(outcome).toBe("error");
});
