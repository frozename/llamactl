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
        probeModelIds: () => Promise.resolve(["granite-4.1-3b-Q8_0.gguf"]),
        findListenerPid: () => Promise.resolve(process.pid),
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

  test("records specHash and tunedProfile so a same-spec re-start can adopt", async () => {
    const pid = await tryAdoptExistingServer({
      ...base(),
      tunedProfile: "granite-4b-q4",
      specHash: '{"rel":"x"}',
      deps: {
        probeModelIds: () => Promise.resolve(["granite-mini-3b"]),
        findListenerPid: () => Promise.resolve(process.pid),
      },
    });
    expect(pid).toBe(process.pid);
    const state = readServerState(KEY, resolved);
    expect(state?.specHash).toBe('{"rel":"x"}');
    expect(state?.tunedProfile).toBe("granite-4b-q4");
  });

  // #806: the convergence hash is stamped only when the listener's argv is the
  // desired launch. A wrapper prefix may precede it; extra flags may not, on
  // either side of the desired argv.
  const EXPECTED = ["-m", "/models/x.gguf", "--host", "127.0.0.1", "--port", "8086", ...EXTRA];
  const adoptWithCmdline = async (cmdline: string): Promise<string | undefined> => {
    const pid = await tryAdoptExistingServer({
      ...base(),
      specHash: '{"rel":"x"}',
      expectedLaunchArgs: EXPECTED,
      deps: {
        probeModelIds: () => Promise.resolve(["granite-mini-3b"]),
        findListenerPid: () => Promise.resolve(process.pid),
        readProcessCommand: () => Promise.resolve(cmdline),
      },
    });
    expect(pid).toBe(process.pid);
    return readServerState(KEY, resolved)?.specHash;
  };

  test("stamps specHash when the listener argv is exactly the desired launch", async () => {
    expect(await adoptWithCmdline(EXPECTED.join(" "))).toBe('{"rel":"x"}');
  });

  test("stamps specHash when only a wrapper prefix precedes the desired launch", async () => {
    expect(await adoptWithCmdline(`llama-server /opt/wrapper.ts ${EXPECTED.join(" ")}`)).toBe(
      '{"rel":"x"}',
    );
  });

  test("omits specHash when the listener adds trailing flags to the desired launch", async () => {
    expect(
      await adoptWithCmdline(`/bin/llama-server ${EXPECTED.join(" ")} --ctx-size 4096`),
    ).toBeUndefined();
  });

  test("omits specHash when a flag precedes the desired launch", async () => {
    expect(
      await adoptWithCmdline(`/bin/llama-server -fa on ${EXPECTED.join(" ")}`),
    ).toBeUndefined();
  });

  test("omits specHash when the caller cannot supply the launch spec", async () => {
    const pid = await tryAdoptExistingServer({
      ...base(),
      deps: {
        probeModelIds: () => Promise.resolve(["granite-mini-3b"]),
        findListenerPid: () => Promise.resolve(process.pid),
      },
    });
    expect(pid).toBe(process.pid);
    const state = readServerState(KEY, resolved);
    expect(state?.specHash).toBeUndefined();
    expect(state?.tunedProfile).toBeNull();
  });
});
