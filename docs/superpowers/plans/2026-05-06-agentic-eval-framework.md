# Agentic-eval framework — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `packages/eval/` TypeScript framework that benches local llama.cpp models on Apple Silicon for penumbra agent fitness. Four objective sub-benches (throughput, tool-calling, context retrieval, JSON output), `-ub` tuning sweep, per-model markdown report cards, leaderboard MCP tool. Phase 1 baselines 7 existing penumbra `local-*` agents; Phase 2 adds 8 new candidates.

**Architecture:** Bench harness manages `llama-server` lifecycle (`-ngl 999 --flash-attn -c 8192 -ub {256,512}`), hits `/v1/chat/completions` via OpenAI-compat client, scores objectively, persists to SQLite + per-model markdown. Side-quest: re-run MTP pilot under new tuning flags to check if 0.85x verdict changes.

**Tech stack:** TypeScript, bun:test, zod (already in tree, used for fixture schemas), better-sqlite3 or bun:sqlite, llama.cpp.

**Spec:** `docs/superpowers/specs/2026-05-06-agentic-eval-framework.md`

---

## File structure

**New files:**
- `packages/eval/package.json` — TS package; depends on `@llamactl/core`
- `packages/eval/tsconfig.json`
- `packages/eval/src/index.ts` — public API barrel
- `packages/eval/src/config.ts` — model portfolio + tuning configs
- `packages/eval/src/server.ts` — llama-server lifecycle (boot, wait-for-health, kill)
- `packages/eval/src/client.ts` — chat-completions client + tool-calling helpers
- `packages/eval/src/runners/throughput.ts`
- `packages/eval/src/runners/tool-calling.ts`
- `packages/eval/src/runners/context-retrieval.ts`
- `packages/eval/src/runners/json-output.ts`
- `packages/eval/src/score/compose.ts` — composite scorer
- `packages/eval/src/score/normalize.ts`
- `packages/eval/src/store/sqlite.ts` — leaderboard persistence
- `packages/eval/src/report/render-card.ts` — per-model md generator
- `packages/eval/src/fixtures/prompts-throughput.json`
- `packages/eval/src/fixtures/prompts-tool-calling.json`
- `packages/eval/src/fixtures/prompts-context.json`
- `packages/eval/src/fixtures/prompts-json-output.json`
- `packages/eval/src/fixtures/tools-penumbra.json`
- `packages/eval/src/fixtures/haystack-base.txt`
- `packages/eval/test/runners.test.ts`
- `packages/eval/test/score.test.ts`
- `packages/cli/src/commands/eval.ts` — `llamactl eval ...` subcommands
- `packages/mcp/src/tools/models-leaderboard.ts` — `llamactl_models_leaderboard` MCP tool

**Modified files:**
- `packages/cli/src/index.ts` — register `eval` subcommand router
- `packages/mcp/src/server.ts` (or wherever tools are registered) — register `llamactl_models_leaderboard`
- `packages/core/src/catalog.ts` — Phase 2 only: 8 new catalog entries

---

## Slice A — Package scaffold + throughput runner

Goal: a working `bun packages/eval/src/cli-stub.ts throughput <model>` end-to-end against any in-catalog GGUF, producing one JSON file. No fancy report yet.

### Task A1: Package scaffold

**Files:**
- Create `packages/eval/package.json`
- Create `packages/eval/tsconfig.json`
- Create `packages/eval/src/index.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@llamactl/eval",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "test": "bun test"
  },
  "dependencies": {
    "@llamactl/core": "workspace:*",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.4.5"
  }
}
```

Match the project's existing version pins by copying from `packages/core/package.json`. Adjust if `zod` is at a different version there.

- [ ] **Step 2: Create `tsconfig.json`** (clone from `packages/core/tsconfig.json`).

- [ ] **Step 3: Create `src/index.ts`** as an empty barrel:
```ts
export {};
```

- [ ] **Step 4: Verify the workspace picks up the new package**
```bash
bun install
ls node_modules/@llamactl/eval
```
Expect a symlink into `packages/eval/`.

- [ ] **Step 5: Commit**
```bash
git add packages/eval/package.json packages/eval/tsconfig.json packages/eval/src/index.ts
git commit -m "eval: scaffold @llamactl/eval package"
```

### Task A2: Server lifecycle helper

**Files:**
- Create `packages/eval/src/server.ts`
- Create `packages/eval/test/server.test.ts`

- [ ] **Step 1: Write the failing test (deterministic, no real server)**

