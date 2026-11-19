import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { PidIdentityDeps } from "../src/pidIdentity.js";
import type { ResolvedEnv } from "../src/types.js";

import { resolveEnv } from "../src/env.js";
import { existsSync, mkdirSync, writeFileSync } from "../src/safe-fs.js";
import * as serverMod from "../src/server.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

// Part of #517: RED tests for isServerProvenDown — the identity-based
// "recorded pid is provably gone" predicate the direct ModelRun lifecycle
// reconcile and the agent boot-recovery orphan sweep share. At base the
// export does not exist, so every case fails BY ASSERTION on the typeof
// guard — never by an import, link or type error. The function is fetched
// loosely off the module namespace so the base still compiles; the cast
// pins the intended signature. All state lives in mkdtemp dirs; the
// identity deps are injected fakes — no real ps, no processes, no sleeps.

const KEY = { name: "proven-down" };

type IsServerProvenDown = (
  key: { name: string },
  resolved: ResolvedEnv,
  identity?: PidIdentityDeps,
) => boolean;

describe("server.isServerProvenDown", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let resolved: ResolvedEnv;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
    process.env["LLAMA_CPP_PORT"] = "1";
    resolved = resolveEnv();
  });

  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  const provenDown = (): IsServerProvenDown => {
    const fn = (serverMod as Record<string, unknown>)["isServerProvenDown"];
    expect(typeof fn).toBe("function");
    return fn as IsServerProvenDown;
  };

  // The tracked-server record pair: llama-server.pid plus the
  // llama-server.state sidecar carrying the binary and rel the shared
  // stop identity expectation is built from.
  const seedServer = (pid: number): string => {
    const dir = join(temp.runtimeDir, "workloads", KEY.name);
    mkdirSync(dir, { recursive: true });
    const pidPath = join(dir, "llama-server.pid");
    writeFileSync(pidPath, `${String(pid)}\n`);
    writeFileSync(
      join(dir, "llama-server.state"),
      JSON.stringify({
        rel: "probe/model.gguf",
        extraArgs: [],
        host: "127.0.0.1",
        port: "1",
        binary: "/opt/bin/llama-server",
        pid,
        startedAt: new Date().toISOString(),
        tunedProfile: null,
      }),
    );
    return pidPath;
  };

  const probeThrowing = (code: string): PidIdentityDeps => ({
    probe: (): never => {
      throw Object.assign(new Error("probe failed"), { code });
    },
  });

  // Part of #517. kills: a predicate that answers false (or throws) when
  // the workload has no recorded pid file.
  test("PD1: no pid file is proven down", () => {
    expect(provenDown()(KEY, resolved)).toBe(true);
  });

  // Part of #517. kills: the predicate ignoring the injected identity
  // deps, and the predicate reaping or removing the pid file.
  test("PD2: a dead recorded pid is proven down and the pid file is kept", () => {
    const pidPath = seedServer(process.pid);
    const down = provenDown()(KEY, resolved, probeThrowing("ESRCH"));
    expect(down).toBe(true);
    expect(existsSync(pidPath)).toBe(true);
  });

  // Part of #517. kills: treating a recycled pid (EPERM) as alive.
  test("PD3: an EPERM probe reads reused and is proven down", () => {
    seedServer(process.pid);
    expect(provenDown()(KEY, resolved, probeThrowing("EPERM"))).toBe(true);
  });

  // Part of #517. kills: dropping the start-time check — a process that
  // started after the record was written holds a recycled pid.
  test("PD4: a start time newer than the record reads reused", () => {
    seedServer(process.pid);
    expect(
      provenDown()(KEY, resolved, {
        probe: () => undefined,
        processStartMs: () => Date.now() + 120_000,
      }),
    ).toBe(true);
  });

  // Part of #517. kills: treating a verified-alive recorded pid as gone.
  test("PD5: a live pid with the recorded command is not proven down", () => {
    seedServer(process.pid);
    expect(
      provenDown()(KEY, resolved, {
        probe: () => undefined,
        processStartMs: () => Date.now() - 60_000,
        processCommand: () => "/opt/bin/llama-server -m probe/model.gguf --port 1",
      }),
    ).toBe(false);
  });

  // Part of #517. kills: treating an unverifiable identity as gone — the
  // pid file must be retained for a later stop attempt.
  test("PD6: an unverifiable identity fails closed and keeps the pid file", () => {
    const pidPath = seedServer(process.pid);
    expect(
      provenDown()(KEY, resolved, {
        probe: () => undefined,
        processStartMs: () => Date.now() - 60_000,
        processCommand: () => "bun test",
      }),
    ).toBe(false);
    expect(existsSync(pidPath)).toBe(true);
  });
});
