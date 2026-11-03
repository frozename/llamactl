// RED for frozename/llamactl#289: `agent serve` gains
// --central-bearer-file / --tunnel-bearer-file so the tunnel bearer can
// live in a 0600 file instead of a launchd plist, a literal flag, or a
// process env var. New exports are reached through the module namespace
// and new flag fields through a double cast so this file compiles (and
// fails by assertion) before the fix lands.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
type ResolveFn = (parsed: unknown, env: NodeJS.ProcessEnv) => ResolveResult;

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

function flagField(parsed: unknown, key: string): unknown {
  return (parsed as Record<string, unknown>)[key];
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

describe("agent serve bearer-file flags (#289)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llamactl-bearer-file-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeBearer(name: string, contents: string, mode: number): string {
    const p = join(dir, name);
    writeFileSync(p, contents);
    chmodSync(p, mode);
    return p;
  }

  test("parseServeFlags accepts --central-bearer-file", () => {
    const parsed = parseServeFlags([
      "--dial-central=wss://127.0.0.1:1/tunnel",
      "--central-bearer-file=/abs/b",
    ]);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) {
      throw new Error(parsed.error);
    }
    expect(flagField(parsed, "centralBearerFile")).toBe("/abs/b");
  });

  test("parseServeFlags accepts --tunnel-bearer-file", () => {
    const parsed = parseServeFlags(["--tunnel-central=true", "--tunnel-bearer-file=/abs/c"]);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) {
      throw new Error(parsed.error);
    }
    expect(flagField(parsed, "tunnelBearerFile")).toBe("/abs/c");
  });

  test("resolveServeBearers reads a 0600 --central-bearer-file and trims it", () => {
    const resolve = getResolver();
    const bearer = writeBearer("dial.bearer", "tok-123\n", 0o600);
    const parsed = parseServeFlags([
      "--dial-central=wss://127.0.0.1:1/tunnel",
      `--central-bearer-file=${bearer}`,
    ]);
    if ("error" in parsed) {
      throw new Error(parsed.error);
    }
    expect(expectOk(resolve(parsed, {})).dialBearer).toBe("tok-123");
  });

  test("resolveServeBearers rejects a bearer file that is not 0600", () => {
    const resolve = getResolver();
    const bearer = writeBearer("dial-644.bearer", "tok-123\n", 0o644);
    const parsed = parseServeFlags([
      "--dial-central=wss://127.0.0.1:1/tunnel",
      `--central-bearer-file=${bearer}`,
    ]);
    if ("error" in parsed) {
      throw new Error(parsed.error);
    }
    const err = expectErr(resolve(parsed, {}));
    expect(err).toContain(bearer);
    expect(err).toContain("0644");
    expect(err).not.toContain("tok-123");
  });

  test("resolveServeBearers reports a missing bearer file", () => {
    const resolve = getResolver();
    const missing = join(dir, "no-such.bearer");
    const parsed = parseServeFlags([
      "--dial-central=wss://127.0.0.1:1/tunnel",
      `--central-bearer-file=${missing}`,
    ]);
    if ("error" in parsed) {
      throw new Error(parsed.error);
    }
    expect(expectErr(resolve(parsed, {}))).toContain(missing);
  });

  test("--central-bearer + --central-bearer-file together are rejected naming both flags", () => {
    const resolve = getResolver();
    const parsed = parseServeFlags([
      "--dial-central=wss://127.0.0.1:1/tunnel",
      "--central-bearer=x",
      "--central-bearer-file=/abs/b",
    ]);
    // The mutual-exclusion error may surface at parse or at resolve;
    // either way it must name both flags without leaking either value.
    let err: string | undefined;
    if ("error" in parsed) {
      err = parsed.error;
    } else {
      const r = resolve(parsed, {});
      if ("error" in r) {
        err = r.error;
      }
    }
    expect(err).toBeDefined();
    expect(err).toMatch(/--central-bearer(?!-)/);
    expect(err).toContain("--central-bearer-file");
  });

  test("dial-side precedence: --central-bearer > LLAMACTL_TUNNEL_BEARER_FILE > LLAMACTL_TUNNEL_BEARER", () => {
    const resolve = getResolver();
    const fileBearer = writeBearer("env-dial.bearer", "from-file\n", 0o600);
    const bothEnv: NodeJS.ProcessEnv = {
      LLAMACTL_TUNNEL_BEARER_FILE: fileBearer,
      LLAMACTL_TUNNEL_BEARER: "from-env",
    };
    const noFlags = parseServeFlags(["--dial-central=wss://127.0.0.1:1/tunnel"]);
    if ("error" in noFlags) {
      throw new Error(noFlags.error);
    }
    expect(expectOk(resolve(noFlags, bothEnv)).dialBearer).toBe("from-file");
    expect(expectOk(resolve(noFlags, { LLAMACTL_TUNNEL_BEARER: "from-env" })).dialBearer).toBe(
      "from-env",
    );

    const withFlag = parseServeFlags([
      "--dial-central=wss://127.0.0.1:1/tunnel",
      "--central-bearer=lit",
    ]);
    if ("error" in withFlag) {
      throw new Error(withFlag.error);
    }
    expect(expectOk(resolve(withFlag, bothEnv)).dialBearer).toBe("lit");
  });

  test("central-side: --tunnel-bearer-file and LLAMACTL_TUNNEL_CENTRAL_BEARER_FILE precedence", () => {
    const resolve = getResolver();
    const fileBearer = writeBearer("central.bearer", "c-tok\n", 0o600);

    const withFile = parseServeFlags([
      "--tunnel-central=true",
      `--tunnel-bearer-file=${fileBearer}`,
    ]);
    if ("error" in withFile) {
      throw new Error(withFile.error);
    }
    expect(expectOk(resolve(withFile, {})).tunnelCentralBearer).toBe("c-tok");

    const envOnly = parseServeFlags(["--tunnel-central=true"]);
    if ("error" in envOnly) {
      throw new Error(envOnly.error);
    }
    const resolved = expectOk(
      resolve(envOnly, {
        LLAMACTL_TUNNEL_CENTRAL_BEARER_FILE: fileBearer,
        LLAMACTL_TUNNEL_CENTRAL_BEARER: "env-lit",
      }),
    );
    expect(resolved.tunnelCentralBearer).toBe("c-tok");

    const weak = writeBearer("central-640.bearer", "c-tok\n", 0o640);
    const with640 = parseServeFlags(["--tunnel-central=true", `--tunnel-bearer-file=${weak}`]);
    if ("error" in with640) {
      throw new Error(with640.error);
    }
    const err640 = expectErr(resolve(with640, {}));
    expect(err640).toContain(weak);
    expect(err640).toContain("0640");
  });

  test("agent serve --central-bearer-file=<0644 file> exits 1 naming path + mode, never the secret", () => {
    const temp = makeTempRuntime();
    try {
      const bearer = writeBearer("cli-644.bearer", "cli-secret-tok\n", 0o644);
      const env = augment(temp.env, temp.devStorage);
      const r = runCli(
        [
          "agent",
          "serve",
          "--dial-central=wss://127.0.0.1:1/tunnel",
          `--central-bearer-file=${bearer}`,
        ],
        env,
      );
      // Flag validation runs before agent.yaml is read, so no agent init.
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(bearer);
      expect(r.stderr).toContain("0644");
      expect(r.stderr).not.toContain("cli-secret-tok");
    } finally {
      temp.cleanup();
    }
  });
});
