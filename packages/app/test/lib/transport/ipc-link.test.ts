// packages/app/test/lib/transport/ipc-link.test.ts
// Issue #410, P1 RED 5 — Electron parity for the moved IPC link. The fake
// bridge records sendMessage payloads and captures the onMessage listener,
// so the request/response envelope contract is pinned without a real
// preload. Saving and restoring globalThis.electronTRPC mirrors
// chat-stream-ownership.test.ts.

import type { TRPCLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";

import { createTRPCClient, TRPCClientError } from "@trpc/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const IPC_TRANSPORT_SPEC = "../../../src/lib/transport/ipc.ts";

interface IpcTransportModule {
  ipcLink?: <TRouter extends AnyRouter>() => TRPCLink<TRouter>;
}

interface TrpcModule {
  createAppClient?: unknown;
}

interface SentMessage {
  method?: string;
  operation?: {
    id?: number | string;
    type?: string;
    path?: string;
    input?: unknown;
  };
}

interface NodeListClient {
  nodeList: { query: () => Promise<unknown> };
}

const sentMessages: SentMessage[] = [];
const messageListeners: ((msg: unknown) => void)[] = [];

let hadBridge = false;
let prevBridge: typeof globalThis.electronTRPC;

beforeAll(() => {
  hadBridge = "electronTRPC" in globalThis;
  prevBridge = globalThis.electronTRPC;
  globalThis.electronTRPC = {
    sendMessage: (msg: unknown): void => {
      sentMessages.push(msg as SentMessage);
    },
    onMessage: (cb: (msg: unknown) => void): void => {
      messageListeners.push(cb);
    },
  };
});

beforeEach(() => {
  sentMessages.length = 0;
  messageListeners.length = 0;
});

afterAll(() => {
  if (hadBridge) {
    globalThis.electronTRPC = prevBridge;
  } else {
    delete (globalThis as { electronTRPC?: unknown }).electronTRPC;
  }
});

async function importIpcTransport(): Promise<IpcTransportModule | null> {
  return (await import(IPC_TRANSPORT_SPEC).catch(() => null)) as IpcTransportModule | null;
}

function makeNodeListClient(ipcLink: NonNullable<IpcTransportModule["ipcLink"]>): NodeListClient {
  return createTRPCClient<AnyRouter>({
    links: [ipcLink<AnyRouter>()],
  }) as unknown as NodeListClient;
}

function lastSentOperation(): NonNullable<SentMessage["operation"]> {
  const sent = sentMessages.at(-1);
  expect(sent?.method).toBe("request");
  expect(sent?.operation).toBeDefined();
  return sent!.operation!;
}

function lastListener(): (msg: unknown) => void {
  const listener = messageListeners.at(-1);
  expect(listener).toBeFunction();
  return listener!;
}

describe("transport/ipc ipcLink (#410 P1)", () => {
  test("query envelopes round-trip through the electron bridge", async () => {
    const mod = await importIpcTransport();
    expect(mod?.ipcLink).toBeFunction();

    const client = makeNodeListClient(mod!.ipcLink!);
    const promise = client.nodeList.query();

    expect(sentMessages).toHaveLength(1);
    const operation = lastSentOperation();
    expect(operation.type).toBe("query");
    expect(operation.path).toBe("nodeList");
    expect(operation.id).toBeDefined();

    lastListener()({ id: operation.id, result: { type: "data", data: 42 } });
    expect(await promise).toBe(42);
  });

  test("error envelopes reject with TRPCClientError", async () => {
    const mod = await importIpcTransport();
    expect(mod?.ipcLink).toBeFunction();

    const client = makeNodeListClient(mod!.ipcLink!);
    const promise = client.nodeList.query();

    const operation = lastSentOperation();
    lastListener()({ id: operation.id, error: { code: -32603, message: "boom" } });
    const rejection: unknown = await promise.catch((err: unknown) => err);
    expect(rejection).toBeInstanceOf(TRPCClientError);
  });

  test("registers one onMessage listener per link initialisation across two requests", async () => {
    const mod = await importIpcTransport();
    expect(mod?.ipcLink).toBeFunction();

    const client = makeNodeListClient(mod!.ipcLink!);

    const first = client.nodeList.query();
    lastListener()({
      id: lastSentOperation().id,
      result: { type: "data", data: 1 },
    });
    expect(await first).toBe(1);

    const second = client.nodeList.query();
    lastListener()({
      id: lastSentOperation().id,
      result: { type: "data", data: 2 },
    });
    expect(await second).toBe(2);

    expect(sentMessages).toHaveLength(2);
    expect(messageListeners).toHaveLength(1);
  });

  test("src/lib/trpc.ts exports createAppClient so links are injected, not built at module scope", async () => {
    const trpc = (await import("../../../src/lib/trpc.ts").catch(() => null)) as TrpcModule | null;

    expect(trpc?.createAppClient).toBeFunction();
  });
});
