import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as Prov from "../../src/perf/provenance.js";

import { mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

/**
 * RED pins for #521 (provenance slice): `src/perf/provenance.ts` does not
 * exist yet, so every case loads it through a guarded dynamic import — a
 * missing module resolves to an empty namespace and the load() assertion
 * fails, never the file load. `src/perf/provenance.d.ts` is a type-only
 * stub that keeps `import type` + tsc happy until the fix lands the real
 * module (a `.ts` shadows the stub for `.js` specifiers).
 */

const FIELDS = [
  "engine_version",
  "engine_commit",
  "binary_sha256",
  "gguf_sha256",
  "hf_revision",
  "quant",
  "ctx",
] as const;

type CollectEvalProvenance = typeof Prov.collectEvalProvenance;
type ProvenanceInput = Parameters<CollectEvalProvenance>[0];
type ProvenanceReaders = NonNullable<Parameters<CollectEvalProvenance>[1]>;
type CollectedProvenance = Awaited<ReturnType<CollectEvalProvenance>>;

const REVISION = "0123456789abcdef0123456789abcdef0123456789";
const BINARY = "/opt/gufo/bin/gufo";
const GGUF_SNAPSHOT = `/hf/models--org--repo/snapshots/${REVISION}/m-Q4_K_M.gguf`;
const GGUF_PLAIN = "/models/m.gguf";
const BINARY_DIGEST = "a".repeat(64);
const GGUF_DIGEST = "b".repeat(64);

const BASE_INPUT: ProvenanceInput = {
  engine: "gufo",
  binary_path: BINARY,
  gguf_path: GGUF_SNAPSHOT,
  quant: "Q4_K_M",
  ctx: 32768,
  flags: ["--slots", "2"],
};

const collectedOutputs: CollectedProvenance[] = [];

async function load(): Promise<typeof Prov> {
  const m: unknown = await import("../../src/perf/provenance.js").catch(() => ({}));
  expect(typeof (m as Record<string, unknown>)["collectEvalProvenance"]).toBe("function");
  return m as typeof Prov;
}

interface RecordedCalls {
  sha256File: string[];
  engineVersion: string[];
  hostname: number;
}

interface FakeReadersOptions {
  digests?: Record<string, string>;
  errors?: Record<string, Error>;
  engineVersionResult?: { version: string | null; commit: string | null };
}

function makeReaders(overrides: FakeReadersOptions = {}): {
  readers: ProvenanceReaders;
  calls: RecordedCalls;
} {
  const calls: RecordedCalls = { sha256File: [], engineVersion: [], hostname: 0 };
  const readers: ProvenanceReaders = {
    sha256File: (path: string): string => {
      calls.sha256File.push(path);
      const failure = overrides.errors?.[path];
      if (failure !== undefined) throw failure;
      const digest = overrides.digests?.[path];
      if (digest === undefined) throw new Error(`no fake digest for ${path}`);
      return digest;
    },
    engineVersion: (binary: string): { version: string | null; commit: string | null } => {
      calls.engineVersion.push(binary);
      return (
        overrides.engineVersionResult ?? {
          version: "9.9.9-test",
          commit: "0123456789abcdef0123456789abcdef01234567",
        }
      );
    },
    hostname: (): string => {
      calls.hostname += 1;
      return "test-host";
    },
  };
  return { readers, calls };
}

function unavailableReason(p: CollectedProvenance, field: string): string {
  const reason: unknown = p.unavailable[field];
  expect(typeof reason).toBe("string");
  if (typeof reason !== "string") return "";
  expect(reason.trim()).not.toBe("");
  return reason;
}

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-provenance-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("collectEvalProvenance", () => {
  test("collects every field from input and readers, copying flags", async () => {
    const mod = await load();
    const { readers, calls } = makeReaders({
      digests: { [BINARY]: BINARY_DIGEST, [GGUF_SNAPSHOT]: GGUF_DIGEST },
    });
    const input: ProvenanceInput = { ...BASE_INPUT };

    const p = await mod.collectEvalProvenance(input, readers);
    collectedOutputs.push(p);

    expect(p.engine).toBe("gufo");
    expect(p.engine_version).toBe("9.9.9-test");
    expect(p.engine_commit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(p.binary_sha256).toBe(BINARY_DIGEST);
    expect(p.gguf_sha256).toBe(GGUF_DIGEST);
    expect(p.hf_revision).toBe(REVISION);
    expect(p.quant).toBe("Q4_K_M");
    expect(p.ctx).toBe(32768);
    expect(p.flags).toEqual(["--slots", "2"]);
    expect(p.flags).not.toBe(input.flags);
    expect(p.host).toBe("test-host");
    expect(p.unavailable).toEqual({});
    expect(calls.engineVersion).toEqual([BINARY]);
    expect([...calls.sha256File].sort()).toEqual([BINARY, GGUF_SNAPSHOT].sort());
    expect(calls.hostname).toBe(1);
  });

  test("marks binary-derived fields unavailable with the caller reason when binary_path is absent", async () => {
    const mod = await load();
    const { readers, calls } = makeReaders({
      digests: { [GGUF_SNAPSHOT]: GGUF_DIGEST },
    });
    const input: ProvenanceInput = {
      engine: "gufo",
      gguf_path: GGUF_SNAPSHOT,
      quant: "Q4_K_M",
      ctx: 32768,
      reasons: { binary_path: "agent gateway hides the binary" },
    };

    const p = await mod.collectEvalProvenance(input, readers);
    collectedOutputs.push(p);

    expect(p.binary_sha256).toBeNull();
    expect(p.engine_version).toBeNull();
    expect(p.engine_commit).toBeNull();
    for (const field of ["binary_sha256", "engine_version", "engine_commit"] as const) {
      expect(unavailableReason(p, field)).toContain("agent gateway hides the binary");
    }
    expect(calls.sha256File).toEqual([GGUF_SNAPSHOT]);
    expect(calls.engineVersion).toEqual([]);
  });

  test("a throwing sha256 reader records unavailable instead of aborting the run", async () => {
    const mod = await load();
    const { readers } = makeReaders({
      digests: { [BINARY]: BINARY_DIGEST },
      errors: { [GGUF_SNAPSHOT]: new Error("ENOENT: no such file") },
    });

    const p = await mod.collectEvalProvenance({ ...BASE_INPUT }, readers);
    collectedOutputs.push(p);

    expect(p.binary_sha256).toBe(BINARY_DIGEST);
    expect(p.gguf_sha256).toBeNull();
    expect(unavailableReason(p, "gguf_sha256")).toContain("ENOENT");
  });

  test("rejects a sha256 reader result that is not a 64-hex digest", async () => {
    const mod = await load();
    const { readers } = makeReaders({
      digests: { [BINARY]: BINARY_DIGEST, [GGUF_SNAPSHOT]: "not-a-digest" },
    });

    const p = await mod.collectEvalProvenance({ ...BASE_INPUT }, readers);
    collectedOutputs.push(p);

    expect(p.gguf_sha256).toBeNull();
    unavailableReason(p, "gguf_sha256");
  });

  test("keeps engine_version when engine_commit cannot be determined", async () => {
    const mod = await load();
    const { readers } = makeReaders({
      digests: { [BINARY]: BINARY_DIGEST, [GGUF_SNAPSHOT]: GGUF_DIGEST },
      engineVersionResult: { version: "4567", commit: null },
    });

    const p = await mod.collectEvalProvenance({ ...BASE_INPUT }, readers);
    collectedOutputs.push(p);

    expect(p.engine_version).toBe("4567");
    expect(p.engine_commit).toBeNull();
    unavailableReason(p, "engine_commit");
    expect("engine_version" in p.unavailable).toBe(false);
  });

  test("blank quant and non-positive ctx record unavailable with reasons, never guesses", async () => {
    const mod = await load();
    const digests = { [BINARY]: BINARY_DIGEST, [GGUF_SNAPSHOT]: GGUF_DIGEST };

    for (const quant of [null, "   "] as const) {
      const { readers } = makeReaders({ digests });
      const p = await mod.collectEvalProvenance({ ...BASE_INPUT, quant }, readers);
      collectedOutputs.push(p);
      expect(p.quant).toBeNull();
      unavailableReason(p, "quant");
    }
    for (const ctx of [null, 0, -1, NaN] as const) {
      const { readers } = makeReaders({ digests });
      const p = await mod.collectEvalProvenance({ ...BASE_INPUT, ctx }, readers);
      collectedOutputs.push(p);
      expect(p.ctx).toBeNull();
      unavailableReason(p, "ctx");
    }
  });
});

describe("hf_revision precedence", () => {
  test("an explicit input hf_revision wins over the snapshot path", async () => {
    const mod = await load();
    const { readers } = makeReaders({ digests: { [GGUF_SNAPSHOT]: GGUF_DIGEST } });
    const input: ProvenanceInput = { ...BASE_INPUT, hf_revision: "abc" };

    const p = await mod.collectEvalProvenance(input, readers);
    collectedOutputs.push(p);

    expect(p.hf_revision).toBe("abc");
  });

  test("a snapshot gguf_path yields its revision with no unavailable entry", async () => {
    const mod = await load();
    const { readers } = makeReaders({
      digests: { [BINARY]: BINARY_DIGEST, [GGUF_SNAPSHOT]: GGUF_DIGEST },
    });

    const p = await mod.collectEvalProvenance({ ...BASE_INPUT }, readers);
    collectedOutputs.push(p);

    expect(p.hf_revision).toBe(REVISION);
    expect("hf_revision" in p.unavailable).toBe(false);
  });

  test("a caller reason beats the default for a non-snapshot gguf_path", async () => {
    const mod = await load();
    const { readers } = makeReaders({ digests: { [GGUF_PLAIN]: GGUF_DIGEST } });
    const input: ProvenanceInput = {
      ...BASE_INPUT,
      gguf_path: GGUF_PLAIN,
      reasons: { hf_revision: "caller says X" },
    };

    const p = await mod.collectEvalProvenance(input, readers);
    collectedOutputs.push(p);

    expect(p.hf_revision).toBeNull();
    expect(unavailableReason(p, "hf_revision")).toContain("caller says X");
  });

  test("a non-snapshot gguf_path without a caller reason mentions snapshots", async () => {
    const mod = await load();
    const { readers } = makeReaders({ digests: { [GGUF_PLAIN]: GGUF_DIGEST } });
    const input: ProvenanceInput = { ...BASE_INPUT, gguf_path: GGUF_PLAIN };

    const p = await mod.collectEvalProvenance(input, readers);
    collectedOutputs.push(p);

    expect(p.hf_revision).toBeNull();
    expect(unavailableReason(p, "hf_revision")).toMatch(/snapshot/i);
  });

  test("no gguf_path and no caller reason produces a gguf-related reason", async () => {
    const mod = await load();
    const { readers } = makeReaders({ digests: { [BINARY]: BINARY_DIGEST } });
    const input: ProvenanceInput = { engine: "gufo", binary_path: BINARY };

    const p = await mod.collectEvalProvenance(input, readers);
    collectedOutputs.push(p);

    expect(p.hf_revision).toBeNull();
    expect(unavailableReason(p, "hf_revision")).toMatch(/gguf/i);
  });
});

describe("provenance invariants", () => {
  test("every null field has a non-blank unavailable reason and every ok field has none", async () => {
    await load();

    for (const p of collectedOutputs) {
      for (const field of FIELDS) {
        const value: unknown = p[field];
        const reason: unknown = p.unavailable[field];
        const hasReason = typeof reason === "string" && reason.trim() !== "";
        expect(value === null).toBe(hasReason);
      }
    }

    const t = (await import("../../src/matrix/types.js")) as Record<string, unknown>;
    expect(t["PROVENANCE_UNAVAILABLE_FIELDS"]).toEqual([...FIELDS]);
  });
});

describe("parseEngineVersionOutput", () => {
  test("extracts version and commit from engine --version output", async () => {
    const mod = await load();

    expect(
      mod.parseEngineVersionOutput("version: 4567 (1a2b3c4d)\nbuilt with Apple clang for arm64"),
    ).toEqual({ version: "4567", commit: "1a2b3c4d" });
    expect(mod.parseEngineVersionOutput("garbage")).toEqual({
      version: null,
      commit: null,
    });
    expect(mod.parseEngineVersionOutput("1.4.3")).toEqual({ version: null, commit: null });
  });
});

describe("hfRevisionFromPath", () => {
  test("extracts the HF cache snapshot revision and rejects plain paths", async () => {
    const mod = await load();

    expect(mod.hfRevisionFromPath(GGUF_SNAPSHOT)).toBe(REVISION);
    expect(mod.hfRevisionFromPath(GGUF_PLAIN)).toBeNull();
  });
});

describe("defaultProvenanceReaders", () => {
  test("hashes files, parses injected --version output, and surfaces spawn errors", async () => {
    const mod = await load();
    const helloPath = join(tmp, "hello.txt");
    writeFileSync(helloPath, "hello\n", "utf8");

    const readers = mod.defaultProvenanceReaders();
    expect(await readers.sha256File(helloPath)).toBe(
      "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    );

    const argvCalls: string[][] = [];
    const spawned = mod.defaultProvenanceReaders({
      spawnVersion: (argv) => {
        argvCalls.push([...argv]);
        return Promise.resolve({ stdout: "version: 4567 (1a2b3c4d)\n", stderr: "", exitCode: 0 });
      },
    });
    expect(await spawned.engineVersion("/x/engine")).toEqual({
      version: "4567",
      commit: "1a2b3c4d",
    });
    expect(argvCalls).toEqual([["/x/engine", "--version"]]);

    const denied = mod.defaultProvenanceReaders({
      spawnVersion: () => Promise.reject(new Error("EACCES")),
    });
    let versionInfo: unknown = "rejected";
    try {
      versionInfo = await denied.engineVersion("/x/engine");
    } catch {
      versionInfo = "rejected";
    }
    if (versionInfo !== "rejected") {
      expect(versionInfo).toEqual({ version: null, commit: null });
    }

    const p = await mod.collectEvalProvenance({ ...BASE_INPUT }, denied);
    collectedOutputs.push(p);
    expect(p.engine_version).toBeNull();
    expect(unavailableReason(p, "engine_version")).toContain("EACCES");

    expect(await readers.engineVersion(process.execPath)).toEqual({
      version: null,
      commit: null,
    });
  });
});
