import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildJsonClassifierWorkload,
  listCellRows,
  type ModelSpec,
  runMatrix,
  type WorkloadEval,
} from "../src/index.js";
import { renderMarkdownReport } from "../src/matrix/report.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

const servers: ReturnType<typeof Bun.serve>[] = [];
const dirs: string[] = [];
const dbs: Database[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.stop(true)));
  servers.length = 0;
  for (const db of dbs) db.close();
  dbs.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

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

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-eval-boot-error-"));
  dirs.push(dir);
  return dir;
}

function chatCorpusRow(): string {
  return JSON.stringify({
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: JSON.stringify({ label: "yes" }) },
    ],
  });
}

function writeCorpus(dir: string): string {
  const corpusPath = join(dir, "corpus.jsonl");
  writeFileSync(corpusPath, `${chatCorpusRow()}\n`);
  return corpusPath;
}

function classifierWorkload(name: string, corpusPath: string): WorkloadEval {
  return buildJsonClassifierWorkload({
    name,
    corpus_path: corpusPath,
    labelField: "label",
    validLabels: new Set(["yes", "no"]),
  });
}

function gufoSpec(name: string, port: number): ModelSpec {
  return {
    name,
    engine: "gufo",
    managed: false,
    gguf_path: "/models/fake.gguf",
    quant: "Q4_K_M",
    family: "fake",
    size_params: "1b",
    host: "127.0.0.1",
    port,
    extra_args: [],
  };
}

function llamacppSpec(name: string, port: number, binary: string): ModelSpec {
  return {
    name,
    engine: "llamacpp",
    managed: true,
    binary,
    gguf_path: "/models/fake.gguf",
    quant: "Q4_K_M",
    family: "fake",
    size_params: "1b",
    host: "127.0.0.1",
    port,
    extra_args: [],
  };
}

function openDb(dir: string): Database {
  const db = new Database(join(dir, "matrix.db"));
  dbs.push(db);
  return db;
}

function bootLifecycleMessage(name: string, port: number): string {
  return `model ${name}: engine gufo is not managed by eval and is not reachable at 127.0.0.1:${String(port)}; run the server externally`;
}

function singleArgWarnings(warnSpy: { mock: { calls: unknown[][] } }): unknown[] {
  return warnSpy.mock.calls.filter((call) => call.length === 1).map((call) => call[0]);
}