```ts
import { describe, expect, test } from "bun:test";
import { buildServerArgs } from "../src/server.js";

describe("buildServerArgs", () => {
  test("pins Apple Silicon flags and includes -ub", () => {
    const args = buildServerArgs({
      modelPath: "/models/foo.gguf",
      port: 18181,
      ub: 256,
    });
    expect(args).toEqual([
      "--host", "127.0.0.1",
      "--port", "18181",
      "--model", "/models/foo.gguf",
      "--ctx-size", "8192",
      "--no-warmup",
      "-np", "1",
      "-ngl", "999",
      "--flash-attn",
      "-ub", "256",
    ]);
  });

  test("supports flash-attn opt-out for spot validation", () => {
    const args = buildServerArgs({
      modelPath: "/x.gguf",
      port: 18181,
      ub: 512,
      flashAttn: false,
    });
    expect(args).not.toContain("--flash-attn");
  });

  test("supports ctx override for context sub-bench", () => {
    const args = buildServerArgs({
      modelPath: "/x.gguf",
      port: 18181,
      ub: 512,
      ctxSize: 16896,
    });
    expect(args).toContain("16896");
  });
});
```

- [ ] **Step 2: Run, fail.**
```bash
bun test packages/eval/test/server.test.ts
```

- [ ] **Step 3: Implement `buildServerArgs`** plus `spawnServer`, `waitForHealth`, `killServer` in `src/server.ts`.

```ts
import { spawn, type Subprocess } from "bun";

export interface ServerOptions {
  modelPath: string;
  port: number;
  ub: 256 | 512;
  ctxSize?: number;
  flashAttn?: boolean;
}

export function buildServerArgs(opts: ServerOptions): string[] {
  const args = [
    "--host", "127.0.0.1",
    "--port", String(opts.port),
    "--model", opts.modelPath,
    "--ctx-size", String(opts.ctxSize ?? 8192),
    "--no-warmup",
    "-np", "1",
    "-ngl", "999",
  ];
  if (opts.flashAttn !== false) args.push("--flash-attn");
  args.push("-ub", String(opts.ub));
  return args;
}

export interface SpawnedServer {
  proc: Subprocess;
  url: string;
  logPath: string;
}

export async function spawnServer(
  binary: string,
  opts: ServerOptions,
  logPath: string,
): Promise<SpawnedServer> {
  const args = buildServerArgs(opts);
  const log = Bun.file(logPath).writer();
  const proc = spawn([binary, ...args], {
    stdout: "pipe", stderr: "pipe",
  });
  // pipe stdout+stderr to log; non-blocking
  (async () => {
    for await (const chunk of proc.stdout) log.write(chunk);
  })();
  (async () => {
    for await (const chunk of proc.stderr) log.write(chunk);
  })();
  return { proc, url: `http://127.0.0.1:${opts.port}`, logPath };
}

export async function waitForHealth(
  url: string,
  proc: Subprocess,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`server died during startup (exit code ${proc.exitCode})`);
    }
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200) return;
    } catch { /* not up yet */ }
    await Bun.sleep(500);
  }
  throw new Error(`server failed health within ${timeoutMs}ms`);
}

export async function killServer(s: SpawnedServer): Promise<void> {
  s.proc.kill("SIGTERM");
  try { await s.proc.exited; } catch { /* fine */ }
}
```

- [ ] **Step 4: Test, pass.**
```bash
bun test packages/eval/test/server.test.ts
```

- [ ] **Step 5: Commit**
```bash
git add packages/eval/src/server.ts packages/eval/test/server.test.ts
git commit -m "eval: add llama-server lifecycle helper"
```

### Task A3: Chat-completions client

**Files:**
- Create `packages/eval/src/client.ts`
- Create `packages/eval/test/client.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, test } from "bun:test";
import { buildCompletionRequest } from "../src/client.js";

describe("buildCompletionRequest", () => {
  test("builds OpenAI-compat request without tools", () => {
    const req = buildCompletionRequest({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 192,
      seed: 42,
    });
    expect(req.body.model).toBe("local");
    expect(req.body.temperature).toBe(0);
    expect(req.body.max_tokens).toBe(192);
    expect(req.body.seed).toBe(42);
    expect(req.body.stream).toBe(false);
    expect(req.body.tools).toBeUndefined();
  });

  test("attaches tools when provided", () => {
    const tools = [{ type: "function", function: { name: "x", description: "", parameters: {} } }];
    const req = buildCompletionRequest({
      messages: [{ role: "user", content: "use the tool" }],
      maxTokens: 192,
      tools,
    });
    expect(req.body.tools).toEqual(tools);
    expect(req.body.tool_choice).toBe("auto");
  });
});
```

- [ ] **Step 2: Implement `client.ts`**

```ts
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CompletionRequest {
  body: {
    model: string;
    messages: ChatMessage[];
    temperature: number;
    max_tokens: number;
    seed?: number;
    stream: false;
    tools?: ToolDef[];
    tool_choice?: "auto" | "none";
  };
}

