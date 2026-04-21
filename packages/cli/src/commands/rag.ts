import type { NodeClient } from '@llamactl/remote';
import { config as kubecfg, resolveNodeKind } from '@llamactl/remote';
import { getNodeClient } from '../dispatcher.js';

const USAGE = `Usage: llamactl rag <subcommand>

Subcommands:
  ask <question> --kb <node> --via <node> --model <id> [flags]
      Retrieve top-k passages from the named RAG node and route a
      chat completion through the named gateway / cloud / agent node
      using the provided model id.

  pipeline <sub>            Apply + run declarative RAG ingestion
                            pipelines. See 'llamactl rag pipeline -h'.

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
    case 'ask':
      return runAsk(rest);
    case 'pipeline': {
      const { runRagPipeline } = await import('./rag-pipeline.js');
      return runRagPipeline(rest);
    }
    case undefined:
    case '--help':
    case '-h':
    case 'help':
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
  const eq = arg.indexOf('=');
  if (eq < 0) return [arg, undefined];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

function parseAsk(args: string[]): AskOpts | { error: string } {
  const opts: AskOpts = {
    question: '',
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

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const [flag, inline] = splitFlag(arg);
    const takeValue = (): string | undefined =>
      inline ?? (i + 1 < args.length ? args[++i] : undefined);
    if (!flag.startsWith('-')) {
      // Positional — everything non-flag accumulates into the question.
      questionParts.push(arg);
      continue;
    }
    switch (flag) {
      case '--kb':
        opts.kb = takeValue();
        break;
      case '--via':
        opts.via = takeValue();
        break;
      case '--model':
        opts.model = takeValue();
        break;
      case '--top-k': {
        const raw = takeValue();
        const n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
          return {
            error: `rag ask: --top-k must be a positive integer (got ${raw ?? '<empty>'})`,
          };
        }
        opts.topK = n;
        break;
      }
      case '--collection':
        opts.collection = takeValue();
        break;
      case '--max-tokens': {
        const raw = takeValue();
        const n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
          return {
            error: `rag ask: --max-tokens must be a positive integer (got ${raw ?? '<empty>'})`,
          };
        }
        opts.maxTokens = n;
        break;
      }
      case '--temperature': {
        const raw = takeValue();
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          return {
            error: `rag ask: --temperature must be a non-negative number (got ${raw ?? '<empty>'})`,
          };
        }
        opts.temperature = n;
        break;
      }
      case '--system-prompt':
        opts.systemPrompt = takeValue();
        break;
      case '--cite':
        opts.cite = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '-h':
      case '--help':
        return { error: '__help__' };
      default:
        return { error: `rag ask: unknown flag ${flag}` };
    }
  }

  opts.question = questionParts.join(' ').trim();
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
  const ragNodes = (cluster?.nodes ?? []).filter(
    (n) => resolveNodeKind(n) === 'rag',
  );
  if (ragNodes.length === 1) return { name: ragNodes[0]!.name };
  if (ragNodes.length === 0) {
    return {
      error:
        "rag ask: --kb is required — no rag nodes registered in the current context.\n" +
        "  hint: register one with 'llamactl node add-rag', or see 'llamactl node ls'.",
    };
  }
  const names = ragNodes.map((n) => n.name).join(', ');
  return {
    error:
      `rag ask: --kb is required — multiple rag nodes available (${names}).\n` +
      "  hint: pick one explicitly, e.g. --kb " +
      `${ragNodes[0]!.name}`,
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

interface ChatResponseShape {
  choices: Array<{
    message: { role: string; content: string | null | unknown[] };
    finish_reason?: string | null;
  }>;
  model?: string;
}

async function runAsk(args: string[]): Promise<number> {
  const parsed = parseAsk(args);
  if ('error' in parsed) {
    if (parsed.error === '__help__') {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const opts = parsed;

  if (!opts.question) {
    process.stderr.write('rag ask: <question> is required\n');
    return 1;
  }
  if (!opts.via) {
    process.stderr.write('rag ask: --via is required\n');
    return 1;
  }
  if (!opts.model) {
    process.stderr.write('rag ask: --model is required\n');
    return 1;
  }

  // Resolve --kb, either from the flag or by auto-picking the lone
  // rag node in the current context.
  let kbName: string;
  if (opts.kb) {
    kbName = opts.kb;
  } else {
    const auto = autoResolveKb();
    if ('error' in auto) {
      process.stderr.write(`${auto.error}\n`);
      return 1;
    }
    kbName = auto.name;
  }

  const client = resolveClient();

  // --- Step 1: retrieval ------------------------------------------------
  let retrieval: SearchResponseShape;
  try {
    const ragInput: {
      node: string;
      query: string;
      topK: number;
      collection?: string;
    } = { node: kbName, query: opts.question, topK: opts.topK };
    if (opts.collection) ragInput.collection = opts.collection;
    retrieval = (await client.ragSearch.query(ragInput)) as SearchResponseShape;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    process.stderr.write(`rag ask: retrieval failed from '${kbName}': ${msg}\n`);
    if (/not a rag node|not found/i.test(msg)) {
      process.stderr.write("  hint: run 'llamactl node ls' to see registered nodes\n");
    }
    return 1;
  }

  // --- Step 2: build the prompt ----------------------------------------
  const systemPrompt =
    opts.systemPrompt ??
    'Answer strictly from the provided context. If the answer isn\'t there, say "I don\'t know." Be concise.';
  const contextBlock = retrieval.results
    .map((r, i) => `[${i + 1}] ${r.document.content}`)
    .join('\n');
  const userPrompt = `Context:\n${contextBlock}\n\nQuestion: ${opts.question}`;

  // --- Step 3: chat completion -----------------------------------------
  let chat: ChatResponseShape;
  try {
    chat = (await client.chatComplete.mutate({
      node: opts.via,
      request: {
        model: opts.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
      },
    })) as ChatResponseShape;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    process.stderr.write(`rag ask: chat completion failed via '${opts.via}': ${msg}\n`);
    if (/not found/i.test(msg)) {
      process.stderr.write("  hint: run 'llamactl node ls' to see registered nodes\n");
    }
    return 1;
  }

  const rawAnswer = chat.choices?.[0]?.message?.content;
  const answer =
    typeof rawAnswer === 'string'
      ? rawAnswer
      : rawAnswer == null
        ? ''
        : JSON.stringify(rawAnswer);

  // --- Step 4: render ---------------------------------------------------
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
    return 0;
  }

  if (opts.cite) {
    process.stdout.write(
      `Retrieved ${retrieval.results.length} passage(s) from ${kbName}:\n`,
    );
    for (let i = 0; i < retrieval.results.length; i++) {
      const r = retrieval.results[i]!;
      // Truncate long passages at ~240 chars for readability; full text
      // is available via --json.
      const content = r.document.content;
      const shown =
        content.length > 240 ? `${content.slice(0, 237)}…` : content;
      process.stdout.write(`  [${i + 1}] ${shown}\n`);
    }
    process.stdout.write('\n');
  }

  process.stdout.write(`${answer}\n`);
  return 0;
}
