// #521: matrix provenance records undeclared launch flags as unavailable for engines eval does not launch.
import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";

import {
  buildJsonClassifierWorkload,
  listCellRows,
  listMatrixProvenance,
  type ModelSpec,
  type ProvenanceReaders,
  renderMarkdownReport,
  runMatrix,
} from "../src/index.js";

type MatrixProvenance = ReturnType<typeof listMatrixProvenance>[number]["provenance"];

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

function probeWorkload(): ReturnType<typeof buildJsonClassifierWorkload> {
  return buildJsonClassifierWorkload({
    name: "probe",
    corpus_path: "/nonexistent/llamactl-521/corpus.jsonl",
    labelField: "label",
    validLabels: new Set(["yes", "no"]),
  });
}

function fakeProvenanceReaders(): ProvenanceReaders {
  return {
    sha256File: (): string => "a".repeat(64),
    engineVersion: (): { version: string; commit: string } => ({
      version: "9.9.9",
      commit: "abcdef1",
    }),
    hostname: (): string => "fake-host",
  };
}

function baseSpec(name: string, port: number): ModelSpec {
  return {
    name,
    gguf_path: "/models/x/Q4_K_M.gguf",
    quant: "Q4_K_M",
    family: "t",
    size_params: "1b",
    host: "127.0.0.1",
    port,
    extra_args: [],
  };
}

async function runModelMatrix(model: ModelSpec, runId: string): Promise<Database> {
  const db = new Database(":memory:");
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await runMatrix({
      models: [model],
      workloads: [probeWorkload()],
      db,
      runId,
      provenanceReaders: fakeProvenanceReaders(),
    });
  } finally {
    warnSpy.mockRestore();
  }
  return db;
}

function provenanceFor(db: Database, runId: string): MatrixProvenance {
  const rows = listMatrixProvenance(db, { run_id: runId });
  expect(rows).toHaveLength(1);
  return rows[0]!.provenance;
}

function externalReason(name: string, engine: "gufo" | "kapitsa"): string {
  return `ModelSpec ${name} declares no launch flags (engine ${engine} runs outside eval)`;
}

function unmanagedReason(name: string): string {
  return `ModelSpec ${name} declares no launch flags (managed=false, so eval does not launch it)`;
}

describe("matrix provenance undeclared launch flags (#521)", () => {
  test("U1: gufo with no declared launch flags records the external-engine reason", async () => {
    const model: ModelSpec = {
      ...baseSpec("glm-gufo-noflags", await stoppedServerPort()),
      engine: "gufo",
      managed: false,
    };
    const db = await runModelMatrix(model, "run-u1-gufo-noflags");
    const prov = provenanceFor(db, "run-u1-gufo-noflags");

    expect(prov.unavailable?.flags).toBe(externalReason("glm-gufo-noflags", "gufo"));
    expect(prov.flags).toBeNull();
  });

  test("U2: kapitsa with no declared launch flags names the kapitsa engine", async () => {
    const model: ModelSpec = {
      ...baseSpec("kapitsa-noflags", await stoppedServerPort()),
      engine: "kapitsa",
      managed: false,
    };
    const db = await runModelMatrix(model, "run-u2-kapitsa-noflags");
    const prov = provenanceFor(db, "run-u2-kapitsa-noflags");

    expect(prov.unavailable?.flags).toBe(externalReason("kapitsa-noflags", "kapitsa"));
    expect(prov.flags).toBeNull();
  });

  test("U3: unmanaged llamacpp with no declared launch flags records the unmanaged reason", async () => {
    const model: ModelSpec = {
      ...baseSpec("llama-unmanaged", await stoppedServerPort()),
      engine: "llamacpp",
      managed: false,
    };
    const db = await runModelMatrix(model, "run-u3-llama-unmanaged");
    const prov = provenanceFor(db, "run-u3-llama-unmanaged");

    expect(prov.unavailable?.flags).toBe(unmanagedReason("llama-unmanaged"));
    expect(prov.flags).toBeNull();
  });

  test("U4: llamacpp with the managed key omitted is unmanaged for launch flags", async () => {
    const model: ModelSpec = {
      ...baseSpec("llama-managed-unset", await stoppedServerPort()),
      engine: "llamacpp",
    };
    const db = await runModelMatrix(model, "run-u4-llama-managed-unset");
    const prov = provenanceFor(db, "run-u4-llama-managed-unset");

    expect(prov.unavailable?.flags).toBe(unmanagedReason("llama-managed-unset"));
    expect(prov.flags).toBeNull();
  });

  test("U5: unmanaged omlx with no declared launch flags records the unmanaged reason", async () => {
    const model: ModelSpec = {
      ...baseSpec("omlx-unmanaged", await stoppedServerPort()),
      engine: "omlx",
      managed: false,
      mlx_model_dir: "/models/mlx/x",
    };
    const db = await runModelMatrix(model, "run-u5-omlx-unmanaged");
    const prov = provenanceFor(db, "run-u5-omlx-unmanaged");

    expect(prov.unavailable?.flags).toBe(unmanagedReason("omlx-unmanaged"));
    expect(prov.flags).toBeNull();
  });

  test("U6: the markdown report renders undeclared flags as unavailable with the reason", async () => {
    const runId = "run-u6-report";
    const model: ModelSpec = {
      ...baseSpec("glm-gufo-noflags", await stoppedServerPort()),
      engine: "gufo",
      managed: false,
    };
    const db = await runModelMatrix(model, runId);

    const report = renderMarkdownReport(listCellRows(db, { run_id: runId }), {
      runId,
      provenance: listMatrixProvenance(db, { run_id: runId }),
    });
    expect(report).toContain(
      `| ${runId} | glm-gufo-noflags | flags | unavailable (${externalReason("glm-gufo-noflags", "gufo")}) |`,
    );
    expect(report).not.toContain("| flags | (none) |");
  });

  test("G1: managed llamacpp keeps an explicit empty launch flag list available", async () => {
    const model: ModelSpec = {
      ...baseSpec("llama-managed-empty", await stoppedServerPort()),
      engine: "llamacpp",
      managed: true,
      binary: "/nonexistent/llamactl-521/llama-server",
    };
    const db = await runModelMatrix(model, "run-g1-managed-empty");
    const prov = provenanceFor(db, "run-g1-managed-empty");

    expect(prov.flags).toEqual([]);
    expect(prov.unavailable?.flags).toBeUndefined();
  });

  test("G2: external engines keep declared start_args and extra_args available", async () => {
    const model: ModelSpec = {
      ...baseSpec("gufo-declared-flags", await stoppedServerPort()),
      engine: "gufo",
      managed: false,
      start_args: ["--jinja"],
      extra_args: ["--ctx-size", "8192"],
    };
    const db = await runModelMatrix(model, "run-g2-gufo-declared");
    const prov = provenanceFor(db, "run-g2-gufo-declared");

    expect(prov.flags).toEqual(["--jinja", "--ctx-size", "8192"]);
    expect(prov.ctx).toBe(8192);
    expect(prov.unavailable?.flags).toBeUndefined();
  });
});