export interface CompletionResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  // llama-server-specific timings (best-effort)
  timings?: {
    prompt_per_second?: number;
    predicted_per_second?: number;
    predicted_n?: number;
    prompt_n?: number;
  };
}

export function buildCompletionRequest(opts: {
  messages: ChatMessage[];
  maxTokens: number;
  seed?: number;
  tools?: ToolDef[];
}): CompletionRequest {
  return {
    body: {
      model: "local",
      messages: opts.messages,
      temperature: 0,
      max_tokens: opts.maxTokens,
      seed: opts.seed,
      stream: false,
      ...(opts.tools ? { tools: opts.tools, tool_choice: "auto" } : {}),
    },
  };
}

export async function completeChat(
  url: string,
  req: CompletionRequest,
): Promise<{ resp: CompletionResponse; wallMs: number }> {
  const t0 = performance.now();
  const r = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req.body),
  });
  if (!r.ok) {
    throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  }
  const resp = (await r.json()) as CompletionResponse;
  return { resp, wallMs: performance.now() - t0 };
}
```

- [ ] **Step 3: Test, pass. Commit.**
```bash
bun test packages/eval/test/client.test.ts
git add packages/eval/src/client.ts packages/eval/test/client.test.ts
git commit -m "eval: add chat-completions client (OpenAI-compat)"
```

### Task A4: Throughput runner

**Files:**
- Create `packages/eval/src/runners/throughput.ts`
- Create `packages/eval/src/fixtures/prompts-throughput.json`
- Create `packages/eval/test/runners-throughput.test.ts`

- [ ] **Step 1: Port the 9 throughput prompts** from `tools/llama-cpp-mtp/bench-client.py` into `prompts-throughput.json`.

```json
[
  { "name": "code_python",      "prompt": "Write a Python function that returns the n-th Fibonacci number using memoization. Include a docstring." },
  { "name": "code_cpp",         "prompt": "Write a C++ template function `clamp(x, lo, hi)` that returns x clamped to [lo, hi]. No std::clamp." },
  { "name": "explain_concept",  "prompt": "Explain how speculative decoding works in large language model inference, in three short paragraphs." },
  { "name": "summarize",        "prompt": "Summarize in two sentences: The Industrial Revolution began in Britain..." },
  { "name": "qa_factual",       "prompt": "Q: What are the four fundamental forces of physics?\nA:" },
  { "name": "translation",      "prompt": "Translate to French: 'The quick brown fox jumps over the lazy dog.'" },
  { "name": "creative_short",   "prompt": "Write a four-line poem about an old lighthouse." },
  { "name": "stepwise_math",    "prompt": "Solve step by step: A train leaves station A at 60 km/h..." },
  { "name": "long_code_review", "prompt": "You are reviewing a backend service... (full text from bench-client.py)" }
]
```

Copy the long prompts verbatim from `tools/llama-cpp-mtp/bench-client.py`.

- [ ] **Step 2: Write the failing runner test**

```ts
import { describe, expect, test } from "bun:test";
import { aggregateThroughput } from "../src/runners/throughput.js";

describe("aggregateThroughput", () => {
  test("computes mean / p10 / p90 over per-prompt tps", () => {
    const result = aggregateThroughput([
      { name: "a", predicted_per_second: 10, predicted_n: 100, wallMs: 10000 },
      { name: "b", predicted_per_second: 20, predicted_n: 100, wallMs: 5000 },
      { name: "c", predicted_per_second: 30, predicted_n: 100, wallMs: 3334 },
    ]);
    expect(result.mean_tps).toBeCloseTo(20, 5);
    expect(result.p10_tps).toBeLessThanOrEqual(result.mean_tps);
    expect(result.p90_tps).toBeGreaterThanOrEqual(result.mean_tps);
    expect(result.total_predicted).toBe(300);
  });
});
```

- [ ] **Step 3: Implement throughput runner**

```ts
import promptsRaw from "../fixtures/prompts-throughput.json" with { type: "json" };
import { buildCompletionRequest, completeChat } from "../client.js";

export interface ThroughputSample {
  name: string;
  predicted_per_second: number;
  predicted_n: number;
  wallMs: number;
}

export interface ThroughputResult {
  samples: ThroughputSample[];
  mean_tps: number;
  p10_tps: number;
  p90_tps: number;
  total_predicted: number;
  total_wall_ms: number;
}

