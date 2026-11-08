import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildJsonClassifierWorkload,
  listCellRows,
  type ModelSpec,
  runMatrix,
  type WorkloadEval,
} from "../src/index.js";
import { repoRoot, resolveCorpusPath } from "../src/matrix/repo-root.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

const servers: ReturnType<typeof Bun.serve>[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop(true)));
  servers.length = 0;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function makeModel(port: number): ModelSpec {
  return {
    name: "model-a",
    gguf_path: "/models/model-a.gguf",
    quant: "Q4",
    family: "test",
    size_params: "1b",
    host: "127.0.0.1",
    port,
    extra_args: [],
  };
}

function workload(corpus_path: string): WorkloadEval {
  return buildJsonClassifierWorkload({
    name: "corpus-probe",
    corpus_path,
    labelField: "label",
    validLabels: new Set(["yes", "no"]),
  });
}

function corpusDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-eval-corpus-"));
  dirs.push(dir);
  return dir;
}

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
          choices: [{ message: { content: '{"label":"yes"}' } }],
          usage: { completion_tokens: 3 },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return server.port!;
}

const row = JSON.stringify({
  messages: [
    { role: "user", content: "q" },
    { role: "assistant", content: JSON.stringify({ label: "yes" }) },
  ],
});

describe("matrix repoRoot / resolveCorpusPath", () => {
  test("repoRoot is the checkout root that holds packages/eval", () => {
    expect(repoRoot()).toBe(resolve(import.meta.dir, "..", "..", ".."));
    expect(existsSync(join(repoRoot(), "packages", "eval", "package.json"))).toBe(true);
  });

  test("an absolute corpus path is returned verbatim, without normalisation", () => {
    expect(resolveCorpusPath("/corpus-root/a/../b.jsonl")).toBe("/corpus-root/a/../b.jsonl");
  });

  test("a relative corpus path resolves against repoRoot and is normalised", () => {
    expect(resolveCorpusPath("packages/eval/./test/../package.json")).toBe(
      join(repoRoot(), "packages", "eval", "package.json"),
    );
  });
});

describe("runMatrix corpus loading", () => {
  test("a corpusOverrides entry for the workload name replaces workload.corpus_path", async () => {
    const port = startStubServer();
    const dir = corpusDir();
    const base = join(dir, "base.jsonl");
    const overridePath = join(dir, "override.jsonl");
    writeFileSync(base, `${row}\n`);
    writeFileSync(overridePath, `${row}\n${row}\n${row}\n`);
    const db = new Database(":memory:");
    const { runId } = await runMatrix({
      models: [makeModel(port)],
      workloads: [workload(base)],
      db,
      corpusOverrides: new Map([["corpus-probe", overridePath]]),
    });
    const rows = listCellRows(db, { run_id: runId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.n_rows).toBe(3);
    expect(rows[0]!.errors).toBe(0);
    db.close();
  });

  test("an override keyed to a different workload name leaves workload.corpus_path in use", async () => {
    const port = startStubServer();
    const dir = corpusDir();
    const base = join(dir, "base.jsonl");
    const other = join(dir, "other.jsonl");
    writeFileSync(base, `${row}\n${row}\n`);
    writeFileSync(other, `${row}\n${row}\n${row}\n`);
    const db = new Database(":memory:");
    const { runId } = await runMatrix({
      models: [makeModel(port)],
      workloads: [workload(base)],
      db,
      corpusOverrides: new Map([["some-other-workload", other]]),
    });
    const rows = listCellRows(db, { run_id: runId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.n_rows).toBe(2);
    db.close();
  });

  test("blank lines are skipped and each malformed JSON line counts as one error", async () => {
    const port = startStubServer();
    const dir = corpusDir();
    const corpus = join(dir, "corpus.jsonl");
    writeFileSync(corpus, `${row}\n\n${row}\n{not json\n${row}\n`);
    const db = new Database(":memory:");
    const { runId } = await runMatrix({
      models: [makeModel(port)],
      workloads: [workload(corpus)],
      db,
    });
    const rows = listCellRows(db, { run_id: runId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.n_rows).toBe(3);
    expect(rows[0]!.errors).toBe(1);
    expect(rows[0]!.primary_metric_name).toBe("macro_f1");
    expect(rows[0]!.primary_metric_value).toBeCloseTo(1, 5);
    db.close();
  });
});
