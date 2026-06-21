import type { Config } from "@llamactl/core/config/schema";

import { describe, expect, test } from "bun:test";

import { createNodeClient, type TunnelSendFn } from "../src/client/node-client.js";

/**
 * I.3.3 — createNodeClient routes through a tunnel when the target
 * node carries `tunnelPreferred: true` AND the caller supplies a
 * `tunnelSend` callable. This file exercises the client-side
 * proxy with a mock send fn; the tunnel-router-bridge tests cover
 * the agent-side handler.
 */

/**
 * Structural model of the path-agnostic tunnel proxy. The recursive
 * Proxy behind `createNodeClient(+tunnelSend)` accepts ANY dotted
 * path and only materializes `.query` / `.mutate` / `.subscribe`
 * leaves — these tests probe arbitrary paths, so the proxy's runtime
 * contract (not AppRouter) is the truthful type surface. Listed below
 * are exactly the dotted paths this file exercises.
 */
type TunnelProxyLeaf = {
  query: (input?: unknown) => Promise<unknown>;
  mutate: (input?: unknown) => Promise<unknown>;
  subscribe: (
    input: unknown,
    handlers: {
      onData: (e: unknown) => void;
      onError: (err: unknown) => void;
      onComplete: () => void;
    },
  ) => { unsubscribe: () => void };
};
type TunnelProxy = {
  catalog: { list: TunnelProxyLeaf; promote: TunnelProxyLeaf };
  anything: TunnelProxyLeaf;
  deeply: { nested: { procedure: TunnelProxyLeaf } };
  pullFile: TunnelProxyLeaf;
};

function tunnelProxy(client: unknown): TunnelProxy {
  return client as TunnelProxy;
}

function baseConfig(overrides: Partial<Config["clusters"][number]["nodes"][number]> = {}): Config {
  return {
    apiVersion: "llamactl/v1",
    kind: "Config",
    currentContext: "default",
    contexts: [{ name: "default", cluster: "home", user: "me", defaultNode: "gpu1" }],
    clusters: [
      {
        name: "home",
        nodes: [
          {
            name: "gpu1",
            endpoint: "https://gpu1.lan:7843",
            kind: "agent",
            certificate: "-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----\n",
            tunnelPreferred: true,
            ...overrides,
          },
        ],
      },
    ],
    users: [{ name: "me", token: "test-token" }],
  };
}

