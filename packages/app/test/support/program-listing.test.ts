// packages/app/test/support/program-listing.test.ts
// Issue #777: contract tests for the file-sink capture helper behind
// electron-removed RED 2a. Under bun, tsc's process.exit drops stdout writes
// still buffered when stdout is a pipe (measured: 535 of 1667 lines through a
// slow pipe), so the helper must capture to a regular file (synchronous
// writes), report the child's exit code and stderr, and remove its temp dir.
// Cases A-E and G pin the helper surface; case F pins the RED 2a content contract
// through the same capture. The support module is imported dynamically with a
// fallback so every case fails by assertion at the base commit — never by
// import error.

import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "../../src/safe-fs.js";

type CaptureOptions = { cmd: string[]; cwd?: string; tmpRoot?: string };
type CaptureResult = { exitCode: number | null; stdout: string; stderr: string };
type ProgramListing = {
  captureStdoutToFile: (options: CaptureOptions) => CaptureResult;
  describeListing: (lines: readonly string[], tail?: number) => string;
  splitListing: (text: string) => string[];
};

const APP = join(import.meta.dir, "..", "..");
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");

const PROBE_BODY_LINES = 5_000;
const SUBPROCESS_TIMEOUT_MS = 60_000;

const SINK_PROBE_SOURCE = `
import { fstatSync } from "node:fs";
const kind = fstatSync(1).isFile() ? "sink=file" : "sink=other";
const out = [kind];
for (let index = 0; index < ${String(PROBE_BODY_LINES)}; index += 1) {
  out.push("listing-line-" + index);
}
process.stdout.write(out.join("\\n") + "\\n");
process.exit(0);
`;

const support: Partial<ProgramListing> = await import("./program-listing.js").catch(() => ({}));

function capture(options: CaptureOptions): CaptureResult {
  const fn = support.captureStdoutToFile;
  if (typeof fn !== "function") {
    throw new Error("captureStdoutToFile is not implemented");
  }
  return fn(options);
}

function split(text: string): string[] {
  const fn = support.splitListing;
  if (typeof fn !== "function") {
    throw new Error("splitListing is not implemented");
  }
  return fn(text);
}

function describeLines(lines: readonly string[], tail?: number): string {
  const fn = support.describeListing;
  if (typeof fn !== "function") {
    throw new Error("describeListing is not implemented");
  }
  return fn(lines, tail);
}

function listingReport(lines: readonly string[]): string {
  const fn = support.describeListing;
  return typeof fn === "function" ? fn(lines) : "program-listing support is not implemented";
}

function capturedListing(): string[] {
  const captureFn = support.captureStdoutToFile;
  const splitFn = support.splitListing;
  if (typeof captureFn !== "function" || typeof splitFn !== "function") {
    return [];
  }
  const proc = captureFn({
    cmd: [process.execPath, TSC, "-p", "tsconfig.json", "--listFilesOnly"],
    cwd: APP,
  });
  expect(proc.exitCode, proc.stderr).toBe(0);
  return splitFn(proc.stdout);
}

describe("program listing capture (#777)", () => {
  test("A: captures child stdout through a regular-file sink, not a pipe", () => {
    expect(support.captureStdoutToFile).toBeFunction();
    const dir = mkdtempSync(join(tmpdir(), "llamactl-sink-probe-"));
    try {
      const probe = join(dir, "sink-probe.ts");
      writeFileSync(probe, SINK_PROBE_SOURCE);
      const result = capture({ cmd: [process.execPath, probe] });
      expect(result.exitCode, result.stderr).toBe(0);
      const lines = split(result.stdout);
      expect(lines[0]).toBe("sink=file");
      expect(lines.length).toBe(PROBE_BODY_LINES + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Kills mutations "always tmpdir()" (the child sees an empty root) and
  // "no rmSync" (root is not empty afterwards).
  test("B: creates its temp directory under tmpRoot and removes it afterwards", () => {
    expect(support.captureStdoutToFile).toBeFunction();
    const root = mkdtempSync(join(tmpdir(), "llamactl-tmproot-"));
    try {
      const script = [
        'const { readdirSync } = require("node:fs");',
        'console.log("ok");',
        `process.stderr.write(JSON.stringify(readdirSync(${JSON.stringify(root)})));`,
      ].join(" ");
      const result = capture({ cmd: [process.execPath, "-e", script], tmpRoot: root });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe("ok\n");
      const during: unknown = JSON.parse(result.stderr);
      expect(Array.isArray(during), result.stderr).toBe(true);
      const entries = Array.isArray(during) ? during.map(String) : [];
      expect(entries.length, result.stderr).toBe(1);
      expect(
        entries.every((entry) => entry.startsWith("llamactl-listing-")),
        result.stderr,
      ).toBe(true);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("C: reports the child exit code and pipes stderr", () => {
    expect(support.captureStdoutToFile).toBeFunction();
    const result = capture({
      cmd: [
        process.execPath,
        "-e",
        "process.stderr.write('boom\\n'); process.stdout.write('partial\\n'); process.exit(7);",
      ],
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("boom");
    expect(result.stdout).toContain("partial");
  });

  test("D: splitListing splits on CRLF and LF and drops empty lines", () => {
    expect(support.splitListing).toBeFunction();
    expect(split("a\r\nb\n\nc\n")).toEqual(["a", "b", "c"]);
    expect(split("")).toEqual([]);
  });

  test("E: describeListing reports the captured line count and tail", () => {
    expect(support.describeListing).toBeFunction();
    const lines = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"];
    expect(describeLines(lines)).toBe("captured 7 lines; last 5:\nl3\nl4\nl5\nl6\nl7");
    expect(describeLines(lines, 2)).toBe("captured 7 lines; last 2:\nl6\nl7");
    expect(describeLines(["only"])).toBe("captured 1 lines; last 1:\nonly");
  });

  test(
    "F: the tsc program listing reaches main.web.tsx and no electron dir",
    () => {
      const files = capturedListing();
      expect(
        files.some((line) => line.endsWith("packages/app/src/main.web.tsx")),
        listingReport(files),
      ).toBe(true);
      expect(
        files.filter((line) => line.includes("/packages/app/electron/")),
        listingReport(files),
      ).toEqual([]);
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  // Kills mutation "drop cwd forwarding" (the child inherits the test's cwd).
  test("G: runs the child in the given cwd", () => {
    expect(support.captureStdoutToFile).toBeFunction();
    const dir = mkdtempSync(join(tmpdir(), "llamactl-cwd-probe-"));
    try {
      const script = [
        'const { realpathSync } = require("node:fs");',
        "process.stdout.write(JSON.stringify({",
        "cwd: realpathSync(process.cwd()),",
        `dir: realpathSync(${JSON.stringify(dir)}),`,
        "}));",
      ].join(" ");
      const result = capture({ cmd: [process.execPath, "-e", script], cwd: dir });
      expect(result.exitCode, result.stderr).toBe(0);
      const reported: unknown = JSON.parse(result.stdout);
      const paths =
        typeof reported === "object" && reported !== null && "cwd" in reported && "dir" in reported
          ? { cwd: String(reported.cwd), dir: String(reported.dir) }
          : { cwd: "", dir: "missing" };
      expect(paths.cwd, result.stdout).toBe(paths.dir);
      const childCwd = statSync(paths.cwd);
      const expected = statSync(dir);
      expect([childCwd.dev, childCwd.ino]).toEqual([expected.dev, expected.ino]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
