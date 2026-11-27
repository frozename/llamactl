// Pins frozename/llamactl#905, the bullet #895 left open: the agent footprint
// read must reach `bun:ffi` lazily. Importing process-memory must not load it,
// building the default reader must not load it on any platform, and on macOS it
// must load on the first read only, with dlopen running exactly once.
//
// Each scenario runs in its own `bun test` child so the module registry starts
// fresh and the bun:ffi mock below can never leak into the real-FFI read in
// agent-process-memory.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

const MODULE_PATH = join(import.meta.dir, "..", "src", "server", "process-memory.ts");
const PROBE_MARKER = "__FFI_LAZY_PROBE__";
const DARWIN_LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
const MiB = 1024 * 1024;

type ProbeScenario = "import-only" | "non-darwin" | "darwin";

type ProbeFootprint = {
  status: string;
  bytes: number | null;
  source: string;
};

type ProbeState = {
  ffiLoads: number;
  dlopenPaths: string[];
  steps: Record<string, number>;
  footprints: ProbeFootprint[];
};

function scenarioBody(scenario: ProbeScenario): string {
  if (scenario === "import-only") {
    return "";
  }
  if (scenario === "non-darwin") {
    return `
  for (const p of ["linux", "win32", "freebsd"]) {
    withPlatform(p, () => {
      const read = mod.defaultProcessMemoryReader();
      step(p + ":constructed");
      state.footprints.push(read().footprint);
      state.footprints.push(read().footprint);
      step(p + ":read");
    });
  }
`;
  }
  return `
  const read = withPlatform("darwin", () => mod.defaultProcessMemoryReader());
  step("darwin:constructed");
  state.footprints.push(read().footprint);
  step("darwin:firstRead");
  state.footprints.push(read().footprint);
  step("darwin:secondRead");
`;
}

function fixtureSource(scenario: ProbeScenario): string {
  return `import { mock, test } from "bun:test";

const state = { ffiLoads: 0, dlopenPaths: [], steps: {}, footprints: [] };

// The factory counts bun:ffi module loads; the fake dlopen records the path it
// was asked for and fills a rusage_info_v0-shaped buffer, which keeps the macOS
// leg hermetic on Linux CI too.
mock.module("bun:ffi", () => {
  state.ffiLoads += 1;
  return {
    FFIType: { i32: "i32", ptr: "ptr" },
    dlopen(path) {
      state.dlopenPaths.push(path);
      return {
        symbols: {
          proc_pid_rusage(pid, flavor, buffer) {
            const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
            view.setBigUint64(64, BigInt(300 * 1024 * 1024), true);
            view.setBigUint64(72, BigInt(180 * 1024 * 1024), true);
            return 0;
          },
        },
      };
    },
  };
});

function withPlatform(p, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: p, configurable: true });
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.platform;
    } else {
      Object.defineProperty(process, "platform", original);
    }
  }
}

function step(name) {
  state.steps[name] = state.ffiLoads;
}

test("ffi lazy probe", async () => {
  const mod = await import(${JSON.stringify(MODULE_PATH)});
  step("afterImport");
${scenarioBody(scenario)}
  console.log("${PROBE_MARKER}" + JSON.stringify(state));
});
`;
}

function parseProbeState(payload: string): ProbeState | null {
  try {
    return JSON.parse(payload) as ProbeState;
  } catch {
    return null;
  }
}

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "llamactl-ffi-lazy-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function runProbe(scenario: ProbeScenario): Promise<ProbeState> {
  // The fixture name deliberately does not match *.test.ts, so the repo's own
  // test runs never pick it up; `bun test <absolute path>` still runs it.
  const file = join(dir, `${scenario}-probe.ts`);
  writeFileSync(file, fixtureSource(scenario));

  const child = Bun.spawn([process.execPath, "test", file], {
    cwd: dir,
    env: { PATH: process.env["PATH"] ?? "", HOME: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  const probeLine = `${stdout}\n${stderr}`.split("\n").find((line) => line.includes(PROBE_MARKER));
  const line = probeLine ?? "";
  const state = parseProbeState(line.slice(line.indexOf(PROBE_MARKER) + PROBE_MARKER.length));
  expect({ code, probed: state !== null }).toEqual({ code: 0, probed: true });
  if (state === null) {
    throw new Error(`ffi lazy probe emitted no payload:\n${stdout}\n${stderr}`);
  }
  return state;
}

describe("defaultProcessMemoryReader loads bun:ffi lazily", () => {
  test("importing process-memory does not load bun:ffi", async () => {
    const state = await runProbe("import-only");

    expect(state.steps).toEqual({ afterImport: 0 });
    expect(state.ffiLoads).toBe(0);
    expect(state.dlopenPaths).toEqual([]);
  });

  // The linux footprint is a real procfs read, unavailable off Linux, so only
  // win32 and freebsd (footprints 2..5) get a status assertion here.
  test("building and reading on linux, win32 or freebsd never loads bun:ffi", async () => {
    const state = await runProbe("non-darwin");

    for (const name of [
      "afterImport",
      "linux:constructed",
      "linux:read",
      "win32:constructed",
      "win32:read",
      "freebsd:constructed",
      "freebsd:read",
    ]) {
      expect(state.steps[name]).toBe(0);
    }
    expect(state.ffiLoads).toBe(0);
    expect(state.dlopenPaths).toEqual([]);
    expect(state.footprints.slice(2).map((footprint) => footprint.status)).toEqual([
      "unsupported",
      "unsupported",
      "unsupported",
      "unsupported",
    ]);
  });

  test("on darwin bun:ffi loads on the first read, not at construction, and dlopen runs once", async () => {
    const state = await runProbe("darwin");

    expect(state.steps).toEqual({
      afterImport: 0,
      "darwin:constructed": 0,
      "darwin:firstRead": 1,
      "darwin:secondRead": 1,
    });
    expect(state.dlopenPaths).toEqual([DARWIN_LIBSYSTEM]);
    expect(state.footprints).toEqual([
      {
        status: "ok",
        bytes: 180 * MiB,
        source: "darwin:proc_pid_rusage ri_phys_footprint",
      },
      {
        status: "ok",
        bytes: 180 * MiB,
        source: "darwin:proc_pid_rusage ri_phys_footprint",
      },
    ]);
  });
});
