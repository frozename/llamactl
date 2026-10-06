import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import {
  isRecordedPidAlive,
  isRecordedPidGone,
  parseEtimeSeconds,
  PID_START_SLACK_MS,
  signalRecordedPid,
  verifyPidFile,
  verifyRecordedPid,
} from "../src/pidIdentity.js";
import { mkdirSync, utimesSync, writeFileSync } from "../src/safe-fs.js";
import { makeTempRuntime } from "./helpers.js";

const noopProbe = (): void => undefined;

describe("parseEtimeSeconds", () => {
  test("parses ps etime shapes", () => {
    expect(parseEtimeSeconds("04-12:20:59")).toBe(390059);
    expect(parseEtimeSeconds("01:02:03")).toBe(3723);
    expect(parseEtimeSeconds("12:34")).toBe(754);
    expect(parseEtimeSeconds("  00:05\n")).toBe(5);
    expect(parseEtimeSeconds("garbage")).toBeNull();
    expect(parseEtimeSeconds("12:99")).toBeNull();
  });
});

describe("verifyRecordedPid", () => {
  test("dead when the liveness probe throws ESRCH", () => {
    const err = Object.assign(new Error("no such process"), { code: "ESRCH" });
    const verdict = verifyRecordedPid(4242, Date.now(), {
      probe: () => {
        throw err;
      },
    });
    expect(verdict).toBe("dead");
  });

  test("reused when the liveness probe throws EPERM", () => {
    // EPERM means the pid exists but belongs to another user — it cannot be a
    // process we spawned. That is "not ours" (reused), never "dead" evidence:
    // the record may be reaped, but the pid is never signalled.
    const err = Object.assign(new Error("not permitted"), { code: "EPERM" });
    const verdict = verifyRecordedPid(4242, Date.now(), {
      probe: () => {
        throw err;
      },
    });
    expect(verdict).toBe("reused");
  });

  test("unknown when the liveness probe fails for an unrecognized reason", () => {
    const verdict = verifyRecordedPid(4242, Date.now(), {
      probe: () => {
        throw new Error("transient probe failure");
      },
    });
    expect(verdict).toBe("unknown");
  });

  test("alive when the process started no later than record + slack", () => {
    const record = 1_000_000;
    expect(
      verifyRecordedPid(4242, record, {
        probe: noopProbe,
        processStartMs: () => record - 500,
      }),
    ).toBe("alive");
    expect(
      verifyRecordedPid(4242, record, {
        probe: noopProbe,
        processStartMs: () => record + PID_START_SLACK_MS,
      }),
    ).toBe("alive");
  });

  test("reused when the process started after record + slack", () => {
    const record = 1_000_000;
    expect(
      verifyRecordedPid(4242, record, {
        probe: noopProbe,
        processStartMs: () => record + PID_START_SLACK_MS + 1,
      }),
    ).toBe("reused");
  });

  test("unknown when the process start cannot be resolved", () => {
    expect(
      verifyRecordedPid(4242, Date.now(), {
        probe: noopProbe,
        processStartMs: () => null,
      }),
    ).toBe("unknown");
  });

  test("unknown when there is no record timestamp", () => {
    expect(
      verifyRecordedPid(4242, null, {
        probe: noopProbe,
        processStartMs: () => Date.now(),
      }),
    ).toBe("unknown");
  });
});

describe("verifyPidFile", () => {
  test("uses the record file mtime as the identity anchor", () => {
    const temp = makeTempRuntime();
    try {
      mkdirSync(temp.runtimeDir, { recursive: true });
      const recordPath = join(temp.runtimeDir, "x.pid");
      writeFileSync(recordPath, "4242\n");
      const now = Date.now();
      const deps = { probe: noopProbe, processStartMs: (): number => now };
      expect(verifyPidFile(recordPath, 4242, deps)).toBe("alive");
      // Backdate the record an hour: a process that started now cannot be the
      // one the record was written for — the pid was recycled.
      const hourAgo = new Date(now - 3_600_000);
      utimesSync(recordPath, hourAgo, hourAgo);
      expect(verifyPidFile(recordPath, 4242, deps)).toBe("reused");
    } finally {
      temp.cleanup();
    }
  });

  test("missing record file is unknown for a live pid", () => {
    const temp = makeTempRuntime();
    try {
      const recordPath = join(temp.runtimeDir, "missing.pid");
      expect(verifyPidFile(recordPath, 4242, { probe: noopProbe })).toBe("unknown");
    } finally {
      temp.cleanup();
    }
  });
});

