import { describe, expect, test } from "bun:test";

import {
  type CallerSubscriptionHandlers,
  subscribeViaCaller,
} from "../src/client/caller-subscribe.js";

type CallerRecord = Record<string, (...args: unknown[]) => unknown>;
type CallerFactory = (signal: AbortSignal) => CallerRecord;

interface Recorder {
  events: string[];
  data: unknown[];
  errors: unknown[];
  counts: { started: number; complete: number };
  handlers: CallerSubscriptionHandlers;
  settled: Promise<void>;
}

function makeRecorder(withOnStarted = true): Recorder {
  let settle: (() => void) | undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const events: string[] = [];
  const data: unknown[] = [];
  const errors: unknown[] = [];
  const counts = { started: 0, complete: 0 };
  const handlers: CallerSubscriptionHandlers = {
    onData: (event) => {
      events.push("data");
      data.push(event);
    },
    onError: (err) => {
      events.push("error");
      errors.push(err);
      settle?.();
    },
    onComplete: () => {
      events.push("complete");
      counts.complete += 1;
      settle?.();
    },
  };
  if (withOnStarted) {
    handlers.onStarted = (): void => {
      events.push("started");
      counts.started += 1;
    };
  }
  return { events, data, errors, counts, handlers, settled };
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => {
      resolve();
    });
  });
}

async function* numbers(): AsyncGenerator<{ n: number }> {
  await Promise.resolve();
  yield { n: 1 };
  await Promise.resolve();
  yield { n: 2 };
}

const numbersCaller: CallerFactory = () => ({ stream: () => numbers() });

describe("subscribeViaCaller", () => {
  test("happy path delivers every event, completes, and closes the signal", async () => {
    const recorder = makeRecorder();
    const signals: AbortSignal[] = [];
    const abortsDuringStream: boolean[] = [];
    let receivedInput: unknown;
    const input = { cursor: 7 };

    subscribeViaCaller(
      (signal) => {
        signals.push(signal);
        return {
          stream: (received: unknown): AsyncGenerator<{ n: number }> => {
            receivedInput = received;
            return (async function* (): AsyncGenerator<{ n: number }> {
              await Promise.resolve();
              abortsDuringStream.push(signal.aborted);
              yield { n: 1 };
              await Promise.resolve();
              abortsDuringStream.push(signal.aborted);
              yield { n: 2 };
              abortsDuringStream.push(signal.aborted);
            })();
          },
        };
      },
      "stream",
      input,
      recorder.handlers,
    );

    await recorder.settled;

    expect(recorder.events).toEqual(["started", "data", "data", "complete"]);
    expect(recorder.data).toEqual([{ n: 1 }, { n: 2 }]);
    expect(recorder.counts.started).toBe(1);
    expect(recorder.counts.complete).toBe(1);
    expect(recorder.errors).toHaveLength(0);
    expect(receivedInput).toBe(input);
    expect(abortsDuringStream).toEqual([false, false, false]);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  test("unknown procedure settles via onError and never starts the stream", async () => {
    const recorder = makeRecorder();

    subscribeViaCaller((): CallerRecord => ({}), "nope", {}, recorder.handlers);

    await recorder.settled;

    expect(recorder.errors).toHaveLength(1);
    expect(recorder.errors[0]).toBeInstanceOf(Error);
    expect((recorder.errors[0] as Error).message).toBe("unknown procedure 'nope'");
    expect(recorder.counts.started).toBe(0);
    expect(recorder.data).toHaveLength(0);
    expect(recorder.counts.complete).toBe(0);
    expect(recorder.events).toEqual(["error"]);
  });

  test("a resolved non-iterable settles with the AsyncIterable error", async () => {
    const recorder = makeRecorder();

    subscribeViaCaller(
      (): CallerRecord => ({ m: () => Promise.resolve({}) }),
      "m",
      undefined,
      recorder.handlers,
    );

    await recorder.settled;

    expect(recorder.errors).toHaveLength(1);
    expect((recorder.errors[0] as Error).message).toBe(
      "inproc subscribe('m') did not return an AsyncIterable",
    );
    expect(recorder.counts.started).toBe(0);
    expect(recorder.counts.complete).toBe(0);
  });

  test("a mid-stream throw reaches onError with the same instance", async () => {
    const boom = new Error("boom");
    const recorder = makeRecorder();
    const caller: CallerFactory = () => ({
      stream: async function* (): AsyncGenerator<{ n: number }> {
        await Promise.resolve();
        yield { n: 1 };
        throw boom;
      },
    });

    subscribeViaCaller(caller, "stream", {}, recorder.handlers);

    await recorder.settled;

    expect(recorder.data).toEqual([{ n: 1 }]);
    expect(recorder.errors).toHaveLength(1);
    expect(recorder.errors[0]).toBe(boom);
    expect(recorder.counts.complete).toBe(0);
  });

  test("unsubscribing while pending settles as a clean completion", async () => {
    const recorder = makeRecorder();
    const signals: AbortSignal[] = [];
    const caller: CallerFactory = (signal) => {
      signals.push(signal);
      return {
        stream: async function* (): AsyncGenerator<{ n: number }> {
          yield { n: 1 };
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          });
          yield { n: 2 };
        },
      };
    };

    const { unsubscribe } = subscribeViaCaller(caller, "stream", {}, recorder.handlers);

    await flush();
    expect(recorder.data).toEqual([{ n: 1 }]);

    unsubscribe();
    await recorder.settled;

    expect(recorder.counts.complete).toBe(1);
    expect(recorder.errors).toHaveLength(0);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);

    unsubscribe();
    await flush();

    expect(recorder.counts.complete).toBe(1);
    expect(recorder.errors).toHaveLength(0);
    expect(recorder.data).toEqual([{ n: 1 }]);
    expect(recorder.events).toEqual(["started", "data", "complete"]);
  });

  test("omitting onStarted still completes the happy path", async () => {
    const recorder = makeRecorder(false);

    subscribeViaCaller(numbersCaller, "stream", {}, recorder.handlers);

    await recorder.settled;

    expect(recorder.events).toEqual(["data", "data", "complete"]);
    expect(recorder.data).toEqual([{ n: 1 }, { n: 2 }]);
    expect(recorder.counts.started).toBe(0);
    expect(recorder.counts.complete).toBe(1);
    expect(recorder.errors).toHaveLength(0);
  });
});