export function aggregateThroughput(samples: ThroughputSample[]): ThroughputResult {
  const tps = samples.map((s) => s.predicted_per_second).sort((a, b) => a - b);
  const mean = tps.reduce((a, b) => a + b, 0) / tps.length;
  const pct = (p: number) => tps[Math.min(tps.length - 1, Math.floor(p * tps.length))];
  return {
    samples,
    mean_tps: mean,
    p10_tps: pct(0.1),
    p90_tps: pct(0.9),
    total_predicted: samples.reduce((a, s) => a + s.predicted_n, 0),
    total_wall_ms: samples.reduce((a, s) => a + s.wallMs, 0),
  };
}

export async function runThroughput(url: string): Promise<ThroughputResult> {
  const samples: ThroughputSample[] = [];
  for (const p of promptsRaw as Array<{ name: string; prompt: string }>) {
    const req = buildCompletionRequest({
      messages: [{ role: "user", content: p.prompt }],
      maxTokens: 192,
      seed: 42,
    });
    const { resp, wallMs } = await completeChat(url, req);
    samples.push({
      name: p.name,
      predicted_per_second: resp.timings?.predicted_per_second ?? 0,
      predicted_n: resp.timings?.predicted_n ?? resp.usage?.completion_tokens ?? 0,
      wallMs,
    });
  }
  return aggregateThroughput(samples);
}
```

- [ ] **Step 4: Test, pass. Commit.**

### Task A5: CLI stub for end-to-end smoke

**Files:**
- Create `packages/eval/src/cli-stub.ts` (temp, replaced by Slice D)

- [ ] **Step 1: Build a minimal CLI** that picks up env, spawns server, runs throughput, dumps JSON.

```ts
#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnServer, waitForHealth, killServer } from "./server.js";
import { runThroughput } from "./runners/throughput.js";

const [, , modelRel, ubArg = "512"] = process.argv;
if (!modelRel) {
  console.error("usage: cli-stub.ts <model-rel> [ub=512]");
  process.exit(2);
}
const ub = Number(ubArg) === 256 ? 256 : 512;
const LLAMA_CPP_BIN = process.env.LLAMA_CPP_BIN ?? "";
const LLAMA_CPP_MODELS = process.env.LLAMA_CPP_MODELS ?? "";
const DEV_STORAGE = process.env.DEV_STORAGE ?? "";
if (!LLAMA_CPP_BIN || !LLAMA_CPP_MODELS || !DEV_STORAGE) {
  console.error("env not set; run: eval \"$(bun packages/cli/src/bin.ts env --eval)\"");
  process.exit(2);
}

const modelPath = join(LLAMA_CPP_MODELS, modelRel);
if (!existsSync(modelPath)) { console.error(`missing model: ${modelPath}`); process.exit(3); }

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(DEV_STORAGE, "eval", ts);
mkdirSync(outDir, { recursive: true });
const logPath = join(outDir, `server.log`);

const server = await spawnServer(`${LLAMA_CPP_BIN}/llama-server`, {
  modelPath, port: 18181, ub,
}, logPath);
try {
  console.log(`==> waiting for ${server.url}/health`);
  await waitForHealth(server.url, server.proc);
  console.log(`==> running throughput`);
  const r = await runThroughput(server.url);
  const outFile = join(outDir, `throughput.json`);
  await Bun.write(outFile, JSON.stringify(r, null, 2));
  console.log(`==> wrote ${outFile}`);
  console.log(`mean tps: ${r.mean_tps.toFixed(2)} (p10=${r.p10_tps.toFixed(2)} p90=${r.p90_tps.toFixed(2)})`);
} finally {
  await killServer(server);
}
```

- [ ] **Step 2: Smoke against the smallest in-catalog model** (likely `qwen35-4b` or whatever `local-qwen35-4b` resolves to)

```bash
eval "$(bun packages/cli/src/bin.ts env --eval)"
bun packages/eval/src/cli-stub.ts <smallest-rel> 512
```

Expect: server boots in ~10s, throughput prints mean tps, JSON file lands.

- [ ] **Step 3: Commit (stub + e2e proof)**
```bash
git add packages/eval/src/cli-stub.ts packages/eval/src/runners/throughput.ts \
        packages/eval/src/fixtures/prompts-throughput.json \
        packages/eval/test/runners-throughput.test.ts
