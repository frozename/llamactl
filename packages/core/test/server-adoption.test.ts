import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ResolvedEnv } from "../src/types.js";

import { resolveEnv } from "../src/env.js";
import {
  aliasesFromArgs,
  readServerPid,
  readServerState,
  tryAdoptExistingServer,
} from "../src/server.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

const KEY = { name: "granite-judge" };
const REL = "granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf";
const EXTRA = ["--alias", "granite-mini-3b", "-ngl", "999"];

describe("aliasesFromArgs", () => {
  test("extracts --alias and -a values", () => {
    expect(aliasesFromArgs(["--alias", "foo", "-ngl", "999", "-a", "bar"])).toEqual(["foo", "bar"]);
  });
  test("ignores a trailing flag with no value", () => {
    expect(aliasesFromArgs(["-ngl", "999", "--alias"])).toEqual([]);
  });
});

describe("tryAdoptExistingServer", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let resolved: ResolvedEnv;
  beforeEach(() => {
    temp = makeTempRuntime();
    resolved = resolveEnv(envForTemp(temp));
  });
  afterEach(() => {
    temp.cleanup();
  });

  const base = (): {
    resolved: ResolvedEnv;
    key: { name: string };
    endpointUrl: string;
    host: string;
    port: number;
    rel: string;
    extraArgs: string[];
    binary: string;
  } => ({
    resolved,
    key: KEY,
    endpointUrl: "http://127.0.0.1:8086",
    host: "127.0.0.1",
    port: 8086,
    rel: REL,
    extraArgs: EXTRA,
    binary: "/bin/llama-server",
  });

  test("adopts a server advertising our --alias; writes pid+state", async () => {
    const pid = await tryAdoptExistingServer({
      ...base(),
      deps: {
        probeModelIds: () => Promise.resolve(["granite-mini-3b"]),
        findListenerPid: () => Promise.resolve(process.pid),
      },
    });
    expect(pid).toBe(process.pid);
    expect(readServerPid(KEY, resolved)).toBe(process.pid);
    const state = readServerState(KEY, resolved);
    expect(state?.rel).toBe(REL);
    expect(state?.host).toBe("127.0.0.1");
    expect(state?.port).toBe("8086");
    expect(state?.pid).toBe(process.pid);
    expect(state?.extraArgs).toEqual(EXTRA);
  });

  test("adopts when the server advertises the rel basename", async () => {
    const pid = await tryAdoptExistingServer({
      ...base(),
      deps: {
        probeModelIds: (): Promise<string[]> => Promise.resolve(["granite-mini-3b"]),
        findListenerPid: (): Promise<number> => Promise.resolve(process.pid),
      },
    });
    expect(pid).toBe(process.pid);
  });

  test("refuses when the model list is empty (unconfirmable)", async () => {
    const pid = await tryAdoptExistingServer({
      ...base(),
      deps: {
        probeModelIds: () => Promise.resolve([]),
        findListenerPid: () => Promise.resolve(process.pid),
      },
    });
    expect(pid).toBeNull();
    expect(readServerState(KEY, resolved)).toBeNull();
  });

  test("refuses an unrelated squatter on the freed port", async () => {
    const pid = await tryAdoptExistingServer({
      ...base(),
      deps: {
        probeModelIds: () => Promise.resolve(["some-other-model"]),
        findListenerPid: () => Promise.resolve(process.pid),
      },
    });
    expect(pid).toBeNull();
    expect(readServerState(KEY, resolved)).toBeNull();
  });

  test("refuses when no listener pid is found", async () => {
    const pid = await tryAdoptExistingServer({
      ...base(),
      deps: {
        probeModelIds: () => Promise.resolve(["granite-mini-3b"]),
        findListenerPid: () => Promise.resolve(null),
      },
    });
    expect(pid).toBeNull();
  });

  test("refuses when the discovered pid is not alive (TOCTOU)", async () => {
    const pid = await tryAdoptExistingServer({
      ...base(),
      deps: {
        probeModelIds: () => Promise.resolve(["granite-mini-3b"]),
        findListenerPid: () => Promise.resolve(2147480000),
      },
    });
    expect(pid).toBeNull();
  });

  test("records slotSavePath from the live process command line only", async () => {
    const pid = await tryAdoptExistingServer({
      ...base(),
      deps: {
        probeModelIds: () => Promise.resolve(["granite-mini-3b"]),
        findListenerPid: () => Promise.resolve(process.pid),
        readProcessCommand: () =>
          Promise.resolve(`/bin/llama-server --slot-save-path /tmp/live-slots`),
      },
    });
    expect(pid).toBe(process.pid);
    expect(readServerState(KEY, resolved)?.slotSavePath).toBe("/tmp/live-slots");
  });

  describe("with a declared readiness contract (#220)", () => {
    async function withLiveServer(
      readyHandler: (req: Request) => Response,
      run: (port: number) => Promise<void>,
    ): Promise<void> {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (req) =>
          new URL(req.url).pathname === "/ready"
            ? readyHandler(req)
            : new Response("ok", { status: 200 }),
      });
      try {
        if (typeof server.port !== "number") throw new Error("no ephemeral port assigned");
        await run(server.port);
      } finally {
        await server.stop(true);
      }
    }

    const adoptArgs = (port: number): Parameters<typeof tryAdoptExistingServer>[0] => ({
      ...base(),
      endpointUrl: `http://127.0.0.1:${String(port)}`,
      port,
      deps: {
        probeModelIds: (): Promise<string[]> => Promise.resolve(["granite-mini-3b"]),
        findListenerPid: (): Promise<number> => Promise.resolve(process.pid),
      },
    });

    test("refuses adoption while the declared endpoint answers 503", async () => {
      await withLiveServer(
        () => new Response("loading", { status: 503 }),
        async (port) => {
          const pid = await tryAdoptExistingServer({
            ...adoptArgs(port),
            readiness: { path: "/ready" },
          });
          expect(pid).toBeNull();
          expect(readServerState(KEY, resolved)).toBeNull();
        },
      );
    });

    test("refuses adoption on a missing capability (404)", async () => {
      await withLiveServer(
        () => new Response("not found", { status: 404 }),
        async (port) => {
          const pid = await tryAdoptExistingServer({
            ...adoptArgs(port),
            readiness: { path: "/ready" },
          });
          expect(pid).toBeNull();
        },
      );
    });

    test("refuses adoption on an expectJson mismatch", async () => {
      await withLiveServer(
        () => Response.json({ status: "warming" }),
        async (port) => {
          const pid = await tryAdoptExistingServer({
            ...adoptArgs(port),
            readiness: { path: "/ready", expectJson: { status: "ready" } },
          });
          expect(pid).toBeNull();
        },
      );
    });

    test("adopts once the declared endpoint passes", async () => {
      await withLiveServer(
        () => Response.json({ status: "ready" }),
        async (port) => {
          const pid = await tryAdoptExistingServer({
            ...adoptArgs(port),
            readiness: { path: "/ready", expectJson: { status: "ready" } },
          });
          expect(pid).toBe(process.pid);
          expect(readServerPid(KEY, resolved)).toBe(process.pid);
        },
      );
    });

    test("absence of the contract keeps model-list-only adoption", async () => {
      await withLiveServer(
        () => new Response("not found", { status: 404 }),
        async (port) => {
          const pid = await tryAdoptExistingServer(adoptArgs(port));
          expect(pid).toBe(process.pid);
        },
      );
    });
  });
});
