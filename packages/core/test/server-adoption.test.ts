import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveEnv } from "../src/env.js";
import {
  aliasesFromArgs,
  readServerPid,
  readServerState,
  tryAdoptExistingServer,
} from "../src/server.js";
import type { ResolvedEnv } from "../src/types.js";
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
  afterEach(() => temp.cleanup());

  const base = () => ({
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
        probeModelIds: async () => ["granite-mini-3b"],
        findListenerPid: async () => process.pid,
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
        probeModelIds: async () => ["granite-4.1-3b-Q8_0.gguf"],
        findListenerPid: async () => process.pid,
      },
    });
    expect(pid).toBe(process.pid);
  });

  test("refuses when the model list is empty (unconfirmable)", async () => {
    const pid = await tryAdoptExistingServer({
      ...base(),
      deps: { probeModelIds: async () => [], findListenerPid: async () => process.pid },
    });
    expect(pid).toBeNull();
    expect(readServerState(KEY, resolved)).toBeNull();
  });

  test("refuses an unrelated squatter on the freed port", async () => {
    const pid = await tryAdoptExistingServer({
      ...base(),
      deps: {
        probeModelIds: async () => ["some-other-model"],
        findListenerPid: async () => process.pid,
      },
    });
    expect(pid).toBeNull();
    expect(readServerState(KEY, resolved)).toBeNull();
  });

  test("refuses when no listener pid is found", async () => {
    const pid = await tryAdoptExistingServer({
      ...base(),
      deps: { probeModelIds: async () => ["granite-mini-3b"], findListenerPid: async () => null },
    });
    expect(pid).toBeNull();
  });

  test("refuses when the discovered pid is not alive (TOCTOU)", async () => {
    const pid = await tryAdoptExistingServer({
      ...base(),
      deps: {
        probeModelIds: async () => ["granite-mini-3b"],
        findListenerPid: async () => 2147480000,
      },
    });
    expect(pid).toBeNull();
  });

  test("records slotSavePath from the live process command line only", async () => {
    const pid = await tryAdoptExistingServer({
      ...base(),
      deps: {
        probeModelIds: async () => ["granite-mini-3b"],
        findListenerPid: async () => process.pid,
        readProcessCommand: async () => `/bin/llama-server --slot-save-path /tmp/live-slots`,
      } as any,
    });
    expect(pid).toBe(process.pid);
    expect(readServerState(KEY, resolved)?.slotSavePath).toBe("/tmp/live-slots");
  });
});
