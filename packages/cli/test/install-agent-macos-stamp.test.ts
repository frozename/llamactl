import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../src/safe-fs.js";

// #743 RED: the installer must stamp compiled binaries and verify the stamp
// before replacing the user's existing agent binary.

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "tools", "install-agent-macos.sh");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SHORT_COMMIT = "0123456789ab";
const DEFAULT_VERSION_LINE = `llamactl 0.0.0 (${SHORT_COMMIT}, built 2026-11-26T00:00:00.000Z, compiled)`;
const BINARY_NAME = "llamactl-agent";

const FAKE_BUN = `#!/bin/sh
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "$FAKE_BUN_LOG"
done

outfile=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--outfile" ]; then
    shift
    outfile="$1"
    break
  fi
  shift
done

if [ -n "$outfile" ]; then
  cat > "$outfile" <<EOF
#!/bin/sh
if [ "\\$1" = "--version" ]; then
  printf '%s\\n' "$FAKE_VERSION_LINE"
fi
EOF
  chmod 755 "$outfile"
fi
`;

const FAKE_GIT = `#!/bin/sh
line=""
for arg in "$@"; do
  if [ -z "$line" ]; then
    line="$arg"
  else
    line="$line $arg"
  fi
done
printf '%s\\n' "$line" >> "$FAKE_GIT_LOG"

if [ "$FAKE_GIT_FAIL" = "1" ]; then
  exit 128
fi

for arg in "$@"; do
  if [ "$arg" = "rev-parse" ]; then
    printf '%s\\n' "$FAKE_GIT_COMMIT"
  fi
  if [ "$arg" = "status" ]; then
    printf '%s\\n' "$FAKE_GIT_PORCELAIN"
  fi
done
`;

interface EnvOverrides {
  fakeGitCommit?: string;
  fakeGitFail?: string;
  fakeGitPorcelain?: string;
  fakeVersionLine?: string;
}

interface InstallerRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let tmp = "";

function binDir(): string {
  return join(tmp, "bin");
}

function homeDir(): string {
  return join(tmp, "home");
}

function installDir(): string {
  return join(homeDir(), ".local", "bin");
}

function installedBinaryPath(): string {
  return join(installDir(), BINARY_NAME);
}

function makeEnv(overrides: EnvOverrides = {}): Record<string, string> {
  return {
    HOME: homeDir(),
    PATH: `${binDir()}:/usr/bin:/bin`,
    FAKE_BUN_LOG: join(tmp, "bun.log"),
    FAKE_GIT_LOG: join(tmp, "git.log"),
    FAKE_GIT_COMMIT: overrides.fakeGitCommit ?? COMMIT,
    FAKE_GIT_PORCELAIN: overrides.fakeGitPorcelain ?? "",
    FAKE_GIT_FAIL: overrides.fakeGitFail ?? "0",
    FAKE_VERSION_LINE: overrides.fakeVersionLine ?? DEFAULT_VERSION_LINE,
  };
}

function installFakes(): void {
  mkdirSync(binDir(), { recursive: true });
  writeFileSync(join(binDir(), "bun"), FAKE_BUN);
  chmodSync(join(binDir(), "bun"), 0o755);
  writeFileSync(join(binDir(), "git"), FAKE_GIT);
  chmodSync(join(binDir(), "git"), 0o755);
}