describe("proxyFromTunnel — via createNodeClient", () => {
  test("query routes through the tunnel and resolves with result", async () => {
    const sent: { id: string; method: string; params: unknown }[] = [];
    const send: TunnelSendFn = async (req) => {
      await Promise.resolve();
      sent.push(req);
      if (req.method === "catalog.list") {
        return { id: req.id, result: [{ rel: "a" }, { rel: "b" }] };
      }
      return { id: req.id, error: { code: "unknown", message: "not wired" } };
    };
    const client = createNodeClient(baseConfig(), {
      nodeName: "gpu1",
      tunnelSend: send,
    });
    const catalog = tunnelProxy(client).catalog;
    const result = await catalog.list.query({ classFilter: "all" });
    expect(result).toEqual([{ rel: "a" }, { rel: "b" }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("catalog.list");
    expect(sent[0]!.params).toEqual({
      type: "query",
      input: { classFilter: "all" },
    });
  });

  test("mutation uses type:mutation on the tunnel frame", async () => {
    const sent: { method: string; params: unknown }[] = [];
    const send: TunnelSendFn = async (req) => {
      await Promise.resolve();
      sent.push({ method: req.method, params: req.params });
      return { id: req.id, result: { ok: true } };
    };
    const client = createNodeClient(baseConfig(), {
      nodeName: "gpu1",
      tunnelSend: send,
    });
    const result = await tunnelProxy(client).catalog.promote.mutate({ rel: "foo.gguf" });
    expect(result).toEqual({ ok: true });
    expect(sent[0]!.params).toEqual({
      type: "mutation",
      input: { rel: "foo.gguf" },
    });
  });

  test("error frame surfaces as a thrown Error with .code", async () => {
    const send: TunnelSendFn = (req) =>
      Promise.resolve({
        id: req.id,
        error: { code: "handler-threw", message: "simulated failure" },
      });
    const client = createNodeClient(baseConfig(), {
      nodeName: "gpu1",
      tunnelSend: send,
    });
    try {
      await tunnelProxy(client).anything.query(null);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).toBe("simulated failure");
      expect((err as Error & { code?: string }).code).toBe("handler-threw");
    }
  });

  test("deep dotted paths are respected (nested.namespace.method)", async () => {
    const sent: string[] = [];
    const send: TunnelSendFn = async (req) => {
      await Promise.resolve();
      sent.push(req.method);
      return { id: req.id, result: null };
    };
    const client = createNodeClient(baseConfig(), {
      nodeName: "gpu1",
      tunnelSend: send,
    });
    await tunnelProxy(client).deeply.nested.procedure.query({ x: 1 });
    expect(sent).toEqual(["deeply.nested.procedure"]);
  });

  test("subscribe throws when tunnelSubscribe dispatcher is absent", async () => {
    await Promise.resolve();
    const send: TunnelSendFn = () => Promise.resolve({ id: "x" });
    const client = createNodeClient(baseConfig(), {
      nodeName: "gpu1",
      tunnelSend: send,
    });
    expect(() => {
      tunnelProxy(client).pullFile.subscribe(
        { repo: "r", file: "f" },
        { onData: () => undefined, onError: () => undefined, onComplete: () => undefined },
      );
    }).toThrow(/requires a tunnelSubscribe dispatcher/);
  });

  test("subscribe forwards to tunnelSubscribe when wired (Slice B)", async () => {
    await Promise.resolve();
    const send: TunnelSendFn = () => Promise.resolve({ id: "x" });
    const calls: { method: string; input: unknown }[] = [];
    const tunnelSubscribe = (
      method: string,
      input: unknown,
      _handlers: {
        onData: (e: unknown) => void;
        onError: (err: unknown) => void;
        onComplete: () => void;
      },
    ): { unsubscribe: () => void } => {
      calls.push({ method, input });
      return {
        unsubscribe(): void {
          /* no-op */
        },
      };
    };
    const client = createNodeClient(baseConfig(), {
      nodeName: "gpu1",
      tunnelSend: send,
      tunnelSubscribe,
    });
    const handle = tunnelProxy(client).pullFile.subscribe(
      { repo: "a", file: "b" },
      { onData: () => undefined, onError: () => undefined, onComplete: () => undefined },
    );
    expect(calls).toEqual([{ method: "pullFile", input: { repo: "a", file: "b" } }]);
    expect(typeof handle.unsubscribe).toBe("function");
  });

  test("tunnelPreferred=false → tunnel bypassed even if send is provided", async () => {
    await Promise.resolve();
    let calls = 0;
    const send: TunnelSendFn = async (req) => {
      await Promise.resolve();
      calls++;
      return { id: req.id, result: null };
    };
    const cfg = baseConfig({ tunnelPreferred: false });
    // Build the client — since the node has a real https endpoint,
    // createNodeClient picks the proxyFromHttp path. We don't actually
    // fire a request (no upstream to hit), just confirm send never
    // got invoked during creation.
    const client = createNodeClient(cfg, { nodeName: "gpu1", tunnelSend: send });
    expect(client).toBeDefined();
    expect(calls).toBe(0);
  });

  test("tunnelPreferred=true but tunnelSend omitted → falls through to HTTP proxy", async () => {
    await Promise.resolve();
    const cfg = baseConfig({ tunnelPreferred: true });
    const client = createNodeClient(cfg, { nodeName: "gpu1" });
    expect(client).toBeDefined();
    // HTTP proxy shape — no error on construction; actual call would
    // try to hit gpu1.lan:7843 which we don't assert here.
  });
});