git commit -m "eval: throughput runner + cli stub for e2e smoke"
```

---

## Slice B — Tool-calling + JSON sub-benches

### Task B1: Penumbra-shaped tool schemas

**Files:**
- Create `packages/eval/src/fixtures/tools-penumbra.json`

- [ ] Create the fixture with these 5 tool defs (function-calling format):
  - `chain_start(initial_agent: string, message: string, task_type?: string)`
  - `handoff_approve(handoff_id: string)`
  - `task_get(task_id: string)`
  - `memory_search(query: string, project_id?: string, limit?: integer)`
  - `fs_grep(pattern: string, path?: string)`

OpenAI tool-call schema format (verify against llama-server's expected
shape via a quick `curl` against any model first):

```json
[
  {
    "type": "function",
    "function": {
      "name": "chain_start",
      "description": "Kick off an agent chain.",
      "parameters": {
        "type": "object",
        "properties": {
          "initial_agent": { "type": "string" },
          "message": { "type": "string" },
          "task_type": { "type": "string", "enum": ["plan_refine", "implement_small", "implement_substantial", "review_adversarial", "smoke_test", "debug_diagnose", "docs_mechanical", "health_check", "unknown"] }
        },
        "required": ["initial_agent", "message"]
      }
    }
  },
  ... (other 4)
]
```

### Task B2: Tool-calling fixture set

**Files:**
- Create `packages/eval/src/fixtures/prompts-tool-calling.json`

- [ ] 12 prompts. Each entry:
```json
{
  "name": "string id",
  "prompt": "user message",
  "expected": {
    "should_call": true,
    "tool": "fs_grep",
    "args_predicate": { "pattern_contains": "LLAMA_CPP_BIN_MTP" }
  }
}
```
or
```json
{ "name": "creative_no_tool", "prompt": "Write a haiku about the moon.", "expected": { "should_call": false } }
```

12 cases: 8 should-call (mix across all 5 tools), 4 should-not-call. Predicates use small DSL — `string_eq`, `string_contains`, `int_eq`. Implement the predicate evaluator in `runners/tool-calling.ts`.

### Task B3: Tool-calling runner

**Files:**
- Create `packages/eval/src/runners/tool-calling.ts`
- Create `packages/eval/test/runners-tool-calling.test.ts`

- [ ] **Step 1: Test the predicate evaluator** with synthetic tool-call data (no server). Cover all 4 binary scoring fields.

- [ ] **Step 2: Implement** `runToolCalling(url): Promise<ToolCallingResult>`:
  1. Load tools from `tools-penumbra.json`.
  2. For each prompt:
     - Build request with `tools: [...]` and `tool_choice: "auto"`.
     - Send.
     - Score the response into 4 binary fields.
  3. Aggregate `tool_call_score = mean(all four conditions met)`.

- [ ] **Step 3: Smoke** against a model known for tool-calling (Qwen3 27B is a safe bet). Score should be >0.

- [ ] **Step 4: Commit.**

### Task B4: JSON output fixture set

**Files:**
- Create `packages/eval/src/fixtures/prompts-json-output.json`

- [ ] 5 prompts, each with a JSON Schema (subset usable by zod). Examples:

```json
{
  "name": "entities",
  "prompt": "Extract entities from: 'Apple Inc., based in Cupertino, was founded by Steve Jobs.' Return JSON matching {entities: [{name: string, type: 'person'|'place'|'org'}]}",
  "schema": {
    "type": "object",
    "required": ["entities"],
    "properties": {
      "entities": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["name", "type"],
          "properties": {
            "name": { "type": "string" },
            "type": { "enum": ["person", "place", "org"] }
          }
        }
      }
    }
  }
}
```

5 fixtures: entities, changelog parse, recipe extract, error report parse, contact card. Mix of array-of-objects, deeply-nested, enum-constrained.

### Task B5: JSON output runner

**Files:**
- Create `packages/eval/src/runners/json-output.ts`
- Create `packages/eval/test/runners-json-output.test.ts`

- [ ] **Step 1: Test the JSON-extraction + validation logic** with synthetic responses (no server). Cover: bare JSON, JSON in code-fence, JSON in prose, malformed JSON (must score 0).

- [ ] **Step 2: Implement** using Ajv (add as dep) or `zod-to-json-schema` reverse via simple recursive validator. Either works; pick whichever already exists in tree (`grep -r "ajv\|zod-to-json" packages/`). If neither, add `ajv` to `packages/eval/package.json`.

- [ ] **Step 3: Smoke + commit.**

---

## Slice C — Context retrieval sub-bench

### Task C1: Haystack base + needle generation

**Files:**
- Create `packages/eval/src/fixtures/haystack-base.txt` (committed; deterministic)
- Create `packages/eval/src/fixtures/prompts-context.json`

- [ ] **Step 1: Build the haystack base.** ~20k tokens of public-domain text (e.g., excerpt from Project Gutenberg's *Moby-Dick* or *Pride and Prejudice* — both are well in the training set so the model can't "skip past" it via boredom). Trim to ~80kB plain text.

- [ ] **Step 2: Define 9 needles** (3 per depth tier 4k/8k/16k). Each needle is a 1-sentence statement that's verifiably absent from the haystack base. Insert at 0.25, 0.5, 0.75 fractional depth.

```json
[
  { "name": "endeavour-quartermaster",
    "depth": 4096,
    "position": 0.5,
    "needle": "The quartermaster of the HMS Endeavour in 1771 was named Charles Whittington.",
    "question": "What was the name of the quartermaster of the HMS Endeavour in 1771?",
    "answer_substring": "Charles Whittington" },
  ...
]
```

### Task C2: Context retrieval runner

**Files:**
- Create `packages/eval/src/runners/context-retrieval.ts`
- Create `packages/eval/test/runners-context.test.ts`

- [ ] **Step 1: Test** `assembleHaystack(base, needle, depth, position)` — count tokens via a simple word-based proxy, verify needle lands at correct position.

- [ ] **Step 2: Implement runner.** For each fixture:
  1. Assemble haystack at the configured depth + position.
  2. Spawn a fresh server per (model, ub, depth) since `--ctx-size` differs per depth tier (4096 → 4608, 8192 → 8704, 16384 → 16896 — each needs +512 headroom for question + answer).
  3. Send `{messages: [{role: "user", content: haystack + question}]}`.
  4. Score: `answer_substring` appears in response.

  Caveat: the runner needs to control ctx-size, which means the eval driver (Slice D) re-spawns server per depth tier. That's expensive but correct.

  Alternative (simpler, less rigorous): pin server at `--ctx-size 17408` (fits 16k haystack + headroom) for the entire context sub-bench, accept the perf hit on 4k/8k pairs since the model has a bigger empty cache to scan past. Pick this for v1; the comparison is across models, not absolute.

  **Pick the simpler alternative for v1.** Document the choice in the runner comment.

- [ ] **Step 3: Commit.**

---

## Slice D — Scoring + report + leaderboard MCP

### Task D1: Composite scorer

**Files:**
- Create `packages/eval/src/score/compose.ts`
- Create `packages/eval/test/score.test.ts`

- [ ] **Step 1: Test the composite formula** with synthetic per-sub-bench scores. Cover: all sub-benches succeed, throughput dominates, missing context-16k (uses context-8k as fallback per spec).

- [ ] **Step 2: Implement.**

```ts
export interface SubBenchScores {
  throughput_tps: number;
  tool_call_score: number;          // [0, 1]
  context_8k_score: number;          // [0, 1]
  context_16k_score: number | null;
  json_score: number;                // [0, 1]
}

