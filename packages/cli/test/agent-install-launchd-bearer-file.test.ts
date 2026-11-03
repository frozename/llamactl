// RED for frozename/llamactl#289: `agent install-launchd` must never
// write the tunnel bearer into the launchd plist. Secret-looking --env
// keys are rejected, and the tunnel wiring is expressed as
// --*-bearer-file flags forwarded into ProgramArguments, which the
// agent resolves from a 0600 file at serve time.
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

describe("install-launchd bearer-file flags (#289)", () => {
  test("--env rejects secret-looking keys; file + cache keys stay accepted", () => {
    const rejected: { key: string; value: string; hint?: string }[] = [
      { key: "LLAMACTL_TUNNEL_BEARER", value: "s3cret", hint: "--central-bearer-file" },
      { key: "LLAMACTL_TUNNEL_CENTRAL_BEARER", value: "c3ntral", hint: "bearer-file" },
      { key: "HF_TOKEN", value: "hf-tok" },
      { key: "FOO_SECRET", value: "shh" },
      { key: "FOO_KEY", value: "k3y" },
    ];
    for (const { key, value, hint } of rejected) {
      const parsed = parseInstallLaunchdFlags([`--env=${key}=${value}`]);
      expect("error" in parsed).toBe(true);
      if ("error" in parsed) {
        expect(parsed.error).toContain(key);
        expect(parsed.error).not.toContain(value);
        if (hint !== undefined) {
          expect(parsed.error).toContain(hint);
        }
      }
    }
    // Path-valued and cache-dir env keys are not secrets and stay legal.
    const fileKey = parseInstallLaunchdFlags(["--env=LLAMACTL_TUNNEL_BEARER_FILE=/abs/p"]);
    expect("error" in fileKey).toBe(false);
    const homeKey = parseInstallLaunchdFlags(["--env=HF_HOME=/x"]);
    expect("error" in homeKey).toBe(false);
  });

  test("--dial-central + --tunnel-node-name + --central-bearer-file parse cleanly", () => {
    const parsed = parseInstallLaunchdFlags([
      "--dial-central=wss://h:7843/tunnel",
      "--tunnel-node-name=m4-pro",
      "--central-bearer-file=/abs/tb",
    ]);
    expect("error" in parsed).toBe(false);
  });

  test("--central-bearer-file must be absolute; --dial-central requires a bearer file", () => {
    const rel = parseInstallLaunchdFlags(["--central-bearer-file=relative/path"]);
    expect("error" in rel).toBe(true);
    if ("error" in rel) {
      expect(rel.error).toContain("absolute");
    }

    const noBearer = parseInstallLaunchdFlags(["--dial-central=wss://h:7843/tunnel"]);
    expect("error" in noBearer).toBe(true);
    if ("error" in noBearer) {
      expect(noBearer.error).toContain("--central-bearer-file");
    }
  });

  test("dry-run: --central-bearer-file lands in ProgramArguments, no secret env, no writes", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-launchd-bearer-"));
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
          "--central-bearer-file=/abs/tb",
        ],
        deps,
      );
      expect(code).toBe(0);
      const plist = stdoutChunks.join("");
      expect(plist).toContain("<string>--central-bearer-file=/abs/tb</string>");
      expect(plist).toContain("<string>--dial-central=wss://h:7843/tunnel</string>");
      expect(plist).toContain("<string>--tunnel-node-name=m4-pro</string>");
      expect(plist).not.toContain("LLAMACTL_TUNNEL_BEARER");
      expect(counts.write).toBe(0);
      expect(counts.copy).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("dry-run: --tunnel-bearer-file adds --tunnel-central=true to ProgramArguments", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-launchd-bearer-central-"));
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
          "--central-bearer-file=/abs/tb",
          "--tunnel-bearer-file=/abs/cb",
        ],
        deps,
      );
      expect(code).toBe(0);
      const plist = stdoutChunks.join("");
      expect(plist).toContain("<string>--tunnel-central=true</string>");
      expect(plist).toContain("<string>--tunnel-bearer-file=/abs/cb</string>");
      expect(counts.write).toBe(0);
      expect(counts.copy).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
