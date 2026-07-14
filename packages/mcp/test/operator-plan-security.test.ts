import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { buildMcpServer as getBuildMcpServer } from "../src/server.js";

const createOpenAICompatProviderCalls: {
  name: string;
  baseUrl: string;
  apiKey: string;
}[] = [];

const runPlannerCalls: {
  goal: string;
  context: string;
  tools: { name: string }[];
}[] = [];

const createOpenAICompatProviderMock = (
  ...rawArgs: unknown[]
): { name: string; baseUrl: string; apiKey: string } => {
  const options = rawArgs[0] as { name: string; baseUrl: string; apiKey: string };
  createOpenAICompatProviderCalls.push(options);
  return { name: options.name, baseUrl: options.baseUrl, apiKey: options.apiKey };
};

const runPlannerMock = (request: {
  goal: string;
  context: string;
  tools: { name: string }[];
  executor?: { kind: string };
}): {
  ok: true;
  plan: {
    steps: { tool: string; annotation: string; args: Record<string, never> }[];
    requiresConfirmation: false;
    reasoning: string;
  };
  toolsAvailable: string[];
  executor: "llm" | "stub";
} => {
  runPlannerCalls.push(request);
  const executor = request.executor?.kind === "stub" ? "stub" : "llm";
  return {
    ok: true,
    plan: {
      steps: [
        {
          tool: "nova.ops.overview",
          annotation: "noop",
          args: {},
        },
      ],
      requiresConfirmation: false,
      reasoning: "noop",
    },
    toolsAvailable: request.tools.map((tool) => tool.name),
    executor,
  };
};

let buildMcpServer: typeof getBuildMcpServer | null = null;

beforeAll(async () => {
  const novaContracts = await import("@nova/contracts");
  const novaMcp = await import("@nova/mcp");
  void mock.module(
    "@nova/contracts",
    (): { createOpenAICompatProvider: typeof createOpenAICompatProviderMock } => ({
      ...novaContracts,
      createOpenAICompatProvider: createOpenAICompatProviderMock,
    }),
  );
  void mock.module(
    "@nova/mcp",
    (): {
      computeCostSnapshot: () => { totalRequests: number };
      createLlmExecutor: (opts: { provider: unknown; model: string }) => {
        provider: unknown;
        model: string;
      };
      DEFAULT_ALLOWLIST: string[];
      runPlanner: typeof runPlannerMock;
      stubPlannerExecutor: { kind: string };
    } => ({
      ...novaMcp,
      computeCostSnapshot: () => ({ totalRequests: 0 }),
      createLlmExecutor: (opts: { provider: unknown; model: string }) => ({
        provider: opts.provider,
        model: opts.model,
      }),
      DEFAULT_ALLOWLIST: ["llamactl.*"],
      runPlanner: runPlannerMock,
      stubPlannerExecutor: { kind: "stub" },
    }),
  );
  ({ buildMcpServer } = await import("../src/server.js"));
});

afterAll(() => {
  mock.restore();
});

const originalEnv = { ...process.env };

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
  return content[0]?.text ?? "";
}

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    Reflect.deleteProperty(process.env, key);
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

async function connected(): Promise<Client> {
  const server = buildMcpServer!({ name: "llamactl-test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("llamactl.operator.plan mode=llm security hardening", () => {
  beforeEach(() => {
    restoreEnv();
    process.env["OPENAI_API_KEY"] = "openai-test-key";
    createOpenAICompatProviderCalls.length = 0;
    runPlannerCalls.length = 0;
  });

  afterEach(() => {
    restoreEnv();
  });

  test("rejects non-HTTPS baseUrl with config error and no provider construction", async () => {
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.operator.plan",
      arguments: {
        goal: "list catalog",
        mode: "llm",
        model: "gpt-4o-mini",
        baseUrl: "http://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    });

    const parsed = JSON.parse(textOf(result)) as { ok: boolean; reason?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("config");
    expect(createOpenAICompatProviderCalls).toHaveLength(0);
    expect(runPlannerCalls).toHaveLength(0);
  });

  test("rejects HTTPS non-allowlisted host with config error and no provider construction", async () => {
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.operator.plan",
      arguments: {
        goal: "list catalog",
        mode: "llm",
        model: "gpt-4o-mini",
        baseUrl: "https://attacker.example/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    });

    const parsed = JSON.parse(textOf(result)) as { ok: boolean; reason?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("config");
    expect(createOpenAICompatProviderCalls).toHaveLength(0);
    expect(runPlannerCalls).toHaveLength(0);
  });

  test("rejects apiKeyEnv outside allowlist and never constructs a provider", async () => {
    process.env["AWS_SECRET_ACCESS_KEY"] = "aws-secret";
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.operator.plan",
      arguments: {
        goal: "list catalog",
        mode: "llm",
        model: "gpt-4o-mini",
        apiKeyEnv: "AWS_SECRET_ACCESS_KEY",
      },
    });

    const parsed = JSON.parse(textOf(result)) as { ok: boolean; reason?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("config");
    expect(createOpenAICompatProviderCalls).toHaveLength(0);
    expect(runPlannerCalls).toHaveLength(0);
  });

  test("accepts default host + OPENAI_API_KEY and constructs OpenAI-compatible provider", async () => {
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.operator.plan",
      arguments: {
        goal: "list catalog",
        mode: "llm",
        model: "gpt-4o-mini",
      },
    });

    const parsed = JSON.parse(textOf(result)) as { ok: boolean; executor?: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.executor).toBe("llm");
    expect(createOpenAICompatProviderCalls).toHaveLength(1);
    const firstCall = createOpenAICompatProviderCalls[0]!;
    expect(firstCall.baseUrl).toBe("https://api.openai.com/v1");
    expect(firstCall.apiKey).toBe("openai-test-key");
    expect(runPlannerCalls).toHaveLength(1);
  });
});