export function composite(s: SubBenchScores): number {
  const norm_tps = Math.min(1, s.throughput_tps / 30);
  const ctx16 = s.context_16k_score ?? s.context_8k_score;
  return 0.30 * norm_tps
       + 0.30 * s.tool_call_score
       + 0.20 * s.context_8k_score
       + 0.10 * ctx16
       + 0.10 * s.json_score;
}
```

### Task D2: SQLite store

**Files:**
- Create `packages/eval/src/store/sqlite.ts`
- Create `packages/eval/test/store.test.ts`

- [ ] **Step 1: Test** insert + query against a temp file using `bun:sqlite` (built-in, no dep needed).

- [ ] **Step 2: Implement.** Single table:

```sql
CREATE TABLE IF NOT EXISTS leaderboard (
  model TEXT NOT NULL,
  node TEXT NOT NULL,
  ub INTEGER NOT NULL,
  throughput_tps REAL NOT NULL,
  ttft_ms REAL,
  tool_call_score REAL NOT NULL,
  context_8k_score REAL NOT NULL,
  context_16k_score REAL,
  json_score REAL NOT NULL,
  composite REAL NOT NULL,
  asof TEXT NOT NULL,
  PRIMARY KEY (model, node, ub)
);
```

API: `upsertRow`, `queryRows({ node?, sortBy?, minThroughput?, minToolCall? })`.

### Task D3: Per-model report renderer

**Files:**
- Create `packages/eval/src/report/render-card.ts`
- Create `packages/eval/test/report.test.ts`

- [ ] **Step 1: Test** that the rendered markdown contains expected section headings + data points.

- [ ] **Step 2: Implement.** Output path: `docs/superpowers/specs/<YYYY-MM-DD>-model-eval-<model>.md`. Sections per spec:

```markdown
# Model eval — <model-id>

