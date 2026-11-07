// RED pins for frozename/llamactl#410 (P7-A) — the `llamactl console`
// launcher for the web console. Every case spawns the real CLI as a
// subprocess against temp dirs; fake `open`/`xdg-open` shims sit first
// on PATH so no real browser can launch. Pinned contract: loopback-only
// flag refusals, the missing-dist build:web hint, the printed
// `Console: http://127.0.0.1:<port>` URL, the port-scoped session cookie
// and Host guard on GET /, clean SIGTERM/SIGINT shutdown, and --open
// handing the URL to the opener.

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../src/safe-fs.js";

const CLI_BIN = join(import.meta.dir, "..", "src", "bin.ts");
const INDEX_HTML = "<!doctype html><title>console-launcher-test</title>";
const CONSOLE_URL_RE = /Console: (http:\/\/127\.0\.0\.1:(\d+))/;
const SPAWN_TIMEOUT_MS = 30_000;

const tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ConsoleFixture {
  distDir: string;
  emptyDistDir: string;
  env: Record<string, string | undefined>;
  markerPath: string;
}

// Temp runtime per case: opener shims first on PATH, a populated dist
// dir, an empty dist dir for the missing-index case, and a marker file
// the shims write their argv to. LLAMACTL_CONFIG points at a file that
// does not exist — the launcher must serve / without a kubeconfig.
function makeFixture(): ConsoleFixture {
  const root = tmpDir("llamactl-console-cli-");
  const fakeBin = join(root, "fake-bin");
  const distDir = join(root, "dist");
  const emptyDistDir = join(root, "empty-dist");
  const storageDir = join(root, "storage");
  for (const dir of [fakeBin, distDir, emptyDistDir, storageDir]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(distDir, "index.html"), INDEX_HTML);
  const markerPath = join(root, "opened");
  for (const name of ["open", "xdg-open"]) {
    const shim = join(fakeBin, name);
    writeFileSync(shim, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$CONSOLE_TEST_OPEN_MARKER"\n');
    chmodSync(shim, 0o755);
  }
  return {
    distDir,
    emptyDistDir,
    env: {
      ...process.env,
      CONSOLE_TEST_OPEN_MARKER: markerPath,
      DEV_STORAGE: storageDir,
      LLAMACTL_CONFIG: join(root, "config"),
      PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
    },
    markerPath,
  };
}

type ConsoleProc = Bun.Subprocess<"ignore", "pipe", "pipe">;

function spawnConsole(args: string[], env: Record<string, string | undefined>): ConsoleProc {
  return Bun.spawn([process.execPath, CLI_BIN, "console", ...args], {
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
}

async function collect(
  proc: ConsoleProc,
): Promise<{ code: number; stderr: string; stdout: string }> {
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stderr, stdout };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          resolve("timeout");
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Accumulate stdout until `regex` matches; resolves with the match, or
// null when the stream ends or the deadline passes.
async function readUntil(
  stream: ReadableStream<Uint8Array>,
  regex: RegExp,
  timeoutMs = 10_000,
): Promise<RegExpMatchArray | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = "";
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const chunk = await withTimeout(reader.read(), remaining);
      if (chunk === "timeout") return null;
      if (chunk.done) {
        text += decoder.decode();
        return text.match(regex);
      }
      text += decoder.decode(chunk.value, { stream: true });
      const match = text.match(regex);
      if (match !== null) return match;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function pollUntil(cond: () => boolean, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15);
    });
  }
  return cond();
}

