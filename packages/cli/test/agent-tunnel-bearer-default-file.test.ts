// RED for frozename/llamactl#289 (follow-up to #402): each side of
// `agent serve` gains a default bearer file inside the agent dir —
// <dir>/tunnel-bearer for --dial-central, <dir>/tunnel-central-bearer
// for --tunnel-central — slotted between the *_FILE env vars and the
// plain LLAMACTL_TUNNEL_* env vars in the precedence ladder. The plain
// env vars keep working for one release but emit a deprecation warning
// naming the variable and the default file path, never the token, and
// resolveServeBearers scrubs them from the env it was handed so
// llama-server children don't inherit them. The new warn parameter is
// reached through a widened local signature so this file compiles (and
// fails by assertion) before the fix lands.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as agentCmd from "../src/commands/agent.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { makeTempRuntime, runCli } from "./helpers.js";

const { parseServeFlags } = agentCmd;

interface ResolvedBearers {
  dialBearer?: string;
  tunnelCentralBearer?: string;
}
type ResolveResult = ResolvedBearers | { error: string };
type ResolveFn = (
  parsed: unknown,
  env: NodeJS.ProcessEnv,
  warn?: (msg: string) => void,
) => ResolveResult;

const resolveServeBearers = (agentCmd as unknown as Record<string, unknown>)[
  "resolveServeBearers"
] as ResolveFn | undefined;

function getResolver(): ResolveFn {
  expect(typeof resolveServeBearers).toBe("function");
  if (typeof resolveServeBearers !== "function") {
    throw new Error("unreachable");
  }
  return resolveServeBearers;
}

function expectOk(r: ResolveResult): ResolvedBearers {
  expect("error" in r).toBe(false);
  if ("error" in r) {
    throw new Error("unreachable");
  }
  return r;
}

function expectErr(r: ResolveResult): string {
  expect("error" in r).toBe(true);
  if (!("error" in r)) {
    throw new Error("unreachable");
  }
  return r.error;
}

function augment(env: NodeJS.ProcessEnv, devStorage: string): NodeJS.ProcessEnv {
  return {
    ...env,
    LLAMACTL_CONFIG: join(devStorage, "config"),
    LLAMACTL_AGENT_DIR: join(devStorage, "agent"),
  };
}

interface OccupiedPort {
  port: number;
  release: () => Promise<void>;
}