Date: YYYY-MM-DD
Source: <hf-repo> @ <file>
Tested on: <node-list>

## Summary
- Best composite: <X.XX> on <node> with -ub <Y>
- Verdict: <one-sentence>

## Hardware matrix
| Node | -ub | tps | tool-call | ctx-8k | ctx-16k | json | composite |
|---|---|---|---|---|---|---|---|
| local | 256 | ... | ... | ... | ... | ... | ... |
...

## Per sub-bench

### Throughput
mean: X tps, p10: Y, p90: Z
notable: <slowest prompt, fastest prompt>

### Tool-calling
score: X / 12
failures:
- <prompt name>: <reason>
...

### Context retrieval
4k score: X/3
8k score: X/3
16k score: X/3 (or "skipped — does not fit")

### JSON output
score: X / 5
failures:
- <prompt name>: <reason>

## Tuning sweep
-ub 256 vs 512: <delta-summary>
```

### Task D4: Leaderboard MCP tool

**Files:**
- Create `packages/mcp/src/tools/models-leaderboard.ts`
- Modify wherever MCP tools are registered (find via `grep -rn "registerTool\|tools:" packages/mcp/src/ | head -20`)

- [ ] **Step 1: Implement** `llamactl_models_leaderboard` MCP tool wrapping `queryRows`. Inputs: optional `node`, `min_throughput`, `min_tool_call_score`, `sort_by`. Returns the typed `LeaderboardRow[]`.

- [ ] **Step 2: Wire it** into the MCP server registration. Add a smoke test under `packages/mcp/test/` if the project has that pattern.

### Task D5: CLI commands

**Files:**
- Create `packages/cli/src/commands/eval.ts`
- Modify `packages/cli/src/index.ts` (or wherever subcommands register)

- [ ] Subcommands:
  - `llamactl eval run <model> [--node <name>] [--ub <256|512>] [--all]` — run all sub-benches against one or all models, write JSONs + update sqlite.
  - `llamactl eval report <model>` — regenerate the per-model card from sqlite.
  - `llamactl eval leaderboard [--node <name>] [--sort-by <field>]` — print the leaderboard table to stdout.

- [ ] Replace the stub `packages/eval/src/cli-stub.ts` (delete it).

### Task D6: End-to-end smoke + commit

- [ ] Run `llamactl eval run qwen35-4b --node mac-mini --ub 512` (smallest entry; assumes it's already on the mac-mini OR we run on local and just measure local).

- [ ] Verify per-model markdown lands in `docs/superpowers/specs/`. Verify `llamactl eval leaderboard` shows one row.

- [ ] Verify `llamactl_models_leaderboard` MCP tool returns the same row.

- [ ] Commit.

---

## Slice E — Phase 1 baseline runs

### Task E1: Catalog id reconciliation

- [ ] Read `packages/core/src/catalog.ts`. Map each penumbra `local-*` agent name to the corresponding `CuratedModel.id`. Build a mapping table:

| Penumbra agent | Catalog id | GGUF rel |
|---|---|---|
| local-gemma26 | gemma26 (verify) | ... |
| local-gemma31 | gemma31 (verify) | ... |
| local-qwen36-35b-moe | qwen36-q4m (verify) | ... |
| local-qwen36-27b | ? | ... |
| local-qwen35-27b | ? | ... |
| local-qwen3-coder | ? | ... |
| local-qwen35-4b | ? | ... |

The Penumbra "local-*" names may not match catalog ids 1:1. Resolve from
the actual penumbra agent registry (`mcp__penumbra__chain_list_agents`
output gave us the names; the catalog may use shorter ids).

If a penumbra agent doesn't have a corresponding catalog entry, **flag it
and skip that baseline.** Don't add catalog entries in Slice E.

### Task E2: Run baselines

- [ ] On M4 Pro: `for id in <baseline-list>; do llamactl eval run "$id" --node local --all; done`. The `--all` runs both `-ub 256` and `-ub 512`.

- [ ] On mac-mini: only run `qwen35-4b` (or whichever baseline fits).

- [ ] Spot-validate `--flash-attn off` on Qwen 3.6 27B at `-ub 512`. Add this as a one-off:
```bash
LLAMACTL_EVAL_FLASH_ATTN=0 llamactl eval run qwen36-27b --node local --ub 512
```
(needs an env-flag escape hatch in the CLI; trivial addition).

- [ ] Verify all baseline report cards lands in `docs/superpowers/specs/`.

- [ ] Commit:
```bash
git add docs/superpowers/specs/2026-05-06-model-eval-*.md
git commit -m "eval: Phase 1 baseline reports for existing penumbra local-* agents"
```

---

## Slice F — Phase 2 new candidate downloads + runs

### Task F1: Verify HF repos

- [ ] For each Phase 2 candidate, probe HF API:
```bash
for repo in <list>; do
  echo "$repo: $(curl -fsSL "https://huggingface.co/api/models/$repo" 2>/dev/null | jq -r '.id' || echo MISSING)"