describe("#521 matrix boot error reason", () => {
  // Kills: recordBootError still storing JSON.stringify({}), or dropping the reason.
  test("B1 stores an unreachable external model boot reason on the error cell", async () => {
    const port = await stoppedServerPort();
    const dir = tempDir();
    const workload = classifierWorkload("probe", writeCorpus(dir));
    const db = openDb(dir);

    const run = await runMatrix({
      models: [gufoSpec("gufo-down", port)],
      workloads: [workload],
      db,
    });

    const cells = listCellRows(db, { run_id: run.runId });
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.n_rows).toBe(0);
    expect(cell.primary_metric_value).toBe(0);
    expect(cell.errors).toBe(1);
    const stored = JSON.parse(cell.per_class_metrics_json) as Record<string, unknown>;
    const reason = `model boot failed: ${bootLifecycleMessage("gufo-down", port)}`;
    expect(stored["error"]).toBe(reason);
    expect(renderMarkdownReport(cells, { runId: run.runId })).toContain(
      `- gufo-down / probe: no rows scored (${reason})`,
    );
  });

  // Kills: storing the whole multi-line message, which would carry llama-server stderr tails.
  test("B2 stores only the first line of a multi-line launch refusal", async () => {
    const port = await stoppedServerPort();
    const dir = tempDir();
    const binaryPath = join(dir, "fake-llama-server");
    writeFileSync(binaryPath, "not spawned; the launch refusal fires first\n");
    const workload = classifierWorkload("probe", writeCorpus(dir));
    const db = openDb(dir);

    const run = await runMatrix({
      models: [llamacppSpec("llamacpp-refused", port, binaryPath)],
      workloads: [workload],
      db,
      launchRefusal: () => "refused line one\nrefused line two",
    });

    const cells = listCellRows(db, { run_id: run.runId });
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    const stored = JSON.parse(cell.per_class_metrics_json) as Record<string, unknown>;
    expect(stored["error"]).toBe("model boot failed: eval matrix: refused line one");
    expect(renderMarkdownReport(cells, { runId: run.runId })).not.toContain("refused line two");
  });

  // Kills: dropping the .trim() on the headline, which would keep trailing whitespace.
  test("B5 trims trailing whitespace from the first-line headline", async () => {
    const port = await stoppedServerPort();
    const dir = tempDir();
    const binaryPath = join(dir, "fake-llama-server");
    writeFileSync(binaryPath, "not spawned; the launch refusal fires first\n");
    const workload = classifierWorkload("probe", writeCorpus(dir));
    const db = openDb(dir);

    const run = await runMatrix({
      models: [llamacppSpec("llamacpp-padded", port, binaryPath)],
      workloads: [workload],
      db,
      launchRefusal: () => "line one  \nline two",
    });

    const cells = listCellRows(db, { run_id: run.runId });
    expect(cells).toHaveLength(1);
    const stored = JSON.parse(cells[0]!.per_class_metrics_json) as Record<string, unknown>;
    expect(stored["error"]).toBe("model boot failed: eval matrix: line one");
  });

  // Kills: always formatting `${prefix}: ${headline}`, which would leave a dangling colon.
  test("B6 stores the bare prefix when the boot error message is empty", async () => {
    const port = await stoppedServerPort();
    const dir = tempDir();
    const binaryPath = join(dir, "fake-llama-server");
    writeFileSync(binaryPath, "not spawned; the launch refusal fires first\n");
    const workload = classifierWorkload("probe", writeCorpus(dir));
    const db = openDb(dir);

    const run = await runMatrix({
      models: [llamacppSpec("llamacpp-empty", port, binaryPath)],
      workloads: [workload],
      db,
      launchRefusal: () => {
        throw new Error("");
      },
    });

    const cells = listCellRows(db, { run_id: run.runId });
    expect(cells).toHaveLength(1);
    const stored = JSON.parse(cells[0]!.per_class_metrics_json) as Record<string, unknown>;
    expect(stored["error"]).toBe("model boot failed");
  });

  // Kills: the judge path using the model prefix, storing {}, or the judge warning being changed.
  test("B3 stores a judge boot failure reason with the judge prefix", async () => {
    const upPort = startStubServer();
    const stoppedPort = await stoppedServerPort();
    const dir = tempDir();
    const classifier = classifierWorkload("probe", writeCorpus(dir));
    const workload: WorkloadEval = {
      ...classifier,
      judge_model: gufoSpec("judge-down", stoppedPort),
    };
    const db = openDb(dir);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const run = await runMatrix({
        models: [gufoSpec("gufo-up", upPort)],
        workloads: [workload],
        db,
      });

      const cells = listCellRows(db, { run_id: run.runId });
      expect(cells).toHaveLength(1);
      const cell = cells[0]!;
      const stored = JSON.parse(cell.per_class_metrics_json) as Record<string, unknown>;
      const judgeReason = `judge judge-down boot failed: ${bootLifecycleMessage("judge-down", stoppedPort)}`;
      expect(stored["error"]).toBe(judgeReason);
      const expectedWarning = `[matrix] failed to boot judge for ${workload.name}: ${bootLifecycleMessage("judge-down", stoppedPort)}`;
      expect(singleArgWarnings(warnSpy)).toContain(expectedWarning);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Kills: changing the boot warning text or the corpus-failure sentinel while adding reasons.
  test("B4 keeps boot warnings and corpus failure cells unchanged", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const downPort = await stoppedServerPort();
      const downDir = tempDir();
      const downWorkload = classifierWorkload("probe", writeCorpus(downDir));
      const downDb = openDb(downDir);
      await runMatrix({
        models: [gufoSpec("gufo-down", downPort)],
        workloads: [downWorkload],
        db: downDb,
      });
      const expectedWarning = `[matrix] failed to boot gufo-down: ${bootLifecycleMessage("gufo-down", downPort)}`;
      expect(singleArgWarnings(warnSpy)).toContain(expectedWarning);

      const upPort = startStubServer();
      const upDir = tempDir();
      const missingCorpusWorkload = classifierWorkload(
        "missing-corpus",
        join(upDir, "missing.jsonl"),
      );
      const upDb = openDb(upDir);
      const corpusRun = await runMatrix({
        models: [gufoSpec("gufo-up", upPort)],
        workloads: [missingCorpusWorkload],
        db: upDb,
      });

      const cells = listCellRows(upDb, { run_id: corpusRun.runId });
      expect(cells).toHaveLength(1);
      expect(cells[0]?.primary_metric_value).toBe(-1);
      expect(cells[0]?.per_class_metrics_json).toBe('{"error":"corpus_load_failed"}');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
