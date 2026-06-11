import type { NodeClient } from "@llamactl/remote";

import { config as kubecfg, resolveNodeKind } from "@llamactl/remote";

import { getNodeClient } from "../dispatcher.js";
import { required } from "../required.js";

const USAGE = `Usage: llamactl rag <subcommand>

Subcommands:
  ask <question> --kb <node> --via <node> --model <id> [flags]
      Retrieve top-k passages from the named RAG node and route a
      chat completion through the named gateway / cloud / agent node
      using the provided model id.

  pipeline <sub>            Apply + run declarative RAG ingestion
                            pipelines. See 'llamactl rag pipeline -h'.

  bench -f <file.yaml> [--json]
                            Run a RagBench manifest (operator-supplied
                            query set) against a rag node and print a
                            hit-rate + MRR report. See 'llamactl rag
                            bench -h' (-f -) for details.

'ask' flags:
  --kb <name>              RAG node to retrieve from. Required when
                           the current context has more than one rag
                           node; auto-selected when exactly one.
  --via <name>             Node to send the chat completion to
                           (gateway, cloud, agent). Required.
  --model <id>             Model id the gateway should route to.
                           Required.
  --top-k <N>              Retrieval count (default: 3).
  --collection <name>      Override the rag node's default collection.
  --max-tokens <N>         Chat max_tokens (default: 2048).
  --temperature <f>        Chat temperature (default: 0).
  --system-prompt <str>    Override the default system prompt.
  --cite                   Print retrieved passages before the answer.
  --json                   Emit a single JSON doc combining retrieval
                           and answer. Takes precedence over --cite.
`;

/**
 * Seam for tests: lets a unit test inject a stub NodeClient so the
 * command runs without bootstrapping the tRPC local-caller proxy.
 * Production callers never touch this — pass `undefined` (or omit)
 * and `runRag` falls back to the dispatcher's `getNodeClient()`.
 */
export interface RagTestSeams {
  nodeClient?: NodeClient;
}

let testSeams: RagTestSeams = {};

export function __setRagTestSeams(seams: RagTestSeams): void {
  testSeams = { ...seams };
}

export function __resetRagTestSeams(): void {
  testSeams = {};
}

function resolveClient(): NodeClient {
  return testSeams.nodeClient ?? getNodeClient();
}

export async function runRag(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "ask":
      return await runAsk(rest);
    case "pipeline": {
      const { runRagPipeline } = await import("./rag-pipeline.js");
      return await runRagPipeline(rest);
    }
    case "bench": {
      const { runRagBenchCli } = await import("./rag-bench.js");
      return await runRagBenchCli(rest);
    }
    case undefined:
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown rag subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}

interface AskOpts {
  question: string;
  kb: string | undefined;
  via: string | undefined;
  model: string | undefined;
  topK: number;
  collection: string | undefined;
  maxTokens: number;
  temperature: number;
  systemPrompt: string | undefined;
  cite: boolean;
  json: boolean;
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  if (eq < 0) return [arg, undefined];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

function takeAskValue(
  args: string[],
  i: number,
  inline: string | undefined,
): { value: string | undefined; next: number } {
  if (inline !== undefined) return { value: inline, next: i + 1 };
  if (i + 1 < args.length) return { value: args[i + 1], next: i + 2 };
  return { value: undefined, next: i + 1 };
}

function assignPositiveInt(
  opts: AskOpts,
  key: "maxTokens" | "topK",
  flag: string,
  raw: string | undefined,
): { ok: true } | { error: string } {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { error: `rag ask: ${flag} must be a positive integer (got ${raw ?? "<empty>"})` };
  }
  opts[key] = n;
  return { ok: true };
}

function assignTemperature(
  opts: AskOpts,
  raw: string | undefined,
): { ok: true } | { error: string } {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return {
      error: `rag ask: --temperature must be a non-negative number (got ${raw ?? "<empty>"})`,
    };
  }
  opts.temperature = n;
  return { ok: true };
}