function runInstaller(args: string[], env: Record<string, string>): InstallerRun {
  const proc = Bun.spawnSync([Bun.which("bash") ?? "/bin/bash", SCRIPT, ...args], {
    env,
    cwd: tmp,
  });
  const decoder = new TextDecoder();
  return {
    exitCode: proc.exitCode,
    stdout: decoder.decode(proc.stdout),
    stderr: decoder.decode(proc.stderr),
  };
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function readTextIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function installEntries(): string[] {
  if (!existsSync(installDir())) return [];
  return readdirSync(installDir());
}

function seedInstalledBinary(contents: string): void {
  mkdirSync(installDir(), { recursive: true });
  writeFileSync(installedBinaryPath(), contents);
}

function expectNoPartialBinary(): void {
  expect(installEntries().some((entry) => entry.startsWith(`${BINARY_NAME}.partial`))).toBe(false);
}

describe("tools/install-agent-macos.sh build stamp (#743)", () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "install-agent-stamp-"));
    installFakes();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("clean tree compiles with commit, dirty and built-at defines", () => {
    const run = runInstaller([], makeEnv());
    expect(run.exitCode).toBe(0);

    const bunLog = readLines(join(tmp, "bun.log"));
    expect(bunLog).toContain("--compile");
    expect(bunLog).toContain("--target=bun-darwin-arm64");
    expect(bunLog).toContain(join(REPO_ROOT, "packages", "cli", "src", "bin.ts"));
    expect(bunLog).toContain("--define");
    expect(bunLog).toContain(`__BUILD_STAMP_COMMIT__="${COMMIT}"`);
    expect(bunLog).toContain("__BUILD_STAMP_DIRTY__=false");
    expect(
      bunLog.some((line) =>
        /^__BUILD_STAMP_BUILT_AT__="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"$/.test(line),
      ),
    ).toBe(true);

    const gitLog = readLines(join(tmp, "git.log"));
    expect(gitLog.some((line) => line.includes(`-C ${REPO_ROOT} rev-parse HEAD`))).toBe(true);
    expect(gitLog.some((line) => line.includes("status --porcelain --untracked-files=no"))).toBe(
      true,
    );

    expect(existsSync(installedBinaryPath())).toBe(true);
    expectNoPartialBinary();
  });

  test("dirty tree without --allow-dirty refuses before compiling or replacing", () => {
    seedInstalledBinary("OLD");
    const run = runInstaller(
      [],
      makeEnv({ fakeGitPorcelain: " M packages/core/src/nodeFacts.ts" }),
    );

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("--allow-dirty");
    expect(readLines(join(tmp, "bun.log"))).toEqual([]);
    expect(readTextIfExists(installedBinaryPath())).toBe("OLD");
  });

  test("dirty tree with --allow-dirty compiles with the dirty stamp", () => {
    const run = runInstaller(
      ["--allow-dirty"],
      makeEnv({ fakeGitPorcelain: " M packages/core/src/nodeFacts.ts" }),
    );

    expect(run.exitCode).toBe(0);
    const bunLog = readLines(join(tmp, "bun.log"));
    expect(bunLog).toContain(`__BUILD_STAMP_COMMIT__="${COMMIT}"`);
    expect(bunLog).toContain("__BUILD_STAMP_DIRTY__=true");
  });

  test("rev-parse failure refuses before compiling", () => {
    const run = runInstaller([], makeEnv({ fakeGitFail: "1" }));

    expect(run.exitCode).not.toBe(0);
    expect(readLines(join(tmp, "bun.log"))).toEqual([]);
  });

  test("malformed commit refuses before compiling", () => {
    const run = runInstaller([], makeEnv({ fakeGitCommit: "not-a-sha" }));

    expect(run.exitCode).not.toBe(0);
    expect(readLines(join(tmp, "bun.log"))).toEqual([]);
  });

  test("self-check failure keeps the previously installed binary", () => {
    seedInstalledBinary("OLD");
    const run = runInstaller([], makeEnv({ fakeVersionLine: "llamactl 0.0.0" }));

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain(SHORT_COMMIT);
    expect(readTextIfExists(installedBinaryPath())).toBe("OLD");
    expectNoPartialBinary();
  });

  test("unknown argument exits with usage status before compiling", () => {
    const run = runInstaller(["--bogus"], makeEnv());

    expect(run.exitCode).toBe(2);
    expect(readLines(join(tmp, "bun.log"))).toEqual([]);
  });
});
