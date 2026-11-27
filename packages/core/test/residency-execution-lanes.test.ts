import { expect, test } from "bun:test";

import {
  createRequestQueuePolicy,
  modelKeyOf,
  type QueueRequest,
} from "../src/residency/queue-policy.js";

test("an aged background request drains foreground slots before running alone", () => {
  let now = 0;
  const model = { name: "shared-device", revision: "1" };
  const options = {
    exclusiveBackground: true,
    resident: [modelKeyOf(model)],
    now: (): number => now,
    limits: {
      maxExecutions: 2,
      maxQueued: 8,
      maxQueuedBytes: 8192,
      maxQueueWaitMs: 100,
      maxPerPrincipal: 8,
      starvationBoundMs: 25,
      maxContextTokens: 8192,
      retryAfterMs: 1000,
    },
  };
  const queue = createRequestQueuePolicy(options);
  function enqueue(requestId: string, priority: QueueRequest["priority"]): void {
    expect(
      queue.enqueue({
        requestId,
        priority,
        model,
        principal: "client",
        bytes: 16,
        promptTokens: 4,
        maxCompletionTokens: 4,
        deadlineMs: 100,
      }).kind,
    ).toBe("queued");
  }
  enqueue("fg-1", "interactive");
  enqueue("bg", "background");
  expect(queue.schedule().map((a) => ("requestId" in a ? a.requestId : a.kind))).toEqual(["fg-1"]);
  now = 26;
  enqueue("fg-2", "interactive");
  expect(queue.schedule()).toEqual([]);
  queue.finishExecution("fg-1");
  expect(queue.schedule()).toEqual([
    { kind: "start-execution", requestId: "bg", modelKey: modelKeyOf(model) },
  ]);
  expect(queue.snapshot().executing).toBe(1);
  queue.finishExecution("bg");
  expect(queue.schedule()).toEqual([
    { kind: "start-execution", requestId: "fg-2", modelKey: modelKeyOf(model) },
  ]);
});