function assignAskValue(
  opts: AskOpts,
  flag: string,
  value: string | undefined,
): { ok: true } | { error: string } {
  switch (flag) {
    case "--kb":
      opts.kb = value;
      return { ok: true };
    case "--via":
      opts.via = value;
      return { ok: true };
    case "--model":
      opts.model = value;
      return { ok: true };
    case "--top-k":
      return assignPositiveInt(opts, "topK", "--top-k", value);
    case "--collection":
      opts.collection = value;
      return { ok: true };
    case "--max-tokens":
      return assignPositiveInt(opts, "maxTokens", "--max-tokens", value);
    case "--temperature":
      return assignTemperature(opts, value);
    case "--system-prompt":
      opts.systemPrompt = value;
      return { ok: true };
    default:
      return { error: `rag ask: unknown flag ${flag}` };
  }
}

function consumeAskArg(
  opts: AskOpts,
  questionParts: string[],
  args: string[],
  i: number,
): { next: number } | { error: string } {
  const arg = required(args[i]);
  const [flag, inline] = splitFlag(arg);
  if (!flag.startsWith("-")) {
    // Positional — everything non-flag accumulates into the question.
    questionParts.push(arg);
    return { next: i + 1 };
  }
  if (flag === "--cite") {
    opts.cite = true;
    return { next: i + 1 };
  }
  if (flag === "--json") {
    opts.json = true;
    return { next: i + 1 };
  }
  if (flag === "-h" || flag === "--help") return { error: "__help__" };
  const { value, next } = takeAskValue(args, i, inline);
  const assigned = assignAskValue(opts, flag, value);
  if ("error" in assigned) return assigned;
  return { next };
}

function parseAsk(args: string[]): AskOpts | { error: string } {
  const opts: AskOpts = {
    question: "",
    kb: undefined,
    via: undefined,
    model: undefined,
    topK: 3,
    collection: undefined,
    maxTokens: 2048,
    temperature: 0,
    systemPrompt: undefined,
    cite: false,
    json: false,
  };
  const questionParts: string[] = [];
  let i = 0;
  while (i < args.length) {
    const step = consumeAskArg(opts, questionParts, args, i);
    if ("error" in step) return step;
    i = step.next;
  }
  opts.question = questionParts.join(" ").trim();
  return opts;
}

/**
 * Resolve `--kb` when omitted: if the current kubeconfig context has
 * exactly one rag-kind node, pick it. Zero or 2+ is an explicit error
 * — operators must pass `--kb` to disambiguate, or to tell us there's
 * no rag node registered yet.
 */
function autoResolveKb(): { name: string } | { error: string } {
  const cfgPath = kubecfg.defaultConfigPath();
  const cfg = kubecfg.loadConfig(cfgPath);
  const ctx = kubecfg.currentContext(cfg);
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  const ragNodes = (cluster?.nodes ?? []).filter((n) => resolveNodeKind(n) === "rag");
  if (ragNodes.length === 1) return { name: required(ragNodes[0]).name };
  if (ragNodes.length === 0) {
    return {
      error:
        "rag ask: --kb is required — no rag nodes registered in the current context.\n" +
        "  hint: register one with 'llamactl node add-rag', or see 'llamactl node ls'.",
    };
  }
  const names = ragNodes.map((n) => n.name).join(", ");
  return {
    error:
      `rag ask: --kb is required — multiple rag nodes available (${names}).\n` +
      "  hint: pick one explicitly, e.g. --kb " +
      required(ragNodes[0]).name,
  };
}

/**
 * Shape the search results come back in — the tRPC procedure returns
 * `SearchResponse` from @nova/contracts, but we narrow to just the
 * fields we consume so the command doesn't depend on @nova types at
 * call sites.
 */
interface SearchResultShape {
  document: { id: string; content: string; metadata?: Record<string, unknown> };
  score: number;
  distance?: number;
}
interface SearchResponseShape {
  results: SearchResultShape[];
  collection: string;
}

/**
 * Shape of an unvalidated remote chat-completion payload. Every level is
 * optional on purpose: the response is cast straight from the wire, so a
 * misbehaving or version-skewed server may omit choices/message entirely.
 */
interface ChatResponseShape {
  choices?: {
    message?: { role?: string; content?: string | null | unknown[] };
    finish_reason?: string | null;
  }[];
  model?: string;
}

// Resolve --kb, either from the flag or by auto-picking the lone
// rag node in the current context.
function resolveKbName(kb: string | undefined): string | null {
  if (kb) return kb;
  const auto = autoResolveKb();
  if ("error" in auto) {
    process.stderr.write(`${auto.error}\n`);
    return null;
  }
  return auto.name;
}

