// RED for frozename/llamactl#289: `agent serve` gains
// --central-bearer-ref / --tunnel-bearer-ref so tunnel bearers can come
// from the macOS Keychain without entering a plist, a literal flag, or a
// process env var. New flag fields are read through a double cast and the
// resolver through a widened local type so this file compiles (and fails
// by assertion) before the fix lands.
import { createSecretResolver, type SecretResolver } from "@llamactl/core/config/secret";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as agentCmd from "../src/commands/agent.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

const { parseServeFlags } = agentCmd;

interface ResolvedBearers {
  dialBearer?: string;
  tunnelCentralBearer?: string;
}
type ResolveResult = ResolvedBearers | { error: string };
type ResolveFn = (
  parsed: unknown,
  env: NodeJS.ProcessEnv,
  warn?: (message: string) => void,
  deps?: { secretResolver?: SecretResolver },
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

function flagField(parsed: unknown, key: string): unknown {
  return (parsed as Record<string, unknown>)[key];
}

function expectOk(result: ResolveResult): ResolvedBearers {
  expect("error" in result).toBe(false);
  if ("error" in result) {
    throw new Error("unreachable");
  }
  return result;
}

function expectErr(result: ResolveResult): string {
  expect("error" in result).toBe(true);
  if (!("error" in result)) {
    throw new Error("unreachable");
  }
  return result.error;
}

function withTempDir<T>(prefix: string, run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeBearer(dir: string, name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  chmodSync(path, 0o600);
  return path;
}

interface KeychainBehavior {
  hostPlatform?: NodeJS.Platform;
  result?: string;
  throwError?: Error;
}

function makeKeychainResolver(
  calls: [string, string][],
  behavior: KeychainBehavior = {},
): SecretResolver {
  return createSecretResolver({
    env: {},
    hostPlatform: behavior.hostPlatform ?? "darwin",
    runSecurityCli: (service, account) => {
      calls.push([service, account]);
      if (behavior.throwError !== undefined) {
        throw behavior.throwError;
      }
      return behavior.result ?? "fake-keychain-tok\n";
    },
  });
}

function resolveWithKeychain(
  parsed: unknown,
  env: NodeJS.ProcessEnv,
  calls: [string, string][],
  warnings?: string[],
  behavior: KeychainBehavior = {},
): ResolveResult {
  const secretResolver = makeKeychainResolver(calls, behavior);
  const warn =
    warnings === undefined
      ? undefined
      : (message: string): void => {
          warnings.push(message);
        };
  return getResolver()(parsed, env, warn, { secretResolver });
}

describe("agent serve bearer-ref flags (#289)", () => {
  test("parseServeFlags accepts --central-bearer-ref", () => {
    const parsed = parseServeFlags([
      "--dial-central=wss://h:7843/tunnel",
      "--central-bearer-ref=keychain:llamactl/tunnel-bearer",
    ]);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) {
      throw new Error("unreachable");
    }
    expect(flagField(parsed, "centralBearerRef")).toBe("keychain:llamactl/tunnel-bearer");
  });

  test("parseServeFlags accepts --tunnel-bearer-ref", () => {
    const parsed = parseServeFlags([
      "--tunnel-central=true",
      "--tunnel-bearer-ref=keychain:llamactl/tunnel-central-bearer",
    ]);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) {
      throw new Error("unreachable");
    }
    expect(flagField(parsed, "tunnelBearerRef")).toBe("keychain:llamactl/tunnel-central-bearer");
  });

  test("resolveServeBearers resolves --central-bearer-ref through the injected keychain", () => {
    withTempDir("llamactl-bearer-ref-dial-", (dir) => {
      const calls: [string, string][] = [];
      const warnings: string[] = [];
      const result = resolveWithKeychain(
        {
          dir,
          dialCentral: "wss://h/t",
          centralBearerRef: "keychain:llamactl/tunnel-bearer",
        },
        {},
        calls,
        warnings,
      );
      expect(expectOk(result).dialBearer).toBe("fake-keychain-tok");
      expect(calls).toEqual([["llamactl", "tunnel-bearer"]]);
      expect(warnings).toEqual([]);
    });
  });

  test("resolveServeBearers resolves --tunnel-bearer-ref through the injected keychain", () => {
    withTempDir("llamactl-bearer-ref-central-", (dir) => {
      const calls: [string, string][] = [];
      const warnings: string[] = [];
      const result = resolveWithKeychain(
        {
          dir,
          tunnelCentral: true,
          tunnelBearerRef: "keychain:llamactl/tunnel-central-bearer",
        },
        {},
        calls,
        warnings,
      );
      expect(expectOk(result).tunnelCentralBearer).toBe("fake-keychain-tok");
      expect(calls).toEqual([["llamactl", "tunnel-central-bearer"]]);
      expect(warnings).toEqual([]);
    });
  });

  test("dial-side --central-bearer-ref beats file, default-file, and env sources", () => {
    withTempDir("llamactl-bearer-ref-precedence-", (dir) => {
      const calls: [string, string][] = [];
      const warnings: string[] = [];
      const envFile = writeBearer(dir, "env-file-bearer", "env-file-tok\n");
      writeBearer(dir, "tunnel-bearer", "default-file-tok\n");
      const env: NodeJS.ProcessEnv = {
        LLAMACTL_TUNNEL_BEARER_FILE: envFile,
        LLAMACTL_TUNNEL_BEARER: "plain-env-tok",
        LLAMACTL_TUNNEL_CENTRAL_BEARER: "plain-central-env-tok",
      };
      const result = resolveWithKeychain(
        {
          dir,
          dialCentral: "wss://h/t",
          centralBearerRef: "keychain:llamactl/tunnel-bearer",
        },
        env,
        calls,
        warnings,
      );
      expect(expectOk(result).dialBearer).toBe("fake-keychain-tok");
      expect(calls).toEqual([["llamactl", "tunnel-bearer"]]);
      expect(warnings).toEqual([]);
      expect("LLAMACTL_TUNNEL_BEARER" in env).toBe(false);
      expect("LLAMACTL_TUNNEL_CENTRAL_BEARER" in env).toBe(false);
    });
  });

  test("central-side --tunnel-bearer-ref beats file, default-file, and env sources", () => {
    withTempDir("llamactl-bearer-ref-central-precedence-", (dir) => {
      const calls: [string, string][] = [];
      const warnings: string[] = [];
      const envFile = writeBearer(dir, "env-central-file-bearer", "env-central-file-tok\n");
      writeBearer(dir, "tunnel-central-bearer", "default-central-file-tok\n");
      const env: NodeJS.ProcessEnv = {
        LLAMACTL_TUNNEL_CENTRAL_BEARER_FILE: envFile,
        LLAMACTL_TUNNEL_BEARER: "plain-dial-env-tok",
        LLAMACTL_TUNNEL_CENTRAL_BEARER: "plain-central-env-tok",
      };
      const result = resolveWithKeychain(
        {
          dir,
          tunnelCentral: true,
          tunnelBearerRef: "keychain:llamactl/tunnel-central-bearer",
        },
        env,
        calls,
        warnings,
      );
      expect(expectOk(result).tunnelCentralBearer).toBe("fake-keychain-tok");
      expect(calls).toEqual([["llamactl", "tunnel-central-bearer"]]);
      expect(warnings).toEqual([]);
      expect("LLAMACTL_TUNNEL_BEARER" in env).toBe(false);
      expect("LLAMACTL_TUNNEL_CENTRAL_BEARER" in env).toBe(false);
    });
  });

  test("--central-bearer-ref conflicts with --central-bearer naming both flags", () => {
    withTempDir("llamactl-bearer-ref-conflict-literal-", (dir) => {
      const calls: [string, string][] = [];
      const err = expectErr(
        resolveWithKeychain(
          {
            dir,
            dialCentral: "wss://h/t",
            centralBearer: "literal-tok",
            centralBearerRef: "keychain:llamactl/tunnel-bearer",
          },
          {},
          calls,
        ),
      );
      expect(err).toContain("--central-bearer-ref");
      expect(err).toMatch(/--central-bearer(?!-)/);
      expect(calls).toEqual([]);
    });
  });

  test("--central-bearer-ref conflicts with --central-bearer-file naming both flags", () => {
    withTempDir("llamactl-bearer-ref-conflict-file-", (dir) => {
      const calls: [string, string][] = [];
      const err = expectErr(
        resolveWithKeychain(
          {
            dir,
            dialCentral: "wss://h/t",
            centralBearerFile: "/abs/tb",
            centralBearerRef: "keychain:llamactl/tunnel-bearer",
          },
          {},
          calls,
        ),
      );
      expect(err).toContain("--central-bearer-ref");
      expect(err).toContain("--central-bearer-file");
      expect(calls).toEqual([]);
    });
  });

  test("--tunnel-bearer-ref conflicts with --tunnel-bearer naming both flags", () => {
    withTempDir("llamactl-bearer-ref-central-conflict-literal-", (dir) => {
      const calls: [string, string][] = [];
      const err = expectErr(
        resolveWithKeychain(
          {
            dir,
            tunnelCentral: true,
            tunnelBearer: "literal-central-tok",
            tunnelBearerRef: "keychain:llamactl/tunnel-central-bearer",
          },
          {},
          calls,
        ),
      );
      expect(err).toContain("--tunnel-bearer-ref");
      expect(err).toMatch(/--tunnel-bearer(?!-)/);
      expect(calls).toEqual([]);
    });
  });

  test("--tunnel-bearer-ref conflicts with --tunnel-bearer-file naming both flags", () => {
    withTempDir("llamactl-bearer-ref-central-conflict-file-", (dir) => {
      const calls: [string, string][] = [];
      const err = expectErr(
        resolveWithKeychain(
          {
            dir,
            tunnelCentral: true,
            tunnelBearerFile: "/abs/cb",
            tunnelBearerRef: "keychain:llamactl/tunnel-central-bearer",
          },
          {},
          calls,
        ),
      );
      expect(err).toContain("--tunnel-bearer-ref");
      expect(err).toContain("--tunnel-bearer-file");
      expect(calls).toEqual([]);
    });
  });

  test.each(["env:FOO", "$FOO", "file:/abs/tb", "/abs/tb"] as const)(
    "non-keychain --central-bearer-ref value %s is rejected before resolution",
    (ref) => {
      withTempDir("llamactl-bearer-ref-schemes-", (dir) => {
        const calls: [string, string][] = [];
        const err = expectErr(
          resolveWithKeychain(
            {
              dir,
              dialCentral: "wss://h/t",
              centralBearerRef: ref,
            },
            {},
            calls,
          ),
        );
        expect(err).toContain("--central-bearer-ref");
        expect(err).toContain("keychain:");
        expect(err).toContain("--central-bearer-file");
        expect(calls).toEqual([]);
      });
    },
  );

  test("keychain lookup failure names the ref, service, and account without leaking the token", () => {
    withTempDir("llamactl-bearer-ref-keychain-miss-", (dir) => {
      const calls: [string, string][] = [];
      const err = expectErr(
        resolveWithKeychain(
          {
            dir,
            dialCentral: "wss://h/t",
            centralBearerRef: "keychain:llamactl/tunnel-bearer",
          },
          {},
          calls,
          undefined,
          { throwError: new Error("security backend failed") },
        ),
      );
      expect(err).toContain("--central-bearer-ref");
      expect(err).toContain("llamactl");
      expect(err).toContain("tunnel-bearer");
      expect(err).not.toContain("fake-keychain-tok");
    });
  });

  test("keychain refs on non-macOS hosts fail with a labelled platform error", () => {
    withTempDir("llamactl-bearer-ref-platform-", (dir) => {
      const calls: [string, string][] = [];
      const err = expectErr(
        resolveWithKeychain(
          {
            dir,
            dialCentral: "wss://h/t",
            centralBearerRef: "keychain:llamactl/tunnel-bearer",
          },
          {},
          calls,
          undefined,
          { hostPlatform: "linux" },
        ),
      );
      expect(err).toContain("--central-bearer-ref");
      expect(err).toContain("macOS");
      expect(err).not.toContain("fake-keychain-tok");
    });
  });

  test("an empty keychain result is rejected as empty without leaking the token", () => {
    withTempDir("llamactl-bearer-ref-empty-", (dir) => {
      const calls: [string, string][] = [];
      const err = expectErr(
        resolveWithKeychain(
          {
            dir,
            dialCentral: "wss://h/t",
            centralBearerRef: "keychain:llamactl/tunnel-bearer",
          },
          {},
          calls,
          undefined,
          { result: "\n" },
        ),
      );
      expect(err).toContain("--central-bearer-ref");
      expect(err).toContain("empty");
      expect(err).not.toContain("fake-keychain-tok");
    });
  });

  test("a dial-side ref is read even without --dial-central and errors stay redacted", () => {
    withTempDir("llamactl-bearer-ref-standalone-", (dir) => {
      const calls: [string, string][] = [];
      const err = expectErr(
        resolveWithKeychain(
          {
            dir,
            centralBearerRef: "keychain:llamactl/tunnel-bearer",
          },
          {},
          calls,
          undefined,
          { throwError: new Error("security backend failed") },
        ),
      );
      expect(err).not.toContain("fake-keychain-tok");
    });
  });
});
