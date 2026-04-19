import { createDefaultToolClient } from '@llamactl/agents';
import {
  DEFAULT_ALLOWLIST,
  createLlmExecutor,
  runPlanner,
  stubPlannerExecutor,
  type PlannerExecutor,
  type Plan,
} from '@nova/mcp';
import { createOpenAICompatProvider } from '@nova/contracts';

const USAGE = `llamactl plan — LLM-backed operator planner

USAGE:
  llamactl plan run "<goal>" [--stub] [--auto] [--json] [--context=<text>]
                             [--model=<id>] [--base-url=<url>]
                             [--api-key-env=<var>]

Translates a natural-language operational goal into a validated
sequence of MCP tool calls. The planner sees the current
@llamactl/mcp + @nova/mcp catalog filtered by the default
allowlist (destructive mutations gated off by default). A stub
executor is available for smoke testing without hitting a real
model.

This slice emits the plan but does NOT execute it. Plan-execution
(dry-run cascade, per-step confirmation) lands in the next sprint.
For now, --auto suppresses interactive confirmation; without it
the plan prints and waits for y/n on stdin.

FLAGS:
  --stub                Use the canned stub executor; no model call.
                        Exercises the full pipeline shape.
  --auto                Skip the y/n confirmation prompt.
  --json                Print the plan as JSON on stdout (for piping
                        into the future \`llamactl plan apply\`).
  --context=<text>      Extra fleet context appended to the prompt's
                        FLEET CONTEXT section.
  --model=<id>          Model id the provider serves (e.g. gpt-4o).
                        Required unless --stub.
  --base-url=<url>      OpenAI-compatible endpoint. Default:
                        https://api.openai.com/v1.
  --api-key-env=<var>   Environment variable holding the API key.
                        Default: OPENAI_API_KEY. Falsy env var is
                        fatal unless --stub.

EXAMPLES:
  llamactl plan run "list every multimodal model" --stub
  llamactl plan run "promote the fastest vision model" --model=gpt-4o --auto
  llamactl plan run "snapshot spend" --json --stub
`;

interface RunFlags {
  goal: string;
  stub: boolean;
  auto: boolean;
  json: boolean;
  context: string;
  model: string | null;
  baseUrl: string;
  apiKeyEnv: string;
}

type ParseResult =
  | { kind: 'ok'; flags: RunFlags }
  | { kind: 'help' }
  | { kind: 'error' };

function parseRunFlags(argv: string[]): ParseResult {
  const flags: RunFlags = {
    goal: '',
    stub: false,
    auto: false,
    json: false,
    context: '',
    model: null,
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
  };
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return { kind: 'help' };
    }
    if (arg === '--stub') { flags.stub = true; continue; }
    if (arg === '--auto') { flags.auto = true; continue; }
    if (arg === '--json') { flags.json = true; continue; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq < 0) {
        process.stderr.write(`plan run: flag ${arg} requires a value (--key=value)\n`);
        return { kind: 'error' };
      }
      const key = arg.slice(2, eq);
      const value = arg.slice(eq + 1);
      switch (key) {
        case 'context': flags.context = value; break;
        case 'model': flags.model = value; break;
        case 'base-url': flags.baseUrl = value; break;
        case 'api-key-env': flags.apiKeyEnv = value; break;
        default:
          process.stderr.write(`plan run: unknown flag --${key}\n\n${USAGE}`);
          return { kind: 'error' };
      }
      continue;
    }
    positional.push(arg);
  }
  if (positional.length === 0) {
    process.stderr.write(`plan run: goal is required\n\n${USAGE}`);
    return { kind: 'error' };
  }
  flags.goal = positional.join(' ');
  return { kind: 'ok', flags };
}

function buildExecutor(flags: RunFlags): PlannerExecutor | { error: string } {
  if (flags.stub) return stubPlannerExecutor;
  if (!flags.model) {
    return { error: 'plan run: --model is required unless --stub is set' };
  }
  const apiKey = process.env[flags.apiKeyEnv];
  if (!apiKey) {
    return {
      error: `plan run: env var ${flags.apiKeyEnv} is empty — set it or pass --stub`,
    };
  }
  const provider = createOpenAICompatProvider({
    name: 'planner-llm',
    baseUrl: flags.baseUrl,
    apiKey,
  });
  return createLlmExecutor({ provider, model: flags.model });
}

async function confirm(prompt: string): Promise<boolean> {
  process.stderr.write(`${prompt} [y/N] `);
  const line = await new Promise<string>((resolve) => {
    const chunks: string[] = [];
    const onData = (buf: Buffer | string): void => {
      chunks.push(typeof buf === 'string' ? buf : buf.toString('utf8'));
      const joined = chunks.join('');
      if (joined.includes('\n')) {
        process.stdin.off('data', onData);
        process.stdin.pause();
        resolve(joined.split('\n')[0]!);
      }
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
  return /^\s*y/i.test(line);
}

function renderPlan(plan: Plan, toolsAvailable: string[], executor: string): string {
  const lines: string[] = [];
  lines.push(`executor: ${executor}`);
  lines.push(`tools (allowlisted): ${toolsAvailable.length}`);
  lines.push(`requires confirmation: ${plan.requiresConfirmation}`);
  lines.push(`reasoning: ${plan.reasoning}`);
  lines.push(`steps (${plan.steps.length}):`);
  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i]!;
    const dryRun = s.dryRun === true ? ' [dry-run]' : '';
    lines.push(`  ${i + 1}. ${s.tool}${dryRun}`);
    lines.push(`     ${s.annotation}`);
    if (s.args && Object.keys(s.args).length > 0) {
      lines.push(`     args: ${JSON.stringify(s.args)}`);
    }
  }
  return lines.join('\n') + '\n';
}

async function runPlanRun(argv: string[]): Promise<number> {
  const parsed = parseRunFlags(argv);
  if (parsed.kind === 'help') return 0;
  if (parsed.kind === 'error') return 1;
  const { flags } = parsed;

  const executor = buildExecutor(flags);
  if ('error' in executor) {
    process.stderr.write(`${executor.error}\n`);
    return 1;
  }

  const { client: _client, listPlannerTools, dispose } = await createDefaultToolClient();
  try {
    const tools = await listPlannerTools();
    const result = await runPlanner({
      goal: flags.goal,
      context: flags.context,
      tools,
      executor,
      allowlist: DEFAULT_ALLOWLIST,
    });
    if (!result.ok) {
      process.stderr.write(
        `plan run: ${result.reason} — ${result.message}\n`,
      );
      return 1;
    }
    if (flags.json) {
      process.stdout.write(
        JSON.stringify(
          {
            executor: result.executor,
            toolsAvailable: result.toolsAvailable,
            plan: result.plan,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stderr.write(
        renderPlan(result.plan, result.toolsAvailable, result.executor),
      );
    }
    if (!flags.auto && result.plan.requiresConfirmation) {
      const approved = await confirm('Approve this plan?');
      if (!approved) {
        process.stderr.write('plan run: declined by operator\n');
        return 2;
      }
    }
    process.stderr.write(
      'plan run: approved (execution lands in a future slice — no tools were called)\n',
    );
    return 0;
  } finally {
    await dispose();
  }
}

export async function runPlan(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'run':
      return runPlanRun(rest);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`plan: unknown subcommand ${sub}\n\n${USAGE}`);
      return 1;
  }
}