// --- Step 1: retrieval ------------------------------------------------
async function fetchRetrieval(
  client: NodeClient,
  kbName: string,
  opts: AskOpts,
): Promise<SearchResponseShape | null> {
  try {
    const ragInput: {
      node: string;
      query: string;
      topK: number;
      collection?: string;
    } = { node: kbName, query: opts.question, topK: opts.topK };
    if (opts.collection) ragInput.collection = opts.collection;
    return await client.ragSearch.query(ragInput);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`rag ask: retrieval failed from '${kbName}': ${msg}\n`);
    if (/not a rag node|not found/i.test(msg)) {
      process.stderr.write("  hint: run 'llamactl node ls' to see registered nodes\n");
    }
    return null;
  }
}

// --- Steps 2 + 3: build the prompt, then chat completion ---------------
async function fetchChatAnswer(
  client: NodeClient,
  via: string,
  model: string,
  opts: AskOpts,
  retrieval: SearchResponseShape,
): Promise<ChatResponseShape | null> {
  const systemPrompt =
    opts.systemPrompt ??
    "Answer strictly from the provided context. If the answer isn't there, say \"I don't know.\" Be concise.";
  const contextBlock = retrieval.results
    .map((r, i) => `[${String(i + 1)}] ${r.document.content}`)
    .join("\n");
  const userPrompt = `Context:\n${contextBlock}\n\nQuestion: ${opts.question}`;

  try {
    return await client.chatComplete.mutate({
      node: via,
      request: {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`rag ask: chat completion failed via '${via}': ${msg}\n`);
    if (/not found/i.test(msg)) {
      process.stderr.write("  hint: run 'llamactl node ls' to see registered nodes\n");
    }
    return null;
  }
}

function extractAnswer(chat: ChatResponseShape): string {
  const rawAnswer = chat.choices?.[0]?.message?.content;
  const answer =
    // eslint-disable-next-line eqeqeq -- Preserve existing CLI/test semantics while clearing strict lint debt.
    typeof rawAnswer === "string" ? rawAnswer : rawAnswer == null ? "" : JSON.stringify(rawAnswer);
  return answer;
}

function printCitations(retrieval: SearchResponseShape, kbName: string): void {
  process.stdout.write(
    `Retrieved ${String(retrieval.results.length)} passage(s) from ${kbName}:\n`,
  );
  for (let i = 0; i < retrieval.results.length; i++) {
    const r = required(retrieval.results[i]);
    // Truncate long passages at ~240 chars for readability; full text
    // is available via --json.
    const content = r.document.content;
    const shown = content.length > 240 ? `${content.slice(0, 237)}…` : content;
    process.stdout.write(`  [${String(i + 1)}] ${shown}\n`);
  }
  process.stdout.write("\n");
}

// --- Step 4: render ---------------------------------------------------
function renderAskResult(
  opts: AskOpts,
  kbName: string,
  retrieval: SearchResponseShape,
  answer: string,
): void {
  if (opts.json) {
    const doc = {
      retrieval: {
        node: kbName,
        collection: retrieval.collection,
        results: retrieval.results,
      },
      answer,
      model: opts.model,
      via: opts.via,
    };
    process.stdout.write(`${JSON.stringify(doc)}\n`);
    return;
  }
  if (opts.cite) {
    printCitations(retrieval, kbName);
  }
  process.stdout.write(`${answer}\n`);
}

async function runAsk(args: string[]): Promise<number> {
  const parsed = parseAsk(args);
  if ("error" in parsed) {
    if (parsed.error === "__help__") {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const opts = parsed;

  if (!opts.question) {
    process.stderr.write("rag ask: <question> is required\n");
    return 1;
  }
  if (!opts.via) {
    process.stderr.write("rag ask: --via is required\n");
    return 1;
  }
  if (!opts.model) {
    process.stderr.write("rag ask: --model is required\n");
    return 1;
  }

  const kbName = resolveKbName(opts.kb);
  if (kbName === null) return 1;

  const client = resolveClient();
  const retrieval = await fetchRetrieval(client, kbName, opts);
  if (retrieval === null) return 1;

  const chat = await fetchChatAnswer(client, opts.via, opts.model, opts, retrieval);
  if (chat === null) return 1;

  renderAskResult(opts, kbName, retrieval, extractAnswer(chat));
  return 0;
}
