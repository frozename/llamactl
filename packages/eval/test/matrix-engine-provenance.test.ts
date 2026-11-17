/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects/resolves matchers are typed as void. */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildBootCommandForModelSpec,
  buildJsonClassifierWorkload,
  ensureModelServing,
  isExternalOnlyEngine,
  type ModelSpec,
  type ProvenanceReaders,
  runMatrix,
} from "../src/index.js";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

// #521 second slice (RED): gufo/kapitsa lifecycle guards plus per-cell
// provenance recorded through collectEvalProvenance. The matrix_provenance
// table and the runMatrix provenanceReaders option land with the fix; every
// case reads the table through raw SQL so a missing table fails on the
// tableExists assertion, never on a "no such table" throw.

const servers: ReturnType<typeof Bun.serve>[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop(true)));
  servers.length = 0;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-eval-prov-"));
  dirs.push(dir);
  return dir;
}

const FAKE_COMPLETION = '{"label":"yes","memory_related":true,"reason":"x"}';

function startStubServer(): number {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/health") {
        return new Response("ok");
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        return Response.json({
          choices: [{ message: { content: FAKE_COMPLETION } }],
          usage: { completion_tokens: 3 },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return server.port!;
}

async function stoppedServerPort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(): Response {
      return new Response("ok");
    },
  });
  const port = server.port!;
  await server.stop(true);
  return port;
}

function chatCorpusRow(): string {
  return JSON.stringify({
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: JSON.stringify({ label: "yes" }) },
    ],
  });
}

function classifierWorkload(
  name: string,
  corpusPath: string,
): ReturnType<typeof buildJsonClassifierWorkload> {
  return buildJsonClassifierWorkload({
    name,
    corpus_path: corpusPath,
    labelField: "label",
    validLabels: new Set(["yes", "no"]),
  });
}

interface FakeProvenance {
  readers: ProvenanceReaders;
  sha256Paths: string[];
  engineVersionCalls: string[];
}

function fakeReaders(): FakeProvenance {
  const sha256Paths: string[] = [];
  const engineVersionCalls: string[] = [];
  const readers: ProvenanceReaders = {
    sha256File: (path: string): string => {
      sha256Paths.push(path);
      return path.endsWith(".gguf") ? "a".repeat(64) : "b".repeat(64);
    },
    engineVersion: (binaryPath: string): { version: string; commit: string } => {
      engineVersionCalls.push(binaryPath);
      return { version: "9.9.9", commit: "abcdef1" };
    },
    hostname: (): string => "fake-host",
  };
  return { readers, sha256Paths, engineVersionCalls };
}

function managedEngineSpec(engine: "gufo" | "kapitsa", name: string): ModelSpec {
  return {
    name,
    engine,
    managed: true,
    binary: "/opt/x/gufo",
    gguf_path: "/models/x.gguf",
    quant: "Q4",
    family: "t",
    size_params: "1b",
    host: "127.0.0.1",
    port: 8080,
    extra_args: [],
  };
}

function tableExists(db: Database): unknown[] {
  return db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='matrix_provenance'")
    .all();
}

interface ProvenanceRow {
  run_id: string;
  model_name: string;
  provenance_json: string;
}

function provenanceRows(db: Database): ProvenanceRow[] {
  return db
    .query("SELECT run_id, model_name, provenance_json FROM matrix_provenance")
    .all() as ProvenanceRow[];
}

interface ParsedProvenance {
  engine?: string;
  engine_version?: string | null;
  engine_commit?: string | null;
  binary_sha256?: string | null;
  gguf_sha256?: string | null;
  quant?: string | null;
  ctx?: number | null;
  flags?: string[];
  host?: string;
  unavailable?: {
    binary_sha256?: string;
    ctx?: string;
    gguf_sha256?: string;
  };
}

function parseProvenance(provenanceJson: string): ParsedProvenance {
  return JSON.parse(provenanceJson) as ParsedProvenance;
}

