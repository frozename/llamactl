// RED for frozename/llamactl#289: `agent install-launchd` must be able
// to write keychain bearer references into ProgramArguments. The launchd
// plist stays token-free while the agent resolves the reference at serve
// time through the injected secret resolver.
import type { SpawnSyncReturns } from "node:child_process";

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type FsLike,
  type InstallLaunchdDeps,
  parseInstallLaunchdFlags,
  runAgentInstallLaunchd,
} from "../src/commands/agent-install/index.js";
import {
  accessSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "../src/safe-fs.js";

function makeDeps(env: NodeJS.ProcessEnv): {
  deps: InstallLaunchdDeps;
  stdoutChunks: string[];
  stderrChunks: string[];
  counts: { write: number; copy: number };
} {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const counts = { write: 0, copy: 0 };
  const fs: FsLike = {
    existsSync,
    mkdirSync,
    writeFileSync: (): void => {
      counts.write += 1;
    },
    readFileSync,
    chmodSync,
    copyFileSync: (): void => {
      counts.copy += 1;
    },
    unlinkSync,
    statSync,
    accessSync,
  };
  const deps: InstallLaunchdDeps = {
    spawnSync: (): SpawnSyncReturns<string> => ({
      pid: 0,
      output: ["", "", ""],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    }),
    fs,
    // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the deps interface.
    fetchAgentRelease: async () => ({
      ok: true,
      version: "v0.0.0",
      target: "darwin-arm64",
      path: "/unused",
      sha256: "unused",
      bytes: 0,
      signature: { verified: null, reason: "skipped" },
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the deps interface.
    buildAgentBinary: async () => ({ ok: true, outPath: "/unused", code: 0 }),
    stdout: (c) => {
      stdoutChunks.push(c);
    },
    stderr: (c) => {
      stderrChunks.push(c);
    },
    now: Date.now,
    sleep: () => Promise.resolve(),
    getuid: () => 501,
    platform: "darwin",
    env,
  };
  return { deps, stdoutChunks, stderrChunks, counts };
}

function flagField(parsed: unknown, key: string): unknown {
  return (parsed as Record<string, unknown>)[key];
}

describe("install-launchd bearer-ref flags (#289)", () => {
  test("parseInstallLaunchdFlags accepts --central-bearer-ref", () => {
    const parsed = parseInstallLaunchdFlags([
      "--dial-central=wss://h:7843/tunnel",
      "--central-bearer-ref=keychain:llamactl/tunnel-bearer",
    ]);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) {
      throw new Error("unreachable");
    }
    expect(flagField(parsed, "centralBearerRef")).toBe("keychain:llamactl/tunnel-bearer");
  });

  test("dry-run writes bearer refs into ProgramArguments without env secrets or writes", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-launchd-bearer-ref-"));
    try {
      const binary = join(tmp, "agent-bin");
      writeFileSync(binary, "#!/bin/sh\necho ok\n");
      chmodSync(binary, 0o755);
      const installPath = join(tmp, "installed", "llamactl-agent");
      const { deps, stdoutChunks, counts } = makeDeps({ HOME: tmp, USER: "tester" });

      const code = await runAgentInstallLaunchd(
        [
          "--dry-run",
          `--binary=${binary}`,
          `--install-path=${installPath}`,
          "--dial-central=wss://h:7843/tunnel",
          "--tunnel-node-name=m4-pro",
          "--central-bearer-ref=keychain:llamactl/tunnel-bearer",
          "--tunnel-bearer-ref=keychain:llamactl/tunnel-central-bearer",
        ],
        deps,
      );
      expect(code).toBe(0);
      const plist = stdoutChunks.join("");
      expect(plist).toContain(
        "<string>--central-bearer-ref=keychain:llamactl/tunnel-bearer</string>",
      );
      expect(plist).toContain("<string>--tunnel-central=true</string>");
      expect(plist).toContain(
        "<string>--tunnel-bearer-ref=keychain:llamactl/tunnel-central-bearer</string>",
      );
      expect(plist).not.toContain("LLAMACTL_TUNNEL_BEARER");
      expect(counts.write).toBe(0);
      expect(counts.copy).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("non-keychain --central-bearer-ref values are rejected", () => {
    const parsed = parseInstallLaunchdFlags([
      "--dial-central=wss://h:7843/tunnel",
      "--central-bearer-ref=env:FOO",
    ]);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) {
      expect(parsed.error).toContain("keychain:");
    }
  });

  test("--central-bearer-file and --central-bearer-ref conflict naming both flags", () => {
    const parsed = parseInstallLaunchdFlags([
      "--dial-central=wss://h:7843/tunnel",
      "--central-bearer-file=/abs/tb",
      "--central-bearer-ref=keychain:a/b",
    ]);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) {
      expect(parsed.error).toContain("--central-bearer-file");
      expect(parsed.error).toContain("--central-bearer-ref");
    }
  });

  test("--dial-central accepts either a bearer file or bearer ref in its error", () => {
    const parsed = parseInstallLaunchdFlags(["--dial-central=wss://h:7843/tunnel"]);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) {
      expect(parsed.error).toContain("--central-bearer-file");
      expect(parsed.error).toContain("--central-bearer-ref");
    }
  });

  test("--central-bearer-ref without --dial-central is rejected", () => {
    const parsed = parseInstallLaunchdFlags(["--central-bearer-ref=keychain:a/b"]);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) {
      expect(parsed.error).toContain("--dial-central");
    }
  });

  test("non-keychain --tunnel-bearer-ref values are rejected", () => {
    const parsed = parseInstallLaunchdFlags(["--tunnel-bearer-ref=env:FOO"]);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) {
      expect(parsed.error).toContain("keychain:");
    }
  });

  test("--tunnel-bearer-file and --tunnel-bearer-ref conflict naming both flags", () => {
    const parsed = parseInstallLaunchdFlags([
      "--tunnel-bearer-file=/abs/cb",
      "--tunnel-bearer-ref=keychain:a/b",
    ]);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) {
      expect(parsed.error).toContain("--tunnel-bearer-file");
      expect(parsed.error).toContain("--tunnel-bearer-ref");
    }
  });
});
