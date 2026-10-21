import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  memoryEventsPath,
  parseCgroupV2Path,
  parseMemoryEventsOomKill,
  readCgroupOomSample,
  readOomBaseline,
  writeOomBaseline,
} from "../src/cgroupOom.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

const SERVICE =
  "/user.slice/user-1000.slice/user@1000.service/app.slice/llamactl-controller.service";

// Verbatim memory.events from a cgroup v2 service that has seen two OOM kills.
const MEMORY_EVENTS = `low 0
high 0
max 0
oom 0
oom_kill 2
oom_group_kill 0
sock_throttled 22
`;

describe("parseCgroupV2Path", () => {
  test("reads the unified-hierarchy line of a pure cgroup v2 host", () => {
    expect(parseCgroupV2Path(`0::${SERVICE}\n`)).toBe(SERVICE);
  });

  test("picks the 0:: line out of a hybrid v1/v2 file", () => {
    const hybrid = [
      "12:memory:/user.slice",
      "11:cpu,cpuacct:/user.slice",
      `0::${SERVICE}`,
      "1:name=systemd:/user.slice",
    ].join("\n");
    expect(parseCgroupV2Path(hybrid)).toBe(SERVICE);
  });

  test("returns null for a v1-only file, an empty file and a malformed path", () => {
    expect(parseCgroupV2Path("12:memory:/user.slice\n1:name=systemd:/\n")).toBeNull();
    expect(parseCgroupV2Path("")).toBeNull();
    expect(parseCgroupV2Path("0::relative/path\n")).toBeNull();
  });

  test("keeps the root cgroup as /", () => {
    expect(parseCgroupV2Path("0::/\n")).toBe("/");
  });
});

describe("parseMemoryEventsOomKill", () => {
  test("reads oom_kill, not oom or oom_group_kill", () => {
    expect(parseMemoryEventsOomKill(MEMORY_EVENTS)).toBe(2);
    expect(parseMemoryEventsOomKill("oom 7\noom_group_kill 3\noom_kill 0\n")).toBe(0);
  });

  test("returns null when the field is absent or malformed", () => {
    expect(parseMemoryEventsOomKill("low 0\nhigh 0\n")).toBeNull();
    expect(parseMemoryEventsOomKill("oom_kill -1\n")).toBeNull();
    expect(parseMemoryEventsOomKill("oom_kill two\n")).toBeNull();
    expect(parseMemoryEventsOomKill("")).toBeNull();
  });
});

describe("memoryEventsPath", () => {
  test("joins the cgroup path under the unified mount", () => {
    expect(memoryEventsPath(SERVICE)).toBe(`/sys/fs/cgroup${SERVICE}/memory.events`);
    expect(memoryEventsPath("/a.slice", "/mnt/cg")).toBe("/mnt/cg/a.slice/memory.events");
  });
});

describe("readCgroupOomSample", () => {
  const files =
    (map: Record<string, string>) =>
    (path: string): string => {
      const body = map[path];
      if (body === undefined) throw new Error(`ENOENT: ${path}`);
      return body;
    };

  test("samples the process's own cgroup on Linux", () => {
    const readFile = files({
      "/proc/self/cgroup": `0::${SERVICE}\n`,
      [`/sys/fs/cgroup${SERVICE}/memory.events`]: MEMORY_EVENTS,
    });
    expect(readCgroupOomSample({ platform: "linux", readFile })).toEqual({
      cgroup: SERVICE,
      oomKill: 2,
    });
  });

  test("is a no-op off Linux", () => {
    const readFile = (): string => {
      throw new Error("must not read");
    };
    expect(readCgroupOomSample({ platform: "darwin", readFile })).toBeNull();
  });

  test("never throws when the files are missing", () => {
    expect(readCgroupOomSample({ platform: "linux", readFile: files({}) })).toBeNull();
    const noEvents = files({ "/proc/self/cgroup": `0::${SERVICE}\n` });
    expect(readCgroupOomSample({ platform: "linux", readFile: noEvents })).toBeNull();
  });
});

describe("OOM baseline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llamactl-oom-baseline-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips a sample", () => {
    const file = join(dir, ".controller-oom.json");
    writeOomBaseline(file, { cgroup: SERVICE, oomKill: 3 });
    expect(readOomBaseline(file)).toEqual({ cgroup: SERVICE, oomKill: 3 });
  });

  test("reads a missing or malformed baseline as null", () => {
    const file = join(dir, ".controller-oom.json");
    expect(readOomBaseline(file)).toBeNull();
    writeFileSync(file, '{"cgroup":1,"oomKill":"x"}');
    expect(readOomBaseline(file)).toBeNull();
    writeFileSync(file, "{not json");
    expect(readOomBaseline(file)).toBeNull();
  });

  test("swallows a write failure", () => {
    expect(() => {
      writeOomBaseline(join(dir, "missing-parent", "\0bad"), { cgroup: SERVICE, oomKill: 1 });
    }).not.toThrow();
  });
});