async function runModelMatrix(
  model: ModelSpec,
  db: Database,
  runId: string,
): Promise<FakeProvenance> {
  const fake = fakeReaders();
  const dir = tempDir();
  const corpusPath = join(dir, "corpus.jsonl");
  writeFileSync(corpusPath, `${chatCorpusRow()}\n`);
  const opts = {
    models: [model],
    workloads: [classifierWorkload("probe", corpusPath)],
    db,
    runId,
    provenanceReaders: fake.readers,
  };
  await runMatrix(opts);
  return fake;
}

describe("matrix engine provenance (#521)", () => {
  // Kills: deleting the gufo/kapitsa branch in lifecycle.ts buildBootCommandForModelSpec.
  test("buildBootCommandForModelSpec refuses gufo and kapitsa instead of building llama-server argv", () => {
    expect(() => buildBootCommandForModelSpec(managedEngineSpec("gufo", "gufo-managed"))).toThrow(
      /engine gufo is not managed by eval/,
    );
    expect(() =>
      buildBootCommandForModelSpec(managedEngineSpec("kapitsa", "kapitsa-managed")),
    ).toThrow(/engine kapitsa is not managed by eval/);
  });

  // Kills: removing the isExternalOnlyEngine guard in ensureModelServing.
  // Without it, managed:true falls through to buildBootCommandForModelSpec
  // (whose message lacks "is not reachable at") and managed:false falls
  // through to the generic "is not reachable and managed=false" error, so
  // both cases pin the guard-specific message.
  test("ensureModelServing never spawns a gufo/kapitsa binary, even with managed:true", async () => {
    const guardMessage = /is not reachable at .*; run the server externally/;
    const port = await stoppedServerPort();
    const dir = tempDir();
    const marker = join(dir, "spawned");
    const script = join(dir, "fake-engine");
    writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
    chmodSync(script, 0o755);
    const spec: ModelSpec = {
      ...managedEngineSpec("kapitsa", "kapitsa-managed"),
      port,
      binary: script,
    };
    await expect(ensureModelServing(spec)).rejects.toThrow(/engine kapitsa is not managed by eval/);
    await expect(ensureModelServing(spec)).rejects.toThrow(guardMessage);
    expect(existsSync(marker)).toBe(false);

    const unmanaged: ModelSpec = { ...spec, name: "kapitsa-down", managed: false };
    await expect(ensureModelServing(unmanaged)).rejects.toThrow(guardMessage);

    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      await runModelMatrix(unmanaged, new Database(":memory:"), "run-guard-warn");
    } finally {
      warnSpy.mockRestore();
    }
    const bootWarnings = warnings.filter((w) => w.includes("failed to boot kapitsa-down"));
    expect(bootWarnings).toHaveLength(1);
    expect(bootWarnings[0]).toMatch(guardMessage);
    expect(existsSync(marker)).toBe(false);
  });

  test("isExternalOnlyEngine is true only for gufo and kapitsa", () => {
    expect(isExternalOnlyEngine("gufo")).toBe(true);
    expect(isExternalOnlyEngine("kapitsa")).toBe(true);
    expect(isExternalOnlyEngine("llamacpp")).toBe(false);
    expect(isExternalOnlyEngine("omlx")).toBe(false);
  });

  // Kills: scanning start_args/extra_args separately or first-occurrence-wins;
  // dropping the -c or --ctx-size=N forms; changing the non-numeric
  // fall-through or the non-positive terminal null documented on lastCtxSize.
  test.each([
    { start: ["-c", "4096"], extra: ["--ctx-size=8192"], ctx: 8192 },
    { start: ["--ctx-size=8192"], extra: ["-c", "4096"], ctx: 4096 },
    { start: ["--ctx-size", "2048"], extra: ["--jinja", "-c", "16384"], ctx: 16384 },
    { start: ["-c", "4096"], extra: ["-c", "auto"], ctx: 4096 },
    { start: ["-c", "4096"], extra: ["--ctx-size"], ctx: 4096 },
    { start: ["-c", "4096"], extra: ["-c", "0"], ctx: null },
    { start: ["-c", "4096"], extra: ["--ctx-size=0"], ctx: null },
  ])(
    "lastCtxSize: start_args $start + extra_args $extra -> ctx $ctx",
    async ({ start, extra, ctx }) => {
      const port = startStubServer();
      const model: ModelSpec = {
        name: "glm-gufo-ctx",
        engine: "gufo",
        managed: false,
        gguf_path: "/models/glm/Q4_K_M.gguf",
        quant: "Q4_K_M",
        family: "glm",
        size_params: "30b",
        host: "127.0.0.1",
        port,
        start_args: start,
        extra_args: extra,
      };
      const db = new Database(":memory:");
      await runModelMatrix(model, db, "run-ctx");
      const rows = provenanceRows(db);
      expect(rows).toHaveLength(1);
      const prov = parseProvenance(rows[0]!.provenance_json);
      expect(prov.ctx).toBe(ctx);
      expect(prov.flags).toEqual([...start, ...extra]);
    },
  );

  // Kills: the runner skipping the insert; hardcoding engine "llamacpp";
  // dropping flags; dropping the ctx parse.
  test("runMatrix records gufo provenance through collectEvalProvenance with the ModelSpec engine, flags and ctx", async () => {
    const port = startStubServer();
    const model: ModelSpec = {
      name: "glm-gufo",
      engine: "gufo",
      managed: false,
      gguf_path: "/models/glm/Q4_K_M.gguf",
      quant: "Q4_K_M",
      family: "glm",
      size_params: "30b",
      host: "127.0.0.1",
      port,
      start_args: ["--jinja"],
      extra_args: ["--ctx-size", "8192"],
    };
    const db = new Database(":memory:");
    const fake = await runModelMatrix(model, db, "run-prov");

    expect(tableExists(db)).toEqual([{ name: "matrix_provenance" }]);
    const rows = provenanceRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.run_id).toBe("run-prov");
    expect(rows[0]!.model_name).toBe("glm-gufo");
    const prov = parseProvenance(rows[0]!.provenance_json);
    expect(prov.engine).toBe("gufo");
    expect(prov.gguf_sha256).toBe("a".repeat(64));
    expect(prov.quant).toBe("Q4_K_M");
    expect(prov.ctx).toBe(8192);
    expect(prov.flags).toEqual(["--jinja", "--ctx-size", "8192"]);
    expect(prov.host).toBe("fake-host");
    expect(prov.binary_sha256).toBeNull();
    expect(prov.engine_version).toBeNull();
    expect(prov.engine_commit).toBeNull();
    expect(prov.unavailable?.binary_sha256).toBe(
      "ModelSpec glm-gufo declares no engine binary (engine gufo runs outside eval)",
    );
    expect(fake.engineVersionCalls).toEqual([]);
  });

  // Kills: the external-only suffix applied to every engine, not just gufo/kapitsa.
  test("runMatrix records a llamacpp no-binary reason without the external-only suffix", async () => {
    const port = startStubServer();
    const model: ModelSpec = {
      name: "glm-llamacpp-nobin",
      engine: "llamacpp",
      managed: false,
      gguf_path: "/models/glm/Q4_K_M.gguf",
      quant: "Q4_K_M",
      family: "glm",
      size_params: "30b",
      host: "127.0.0.1",
      port,
      extra_args: ["--ctx-size", "4096"],
    };
    const db = new Database(":memory:");
    await runModelMatrix(model, db, "run-llamacpp-nobin");
    const rows = provenanceRows(db);
    expect(rows).toHaveLength(1);
    const prov = parseProvenance(rows[0]!.provenance_json);
    expect(prov.engine).toBe("llamacpp");
    expect(prov.unavailable?.binary_sha256).toBe(
      "ModelSpec glm-llamacpp-nobin declares no engine binary",
    );
  });

  // Kills: collecting provenance only after a successful boot.
  test("kapitsa provenance is recorded even when the externally run server is unreachable", async () => {
    const port = await stoppedServerPort();
    const model: ModelSpec = {
      name: "kapitsa-down",
      engine: "kapitsa",
      managed: false,
      gguf_path: "/models/kapitsa/Q4_K_M.gguf",
      quant: "Q4_K_M",
      family: "kapitsa-fam",
      size_params: "7b",
      host: "127.0.0.1",
      port,
      extra_args: [],
    };
    const db = new Database(":memory:");
    await runModelMatrix(model, db, "run-kapitsa-down");

    expect(tableExists(db)).toEqual([{ name: "matrix_provenance" }]);
    const rows = provenanceRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model_name).toBe("kapitsa-down");
    const prov = parseProvenance(rows[0]!.provenance_json);
    expect(prov.engine).toBe("kapitsa");
    expect(prov.ctx).toBeNull();
    expect(prov.unavailable?.ctx).toMatch(/no --ctx-size/);
    expect(db.query("SELECT errors FROM matrix_runs").all()).toEqual([{ errors: 1 }]);
  });

  // Kills: passing gguf_path for omlx.
  test("omlx provenance never hashes a GGUF", async () => {
    const port = startStubServer();
    const model: ModelSpec = {
      name: "omlx-model",
      engine: "omlx",
      managed: false,
      gguf_path: "/models/x.gguf",
      mlx_model_dir: "/models/mlx/x",
      quant: "Q4",
      family: "t",
      size_params: "1b",
      host: "127.0.0.1",
      port,
      extra_args: [],
    };
    const db = new Database(":memory:");
    const fake = await runModelMatrix(model, db, "run-omlx");

    expect(tableExists(db)).toEqual([{ name: "matrix_provenance" }]);
    const rows = provenanceRows(db);
    expect(rows).toHaveLength(1);
    const prov = parseProvenance(rows[0]!.provenance_json);
    expect(prov.gguf_sha256).toBeNull();
    expect(prov.unavailable?.gguf_sha256).toMatch(/MLX model directory/);
    expect(fake.sha256Paths.some((p) => p.endsWith(".gguf"))).toBe(false);
  });

  // Kills: cli.ts main() not passing defaultProvenanceReaders() to runMatrix.
  test("matrix cli wires default provenance readers", async () => {
    const port = startStubServer();
    const dir = tempDir();
    const modelPath = join(dir, "model.gguf");
    writeFileSync(modelPath, "gguf-bytes");
    const expectedGgufSha256 = createHash("sha256").update("gguf-bytes").digest("hex");
    const modelsPath = join(dir, "models.json");
    writeFileSync(
      modelsPath,
      JSON.stringify([
        {
          name: "cli-gufo",
          engine: "gufo",
          managed: false,
          gguf_path: modelPath,
          quant: "Q4",
          family: "t",
          size_params: "1b",
          host: "127.0.0.1",
          port,
          extra_args: [],
        },
      ]),
    );
    const corpusPath = join(dir, "memory.jsonl");
    writeFileSync(
      corpusPath,
      `${JSON.stringify({
        messages: [
          { role: "user", content: "Is this memory related?" },
          {
            role: "assistant",
            content: JSON.stringify({ memory_related: true, reason: "x" }),
          },
        ],
      })}\n`,
    );
    const outDbPath = join(dir, "out.db");
    const cliPath = join(import.meta.dir, "..", "src", "matrix", "cli.ts");
    const proc = Bun.spawn(
      [
        process.execPath,
        cliPath,
        "--models",
        modelsPath,
        "--workloads",
        "memory-efficacy-binary",
        "--corpus-override",
        `memory-efficacy-binary=${corpusPath}`,
        "--out-db",
        outDbPath,
        "--run-id",
        "cli-run",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/runId=cli-run cellsWritten=1/);

    const outDb = new Database(outDbPath);
    expect(tableExists(outDb)).toEqual([{ name: "matrix_provenance" }]);
    const rows = provenanceRows(outDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model_name).toBe("cli-gufo");
    const prov = parseProvenance(rows[0]!.provenance_json);
    expect(prov.engine).toBe("gufo");
    expect(prov.gguf_sha256).toBe(expectedGgufSha256);
    expect(prov.host).toBe(hostname());
    expect(prov.binary_sha256).toBeNull();
    outDb.close();
  }, 30_000);
});
