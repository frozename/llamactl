import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const llamactlMcpReal = { ...(await import("@llamactl/mcp")) };
const novaMcpReal = { ...(await import("@nova/mcp")) };
const clientReal = { ...(await import("@modelcontextprotocol/sdk/client/index.js")) };
const transportReal = { ...(await import("@modelcontextprotocol/sdk/inMemory.js")) };

type ServerName = "llamactl" | "nova";

interface ServerRecord {
  name: ServerName;
  connected: number;
  closed: number;
}

interface ClientRecord {
  name: string;
  connected: number;
  closed: number;
}

const state: {
  servers: ServerRecord[];
  clients: ClientRecord[];
  rejectClientConnectFor: string | null;
  rejectServerConnectFor: ServerName | null;
} = {
  servers: [],
  clients: [],
  rejectClientConnectFor: null,
  rejectServerConnectFor: null,
};

class FakeClient {
  private readonly record: ClientRecord;

  constructor(opts: { name: string; version: string }) {
    void opts.version;
    this.record = { name: opts.name, connected: 0, closed: 0 };
    state.clients.push(this.record);
  }

  connect(_transport: unknown): Promise<void> {
    this.record.connected++;
    if (state.rejectClientConnectFor === this.record.name) {
      return Promise.reject(new Error(`client connect failed: ${this.record.name}`));
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.record.closed++;
    return Promise.resolve();
  }

  callTool(): Promise<unknown> {
    return Promise.resolve({});
  }

  listTools(): Promise<{ tools: [] }> {
    return Promise.resolve({ tools: [] });
  }
}

function makeServer(name: ServerName): {
  connect: (_transport: unknown) => Promise<void>;
  close: () => Promise<void>;
} {
  const record: ServerRecord = { name, connected: 0, closed: 0 };
  state.servers.push(record);
  return {
    connect(_transport: unknown): Promise<void> {
      record.connected++;
      if (state.rejectServerConnectFor === name) {
        return Promise.reject(new Error(`server connect failed: ${name}`));
      }
      return Promise.resolve();
    },
    close(): Promise<void> {
      record.closed++;
      return Promise.resolve();
    },
  };
}

void mock.module("@llamactl/mcp", () => ({
  ...llamactlMcpReal,
  buildMcpServer: (): ReturnType<typeof makeServer> => makeServer("llamactl"),
}));

void mock.module("@nova/mcp", () => ({
  ...novaMcpReal,
  buildNovaMcpServer: (): ReturnType<typeof makeServer> => makeServer("nova"),
}));

void mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  ...clientReal,
  Client: FakeClient,
}));

void mock.module("@modelcontextprotocol/sdk/inMemory.js", () => ({
  ...transportReal,
  InMemoryTransport: {
    createLinkedPair: (): [unknown, unknown] => [{ side: "client" }, { side: "server" }],
  },
}));

const { createDefaultToolClient } = await import("../src/harness.js");

afterAll(() => {
  void mock.module("@llamactl/mcp", () => llamactlMcpReal);
  void mock.module("@nova/mcp", () => novaMcpReal);
  void mock.module("@modelcontextprotocol/sdk/client/index.js", () => clientReal);
  void mock.module("@modelcontextprotocol/sdk/inMemory.js", () => transportReal);
});

beforeEach(() => {
  state.servers = [];
  state.clients = [];
  state.rejectClientConnectFor = null;
  state.rejectServerConnectFor = null;
});

async function rejectionOf(promise: PromiseLike<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected rejection");
}

describe("createDefaultToolClient resource cleanup", () => {
  test("closes a connected server when client connection fails", async () => {
    state.rejectClientConnectFor = "llamactl-runbook-harness";

    const err = await rejectionOf(createDefaultToolClient());

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("client connect failed: llamactl-runbook-harness");
    expect(state.servers).toEqual([{ name: "llamactl", connected: 1, closed: 1 }]);
  });

  test("disposes the llamactl mount when nova mount fails", async () => {
    state.rejectServerConnectFor = "nova";

    const err = await rejectionOf(createDefaultToolClient());

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("server connect failed: nova");
    expect(state.servers).toEqual([
      { name: "llamactl", connected: 1, closed: 1 },
      { name: "nova", connected: 1, closed: 0 },
    ]);
    expect(state.clients).toEqual([{ name: "llamactl-runbook-harness", connected: 1, closed: 1 }]);
  });
});
