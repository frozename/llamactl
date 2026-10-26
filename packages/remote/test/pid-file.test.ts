import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { parsePidLine, pidAlive, readPid } from "./pid-file.js";

let tmp = "";
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-pid-file-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A read that returns `results` in order (an Error entry is thrown) and then repeats the last one. */
function scriptedRead(results: (string | Error)[]): {
  read: (path: string) => string;
  calls: () => number;
} {
  let calls = 0;
  return {
    read: (): string => {
      const r = results[Math.min(calls, results.length - 1)];
      calls++;
      if (r === undefined) {
        throw new Error("scriptedRead: no results");
      }
      if (r instanceof Error) {
        throw r;
      }
      return r;
    },
    calls: (): number => calls,
  };
}

/** A sleep that only counts its calls and runs `onSleep` on each one. */
function countingSleep(onSleep: () => void = () => undefined): {
  sleep: (ms: number) => Promise<void>;
  count: () => number;
} {
  let count = 0;
  return {
    sleep: async (): Promise<void> => {
      count++;
      onSleep();
      await Promise.resolve();
    },
    count: (): number => count,
  };
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject");
}

describe("pidAlive", () => {
  test("throws on pid 0, a negative pid and non-integers instead of probing", () => {
    for (const pid of [0, -1, Number.NaN, 1.5]) {
      expect(() => pidAlive(pid)).toThrow("expected a positive integer");
    }
  });

  test("reports the current process as alive", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });
});

describe("parsePidLine", () => {
  test("returns the pid of a complete line", () => {
    expect(parsePidLine("4242\n")).toBe(4242);
  });

  test("throws on an empty, partial, zero or padded line", () => {
    for (const text of ["", "42", "0\n", "4242\n\n", " 42\n", "abc\n"]) {
      expect(() => parsePidLine(text)).toThrow("complete positive pid line");
    }
  });
});

describe("readPid", () => {
  test("waits past empty and partial reads for the full line", async () => {
    const read = scriptedRead(["", "42", "4242\n"]);
    const sleep = countingSleep();
    expect(await readPid("/pid", { read: read.read, sleep: sleep.sleep })).toBe(4242);
    expect(sleep.count()).toBe(2);
    expect(read.calls()).toBe(3);
  });

  test("treats a read that throws as not written yet", async () => {
    const read = scriptedRead([new Error("ENOENT: no such file"), "4242\n"]);
    const sleep = countingSleep();
    expect(await readPid("/pid", { read: read.read, sleep: sleep.sleep })).toBe(4242);
    expect(sleep.count()).toBe(1);
  });

  test("fails closed at once on a complete line holding pid 0", async () => {
    const read = scriptedRead(["0\n"]);
    const sleep = countingSleep();
    const err = await rejection(readPid("/pid", { read: read.read, sleep: sleep.sleep }));
    expect(err.message).toContain("complete positive pid line");
    expect(sleep.count()).toBe(0);
  });

  test("gives up after ceil(timeoutMs / intervalMs) reads and names the file", async () => {
    const read = scriptedRead([""]);
    const sleep = countingSleep();
    const err = await rejection(
      readPid("/pid", { read: read.read, sleep: sleep.sleep, timeoutMs: 30, intervalMs: 10 }),
    );
    expect(err.message).toContain("/pid has no complete pid line after 3 reads");
    expect(err.message).toContain('(last: "")');
    expect(sleep.count()).toBe(2);
    expect(read.calls()).toBe(3);
  });

  test("real file: the truncate-before-echo window reads as pid 0 the old way; readPid waits for the line", async () => {
    const pidFile = join(tmp, "pid");
    // The state right after the shell's `>` truncated the file and before `echo` wrote the pid.
    writeFileSync(pidFile, "");
    // The old exists-then-read pattern accepts this file and gets pid 0.
    expect(existsSync(pidFile)).toBe(true);
    expect(Number(readFileSync(pidFile, "utf8").trim())).toBe(0);
    const sleep = countingSleep(() => {
      writeFileSync(pidFile, `${String(process.pid)}\n`);
    });
    expect(await readPid(pidFile, { sleep: sleep.sleep })).toBe(process.pid);
    expect(sleep.count()).toBe(1);
  });

  test("the cli adapter and router tests read pid files only through this module", () => {
    for (const name of ["cli-adapter-context.test.ts", "chat-p02-router.test.ts"]) {
      const src = readFileSync(join(import.meta.dir, name), "utf8");
      expect(src).not.toContain("Number(readFileSync(pidFile");
      expect(src).not.toContain("function pidAlive(");
      expect(src).toContain('from "./pid-file.js"');
    }
  });
});