describe("llamactl console", () => {
  describe("argument refusals", () => {
    const REFUSAL_CASES: {
      args: string[];
      name: string;
      stderrIncludes?: string;
      stderrMatches?: RegExp;
    }[] = [
      {
        args: ["--host", "0.0.0.0"],
        name: "--host 0.0.0.0",
        stderrMatches: /loopback/i,
      },
      { args: ["--host", "::"], name: "--host ::", stderrMatches: /loopback/i },
      { args: ["--port", "abc"], name: "--port abc", stderrIncludes: "--port" },
      { args: ["--port", "70000"], name: "--port 70000", stderrIncludes: "--port" },
      { args: ["--port", "-1"], name: "--port -1", stderrIncludes: "--port" },
      { args: ["--port", "1.5"], name: "--port 1.5", stderrIncludes: "--port" },
      { args: ["--port"], name: "--port without a value", stderrIncludes: "--port" },
      { args: ["--bogus"], name: "--bogus" },
    ];

    for (const refusal of REFUSAL_CASES) {
      test(
        `${refusal.name} is refused`,
        async () => {
          const fx = makeFixture();
          const proc = spawnConsole(["--dist", fx.distDir, ...refusal.args], fx.env);
          try {
            const { code, stderr, stdout } = await collect(proc);
            expect(code).not.toBe(0);
            expect(stderr).not.toContain("Unknown command");
            expect(stderr).toContain("llamactl console:");
            if (refusal.stderrIncludes !== undefined) {
              expect(stderr).toContain(refusal.stderrIncludes);
            }
            if (refusal.stderrMatches !== undefined) {
              expect(stderr).toMatch(refusal.stderrMatches);
            }
            expect(stdout).not.toMatch(/Console: http/);
          } finally {
            proc.kill("SIGKILL");
          }
        },
        SPAWN_TIMEOUT_MS,
      );
    }
  });

  test(
    "a dist dir without index.html exits 1 with the build:web hint",
    async () => {
      const fx = makeFixture();
      const proc = spawnConsole(["--port", "0", "--dist", fx.emptyDistDir], fx.env);
      try {
        const { code, stderr, stdout } = await collect(proc);
        expect(code).toBe(1);
        expect(stderr).toContain("bun run --cwd packages/app build:web");
        expect(stderr).toContain(join(fx.emptyDistDir, "index.html"));
        expect(stderr).not.toContain("Unknown command");
        expect(stdout).not.toMatch(/Console: http/);
      } finally {
        proc.kill("SIGKILL");
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(
      `serves the console on loopback and exits 0 on ${signal}`,
      async () => {
        const fx = makeFixture();
        const proc = spawnConsole(["--port", "0", "--dist", fx.distDir], fx.env);
        try {
          const match = await readUntil(proc.stdout, CONSOLE_URL_RE);
          expect(match).not.toBeNull();
          const url = match?.[1] ?? "";
          const port = Number(match?.[2] ?? "0");
          expect(url).not.toBe("");
          expect(port).toBeGreaterThan(0);

          const index = await fetch(`${url}/`);
          expect(index.status).toBe(200);
          expect(await index.text()).toBe(INDEX_HTML);
          const cookies = index.headers.getAll("set-cookie");
          expect(cookies.some((line) => line.startsWith(`llamactl_console_${String(port)}=`))).toBe(
            true,
          );

          const foreign = await fetch(`${url}/`, {
            headers: { host: `evil.test:${String(port)}` },
          });
          expect(foreign.status).not.toBe(200);

          proc.kill(signal);
          expect(await withTimeout(proc.exited, 5_000)).toBe(0);

          const afterKill = await fetch(`${url}/`).then(
            () => "resolved",
            () => "rejected",
          );
          expect(afterKill).toBe("rejected");
          expect(existsSync(fx.markerPath)).toBe(false);
        } finally {
          proc.kill("SIGKILL");
        }
      },
      SPAWN_TIMEOUT_MS,
    );
  }

  test(
    "--open hands the printed URL to the platform opener",
    async () => {
      const fx = makeFixture();
      const proc = spawnConsole(["--port", "0", "--dist", fx.distDir, "--open"], fx.env);
      try {
        const match = await readUntil(proc.stdout, CONSOLE_URL_RE);
        expect(match).not.toBeNull();
        const url = match?.[1] ?? "";
        expect(url).not.toBe("");

        const opened = await pollUntil(
          () => existsSync(fx.markerPath) && readFileSync(fx.markerPath, "utf8").includes(url),
          5_000,
        );
        expect(opened).toBe(true);

        proc.kill("SIGTERM");
        expect(await withTimeout(proc.exited, 5_000)).toBe(0);
      } finally {
        proc.kill("SIGKILL");
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