describe("isRecordedPidAlive / isRecordedPidGone", () => {
  test("only the alive verdict counts as alive", () => {
    const temp = makeTempRuntime();
    try {
      mkdirSync(temp.runtimeDir, { recursive: true });
      const recordPath = join(temp.runtimeDir, "x.pid");
      writeFileSync(recordPath, "4242\n");
      const aliveDeps = {
        probe: noopProbe,
        processStartMs: (): number => Date.now() - 1000,
      };
      const unknownDeps = { probe: noopProbe, processStartMs: (): null => null };
      expect(isRecordedPidAlive(recordPath, 4242, aliveDeps)).toBe(true);
      expect(isRecordedPidAlive(recordPath, 4242, unknownDeps)).toBe(false);
    } finally {
      temp.cleanup();
    }
  });

  test("gone means dead or reused — never unknown", () => {
    expect(isRecordedPidGone("dead")).toBe(true);
    expect(isRecordedPidGone("reused")).toBe(true);
    expect(isRecordedPidGone("alive")).toBe(false);
    expect(isRecordedPidGone("unknown")).toBe(false);
  });
});

describe("command-line corroboration", () => {
  const record = 1_000_000;
  const liveDeps = { probe: noopProbe, processStartMs: (): number => record };

  test("reused when argv0's basename is not the expected binary", () => {
    // A fresh record defeats the start-time check; the command line is the
    // only evidence left that this pid is not the recorded server.
    expect(
      verifyRecordedPid(4242, record, {
        ...liveDeps,
        processCommand: () => "/bin/sleep 60",
        expectCommand: { binary: "llama-server" },
      }),
    ).toBe("reused");
  });

  test("reused when the binary matches but a required arg is absent", () => {
    expect(
      verifyRecordedPid(4242, record, {
        ...liveDeps,
        processCommand: () =>
          "/opt/llama/bin/llama-server -m /models/other/elsewhere.gguf --port 8080",
        expectCommand: { binary: "llama-server", args: ["probe/model.gguf"] },
      }),
    ).toBe("reused");
  });

  test("required args match absolute path tokens by suffix", () => {
    expect(
      verifyRecordedPid(4242, record, {
        ...liveDeps,
        processCommand: () => "/opt/llama/bin/llama-server -m /models/probe/model.gguf --port 8080",
        expectCommand: { binary: "llama-server", args: ["probe/model.gguf"] },
      }),
    ).toBe("alive");
  });

  test("a bare executable-name argv0 matches a bare binary expectation", () => {
    expect(
      verifyRecordedPid(4242, record, {
        ...liveDeps,
        processCommand: () => "rpc-server --port 19050",
        expectCommand: { binary: "rpc-server" },
      }),
    ).toBe("alive");
  });

  test("args do not substring-match inside a longer token", () => {
    // "a.gguf" must not match the token "xa.gguf" — containment is checked at
    // token boundaries (exact token or path-suffix), not raw substring.
    expect(
      verifyRecordedPid(4242, record, {
        ...liveDeps,
        processCommand: () => "/opt/bin/llama-server -m /models/xa.gguf",
        expectCommand: { binary: "llama-server", args: ["a.gguf"] },
      }),
    ).toBe("reused");
  });

  test("unknown when the command line cannot be read", () => {
    expect(
      verifyRecordedPid(4242, record, {
        ...liveDeps,
        processCommand: () => null,
        expectCommand: { binary: "llama-server" },
      }),
    ).toBe("unknown");
  });
});

describe("signalRecordedPid", () => {
  test("signals only a verified pid and reports whether the signal went out", () => {
    const temp = makeTempRuntime();
    const spy = spyOn(process, "kill").mockImplementation(() => true);
    try {
      mkdirSync(temp.runtimeDir, { recursive: true });
      const recordPath = join(temp.runtimeDir, "x.pid");
      writeFileSync(recordPath, "4242\n");
      const aliveDeps = {
        probe: noopProbe,
        processStartMs: (): number => Date.now() - 1000,
      };
      expect(signalRecordedPid(recordPath, 4242, "SIGTERM", aliveDeps)).toBe(true);
      expect(spy).toHaveBeenCalledWith(4242, "SIGTERM");
    } finally {
      spy.mockRestore();
      temp.cleanup();
    }
  });

  test("never signals a reused or unknown record", () => {
    const temp = makeTempRuntime();
    const spy = spyOn(process, "kill").mockImplementation(() => true);
    try {
      mkdirSync(temp.runtimeDir, { recursive: true });
      const recordPath = join(temp.runtimeDir, "x.pid");
      writeFileSync(recordPath, "4242\n");
      const hourAgo = new Date(Date.now() - 3_600_000);
      utimesSync(recordPath, hourAgo, hourAgo);
      const reused = signalRecordedPid(recordPath, 4242, "SIGTERM", {
        probe: noopProbe,
        processStartMs: () => Date.now(),
      });
      const unknown = signalRecordedPid(recordPath, 4242, "SIGKILL", {
        probe: noopProbe,
        processStartMs: () => null,
      });
      expect(reused).toBe(false);
      expect(unknown).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      temp.cleanup();
    }
  });
});
