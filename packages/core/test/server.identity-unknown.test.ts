import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";

import { resolveEnv } from "../src/env.js";
import { existsSync, mkdirSync, writeFileSync } from "../src/safe-fs.js";
import { serverStatus } from "../src/server.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

// DF-02 (#275): a recorded pid whose identity cannot be verified ("unknown"
// verdict — never proven dead, never proven ours) must surface as
// identityUnknown on the status snapshot instead of reading as a plain
// down/up server. Eviction and delete paths key off that flag; without it an
// unverifiable victim looks identical to a cleanly stopped one.

const KEY = { name: "identity-unknown" };

describe("serverStatus pid identity", () => {
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

  const seedServer = (): string => {
    const dir = join(temp.runtimeDir, "workloads", KEY.name);
    mkdirSync(dir, { recursive: true });
    const pidPath = join(dir, "llama-server.pid");
    writeFileSync(pidPath, `${String(process.pid)}\n`);
    writeFileSync(
      join(dir, "llama-server.state"),
      JSON.stringify({
        rel: "probe/model.gguf",
        extraArgs: [],
        host: "127.0.0.1",
        port: "1",
        binary: "/bin/false",
        pid: process.pid,
        startedAt: new Date().toISOString(),
        tunedProfile: null,
      }),
    );
    return pidPath;
  };

  // Part of #275 (DF-02). Kills mutation: 'serverStatus drops identityUnknown from its return' and 'serverStatus ignores the identity deps argument'
  test("serverStatus reports identityUnknown when the recorded pid cannot be verified", async () => {
    const pidPath = seedServer();
    const status = await serverStatus(KEY, resolved, { processStartMs: () => null });
    expect(status.identityUnknown).toBe(true);
    expect(status.pid).toBeNull();
    expect(status.state).toBe("down");
    expect(existsSync(pidPath)).toBe(true);
  });

  // Part of #275 (DF-02). Kills mutation: 'identityUnknown hard-coded true'
  test("a verified recorded pid reports identityUnknown false", async () => {
    seedServer();
    const status = await serverStatus(KEY, resolved);
    expect(status.identityUnknown).toBe(false);
    expect(status.pid).toBe(process.pid);
  });
});