// Bun.serve in the spawned agent uses SO_REUSEPORT, which still fails to
// bind while a plain (non-reuseport) listener holds the port — so a
// node:net listener makes the post-validation bind fail fast with
// "already in use" instead of starting a server the test must tear down.
async function occupyPort(): Promise<OccupiedPort> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("expected a bound TCP port");
  }
  return {
    port: address.port,
    release: (): Promise<void> =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

describe("agent serve default bearer files (#289)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llamactl-bearer-default-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeBearerAt(base: string, name: string, contents: string, mode: number): string {
    const p = join(base, name);
    writeFileSync(p, contents);
    chmodSync(p, mode);
    return p;
  }

  function writeBearer(name: string, contents: string, mode: number): string {
    return writeBearerAt(dir, name, contents, mode);
  }

  function seedServeAgentDir(env: NodeJS.ProcessEnv): string {
    const agentDir = mkdtempSync(join(dir, "serve-"));
    const init = runCli(["agent", "init", `--dir=${agentDir}`, "--json"], env);
    expect(init.code).toBe(0);
    return agentDir;
  }

  test("dial side: precedence literal > --central-bearer-file > LLAMACTL_TUNNEL_BEARER_FILE > <dir>/tunnel-bearer > LLAMACTL_TUNNEL_BEARER", () => {
    const resolve = getResolver();
    writeBearer("tunnel-bearer", "dir-tok\n", 0o600);
    const parsed = parseServeFlags([`--dir=${dir}`, "--dial-central=wss://127.0.0.1:1/tunnel"]);
    if ("error" in parsed) {
      throw new Error(parsed.error);
    }
    expect(expectOk(resolve(parsed, { LLAMACTL_TUNNEL_BEARER: "env-tok" })).dialBearer).toBe(
      "dir-tok",
    );

    const envFile = writeBearer("envfile.bearer", "envfile-tok\n", 0o600);
    const envBoth: NodeJS.ProcessEnv = {
      LLAMACTL_TUNNEL_BEARER_FILE: envFile,
      LLAMACTL_TUNNEL_BEARER: "env-tok",
    };
    expect(expectOk(resolve(parsed, envBoth)).dialBearer).toBe("envfile-tok");

    const flagFile = writeBearer("flagfile.bearer", "flagfile-tok\n", 0o600);
    const withFileFlag = parseServeFlags([
      `--dir=${dir}`,
      "--dial-central=wss://127.0.0.1:1/tunnel",
      `--central-bearer-file=${flagFile}`,
    ]);
    if ("error" in withFileFlag) {
      throw new Error(withFileFlag.error);
    }
    expect(expectOk(resolve(withFileFlag, envBoth)).dialBearer).toBe("flagfile-tok");

    const withLiteral = parseServeFlags([
      `--dir=${dir}`,
      "--dial-central=wss://127.0.0.1:1/tunnel",
      "--central-bearer=lit",
    ]);
    if ("error" in withLiteral) {
      throw new Error(withLiteral.error);
    }
    expect(expectOk(resolve(withLiteral, envBoth)).dialBearer).toBe("lit");
  });

  test("central side: <dir>/tunnel-central-bearer is used with --tunnel-central=true and ignored without it", () => {
    const resolve = getResolver();
    const centralFile = writeBearer("tunnel-central-bearer", "dir-c\n", 0o600);
    const on = parseServeFlags([`--dir=${dir}`, "--tunnel-central=true"]);
    if ("error" in on) {
      throw new Error(on.error);
    }
    expect(
      expectOk(resolve(on, { LLAMACTL_TUNNEL_CENTRAL_BEARER: "env-c" })).tunnelCentralBearer,
    ).toBe("dir-c");

    chmodSync(centralFile, 0o644);
    const off = parseServeFlags([`--dir=${dir}`]);
    if ("error" in off) {
      throw new Error(off.error);
    }
    expect(expectOk(resolve(off, {})).tunnelCentralBearer).toBeUndefined();

    const dialOnly = parseServeFlags([`--dir=${dir}`, "--dial-central=wss://127.0.0.1:1/tunnel"]);
    if ("error" in dialOnly) {
      throw new Error(dialOnly.error);
    }
    expect(expectOk(resolve(dialOnly, {})).dialBearer).toBeUndefined();
  });

  test("a 0644 <dir>/tunnel-bearer is refused naming path and mode, never the token", () => {
    const resolve = getResolver();
    const bearer = writeBearer("tunnel-bearer", "secret-dir-tok\n", 0o644);
    const parsed = parseServeFlags([`--dir=${dir}`, "--dial-central=wss://127.0.0.1:1/tunnel"]);
    if ("error" in parsed) {
      throw new Error(parsed.error);
    }
    const err = expectErr(resolve(parsed, { LLAMACTL_TUNNEL_BEARER: "env-tok" }));
    expect(err).toContain(bearer);
    expect(err).toContain("0644");
    expect(err).not.toContain("secret-dir-tok");
    expect(err).not.toContain("env-tok");
  });

  test("plain LLAMACTL_TUNNEL_BEARER still works but emits one deprecation warning naming the var, not the value", () => {
    const resolve = getResolver();
    const dialParsed = parseServeFlags([`--dir=${dir}`, "--dial-central=wss://127.0.0.1:1/tunnel"]);
    if ("error" in dialParsed) {
      throw new Error(dialParsed.error);
    }

    const dialMsgs: string[] = [];
    const dialResult = expectOk(
      resolve(dialParsed, { LLAMACTL_TUNNEL_BEARER: "env-only-tok" }, (m) => dialMsgs.push(m)),
    );
    expect(dialResult.dialBearer).toBe("env-only-tok");
    expect(dialMsgs.length).toBe(1);
    expect(dialMsgs[0]).toContain("LLAMACTL_TUNNEL_BEARER");
    expect(dialMsgs[0]).toContain("deprecated");
    expect(dialMsgs[0]).toContain(join(dir, "tunnel-bearer"));
    expect(dialMsgs[0]).not.toContain("env-only-tok");

    const centralParsed = parseServeFlags([`--dir=${dir}`, "--tunnel-central=true"]);
    if ("error" in centralParsed) {
      throw new Error(centralParsed.error);
    }
    const centralMsgs: string[] = [];
    const centralResult = expectOk(
      resolve(centralParsed, { LLAMACTL_TUNNEL_CENTRAL_BEARER: "env-c-only" }, (m) =>
        centralMsgs.push(m),
      ),
    );
    expect(centralResult.tunnelCentralBearer).toBe("env-c-only");
    expect(centralMsgs.length).toBe(1);
    expect(centralMsgs[0]).toContain("LLAMACTL_TUNNEL_CENTRAL_BEARER");
    expect(centralMsgs[0]).toContain("deprecated");
    expect(centralMsgs[0]).toContain(join(dir, "tunnel-central-bearer"));
    expect(centralMsgs[0]).not.toContain("env-c-only");

    writeBearer("tunnel-bearer", "dir-tok\n", 0o600);
    const quietMsgs: string[] = [];
    const fileResult = expectOk(
      resolve(dialParsed, { LLAMACTL_TUNNEL_BEARER: "env-tok" }, (m) => quietMsgs.push(m)),
    );
    expect(fileResult.dialBearer).toBe("dir-tok");
    expect(quietMsgs).toEqual([]);
  });

  test("resolveServeBearers removes the plain bearer vars from the env it was given", () => {
    const resolve = getResolver();
    const fileBearer = writeBearer("t5-dial.bearer", "file-tok\n", 0o600);
    const parsed = parseServeFlags([`--dir=${dir}`, "--dial-central=wss://127.0.0.1:1/tunnel"]);
    if ("error" in parsed) {
      throw new Error(parsed.error);
    }

    const env: NodeJS.ProcessEnv = {
      LLAMACTL_TUNNEL_BEARER: "env-tok",
      LLAMACTL_TUNNEL_CENTRAL_BEARER: "env-c",
      LLAMACTL_TUNNEL_BEARER_FILE: fileBearer,
    };
    const result = expectOk(resolve(parsed, env));
    expect(result.dialBearer).toBe("file-tok");
    expect("LLAMACTL_TUNNEL_BEARER" in env).toBe(false);
    expect("LLAMACTL_TUNNEL_CENTRAL_BEARER" in env).toBe(false);
    expect(env["LLAMACTL_TUNNEL_BEARER_FILE"]).toBe(fileBearer);

    // The plain env var still wins when no file source exists, so the
    // value must have been captured before the vars were deleted.
    const plainEnv: NodeJS.ProcessEnv = { LLAMACTL_TUNNEL_BEARER: "env-tok" };
    const plainResult = expectOk(resolve(parsed, plainEnv));
    expect(plainResult.dialBearer).toBe("env-tok");
    expect("LLAMACTL_TUNNEL_BEARER" in plainEnv).toBe(false);
  });

  test("agent serve picks up a 0600 <dir>/tunnel-bearer with no other bearer source", async () => {
    const temp = makeTempRuntime();
    const env = augment(temp.env, temp.devStorage);
    const occupied = await occupyPort();
    try {
      const agentDir = seedServeAgentDir(env);
      writeBearerAt(agentDir, "tunnel-bearer", "e2e-dir-tok\n", 0o600);
      const r = runCli(
        [
          "agent",
          "serve",
          `--dir=${agentDir}`,
          `--port=${String(occupied.port)}`,
          "--dial-central=wss://127.0.0.1:1/tunnel",
        ],
        env,
      );
      expect(r.stderr).not.toContain("must be provided together");
      expect(r.stderr).toContain("already in use");
      expect(r.stderr).not.toContain("e2e-dir-tok");
    } finally {
      await occupied.release();
      temp.cleanup();
    }
  });

  test("agent serve refuses a 0644 <dir>/tunnel-bearer", () => {
    const temp = makeTempRuntime();
    const env = augment(temp.env, temp.devStorage);
    try {
      const agentDir = seedServeAgentDir(env);
      const bearer = writeBearerAt(agentDir, "tunnel-bearer", "e2e-weak-tok\n", 0o644);
      const r = runCli(
        ["agent", "serve", `--dir=${agentDir}`, "--dial-central=wss://127.0.0.1:1/tunnel"],
        env,
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(bearer);
      expect(r.stderr).toContain("0644");
      expect(r.stderr).not.toContain("e2e-weak-tok");
    } finally {
      temp.cleanup();
    }
  });

  test("agent serve with plain LLAMACTL_TUNNEL_BEARER prints the deprecation warning without the token", async () => {
    const temp = makeTempRuntime();
    const env = augment(temp.env, temp.devStorage);
    const occupied = await occupyPort();
    try {
      const agentDir = seedServeAgentDir(env);
      const r = runCli(
        [
          "agent",
          "serve",
          `--dir=${agentDir}`,
          `--port=${String(occupied.port)}`,
          "--dial-central=wss://127.0.0.1:1/tunnel",
        ],
        { ...env, LLAMACTL_TUNNEL_BEARER: "e2e-env-tok" },
      );
      expect(r.stderr).toContain("LLAMACTL_TUNNEL_BEARER");
      expect(r.stderr).toContain("deprecated");
      expect(r.stderr).toContain("already in use");
      expect(r.stderr).not.toContain("e2e-env-tok");
    } finally {
      await occupied.release();
      temp.cleanup();
    }
  });
});