done
```

- [ ] If a proposed repo doesn't exist, find the closest substitute (typically bartowski/* or unsloth/* equivalents). Document substitutions in the per-model report.

### Task F2: Add catalog entries

**Files:**
- Modify `packages/core/src/catalog.ts`
- Add tests under `packages/core/test/`

- [ ] **Step 1: Test** that the new entries parse against `CuratedModel` schema and resolve to expected GGUF paths.

- [ ] **Step 2: Add the 8 entries.** Use existing entries as templates (match the `class`, `scope`, `family` conventions).

- [ ] **Step 3: Commit.**

### Task F3: Download all 8

- [ ] Reuse `tools/llama-cpp-mtp/download.sh` pattern but generalize — extract a `tools/llama-cpp/download-rel.sh <hf-repo> <hf-file> <rel-dir>` and add a `llamactl model download <id>` CLI subcommand that reads the catalog. (Optional polish — for v1 it's fine to just shell out per model.)

- [ ] Run downloads sequentially or in pairs (don't saturate HF). Total ~70 GB.

### Task F4: Run benches

- [ ] On M4 Pro: 4 new candidates × 2 ub = 8 runs.
- [ ] On mac-mini: 4 new candidates × 2 ub = 8 runs.

### Task F5: Updated leaderboard + commit

- [ ] Generate updated per-model cards.
- [ ] Verify leaderboard.
- [ ] Commit Phase 2 artifacts.

---

## Slice G — MTP re-bench (side-quest)

### Task G1: Re-run MTP under new flags

- [ ] Modify `tools/llama-cpp-mtp/bench.sh` to add `-ngl 999 --flash-attn -ub 512` to the spawn args. Test: re-run vanilla + MTP on Qwen 27B (`tools/llama-cpp-mtp/bench.sh vanilla Qwen3.6-27B-GGUF/Qwen3.6-27B-Q4_K_M.gguf` etc.).

- [ ] Compare to prior 0.85x ratio. If MTP now ≥1.4x, the gate flips.

### Task G2: Update slice-a-results doc

- [ ] If MTP flips: append an "Update 2026-05-06" section to
  `docs/superpowers/specs/2026-05-05-llamacpp-mtp-pilot-slice-a-results.md`
  documenting the new numbers and re-opening the Slice B decision.
- [ ] If MTP doesn't flip: append a one-paragraph update confirming the verdict held under the better tuning.

- [ ] Commit either way.

---

## Self-review

**Spec coverage:**
- Per-model report cards (Slice D3) + leaderboard MCP (D4) — artifact A+B from spec ✅
- Portfolio: Phase 1 baselines (E2) + Phase 2 candidates (F4) — 15 models ✅
- Sub-benches: throughput (A4), tool-calling (B3), context (C2), JSON (B5) ✅
- Tuning: -ub 256/512 sweep is the default in CLI; --flash-attn opt-out via env (E2) ✅
- MTP re-bench: Slice G ✅
- Direct llama-server runtime: Slice A2 server lifecycle ✅
- packages/eval TS package + packages/mcp leaderboard tool: Slices A-D ✅
- Cost estimate ≈ 50-60 server boots (~10-15 hours): aligns with spec ✅

**Placeholder scan:** No "TBD" / "TODO" — every step has either real code, an exact command, or an explicit "verify against existing convention" instruction. Two soft references: B5 step 2 says "pick whichever already exists in tree" for the JSON validator (genuine "follow local conventions"), and C2 step 2 picks the simpler v1 alternative (deliberate scope cut).

**Type consistency:** `SubBenchScores` shape (D1) drives `composite()` and the leaderboard schema (D2). `LeaderboardRow` from spec → MCP tool (D4) returns the same shape SQLite stores. `ChatMessage` / `ToolDef` / `CompletionResponse` (A3) used uniformly in all runners.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-06-agentic-eval-framework.md`. Two execution options:

**1. Subagent-driven (recommended)** — dispatch a fresh subagent per task, review between, fast iteration. Best fit because Slices E/F are long-running download + bench operations that don't need session context.

**2. Inline execution** — execute tasks in this session via executing-plans, batch with checkpoints.

Which approach?
