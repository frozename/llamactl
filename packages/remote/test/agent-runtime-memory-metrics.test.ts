// RED pins for frozename/llamactl#367: the agent publishes per-role runtime
// memory series — RSS, JS heap used/total, external and ArrayBuffer bytes —
// plus the configured memory budget and an over-budget flag, charging a
// single basis instead of summing process counters. The sampler, the runtime
// identity and the serve-option wiring do not exist at the pinned base;
// every case reaches them through namespace imports and optional-chained
// setters so a missing export fails by assertion, never by a link error.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import * as metricsModule from "../src/server/metrics.js";
import { startAgentServer } from "../src/server/serve.js";
import { sandboxOperatorStorage } from "./storage-sandbox.js";

const MiB = 1024 * 1024;

type AgentRuntimeMemorySample = {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
};

type AgentRuntimeIdentity = {
  role: string;
  memoryBudgetBytes?: number;
};

type RuntimeMemoryApi = {
  setModelHostMetricsNode?: (name: string | null) => void;
  setRuntimeMemorySampler?: (sampler: (() => AgentRuntimeMemorySample | null) | null) => void;
  setAgentRuntimeIdentity?: (identity: AgentRuntimeIdentity | null) => void;
};

function runtimeMemoryApi(): RuntimeMemoryApi {
  const ns: unknown = metricsModule;
  return ns as RuntimeMemoryApi;
}

const resetRuntimeMemory = (): void => {
  const api = runtimeMemoryApi();
  api.setModelHostMetricsNode?.(null);
  api.setRuntimeMemorySampler?.(null);
  api.setAgentRuntimeIdentity?.(null);
};

function memorySample(overrides: Partial<AgentRuntimeMemorySample> = {}): AgentRuntimeMemorySample {
  return {
    rss: 300 * MiB,
    heapUsed: 40 * MiB,
    heapTotal: 64 * MiB,
    external: 8 * MiB,
    arrayBuffers: 2 * MiB,
    ...overrides,
  };
}

function setSampler(sampler: () => AgentRuntimeMemorySample): void {
  const api = runtimeMemoryApi();
  expect(typeof api.setRuntimeMemorySampler).toBe("function");
  api.setRuntimeMemorySampler?.(sampler);
}

function setIdentity(identity: AgentRuntimeIdentity): void {
  const api = runtimeMemoryApi();
  expect(typeof api.setAgentRuntimeIdentity).toBe("function");
  api.setAgentRuntimeIdentity?.(identity);
}

describe("agent runtime memory metrics", () => {
  let tmp = "";
  let savedEnv: NodeJS.ProcessEnv = {};

  const scrape = (): Promise<string> => metricsModule.registry.metrics();

  beforeEach(() => {
    savedEnv = { ...process.env };
    tmp = mkdtempSync(join(tmpdir(), "llamactl-agent-runtime-memory-"));
    sandboxOperatorStorage(process.env, tmp);
    process.env["LLAMACTL_NODE_NAME"] = "mem-node";
    // Pins the profile so resolveEnv skips the sysctl memory probe.
    process.env["LLAMA_CPP_MACHINE_PROFILE"] = "balanced";
    resetRuntimeMemory();
  });

  afterEach(() => {
    resetRuntimeMemory();
    for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
    Object.assign(process.env, savedEnv);
    if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
  });

  test("exposes per-kind runtime memory bytes labelled by role and node", async () => {
    setSampler(() => memorySample());
    setIdentity({ role: "control" });

    const text = await scrape();
    expect(text).toMatch(
      /^llamactl_agent_runtime_memory_bytes\{(?=[^}]*role="control")(?=[^}]*node="mem-node")(?=[^}]*kind="rss")[^}]*\} 314572800$/m,
    );
    expect(text).toMatch(
      /^llamactl_agent_runtime_memory_bytes\{(?=[^}]*role="control")(?=[^}]*node="mem-node")(?=[^}]*kind="heap_used")[^}]*\} 41943040$/m,
    );
    expect(text).toMatch(
      /^llamactl_agent_runtime_memory_bytes\{(?=[^}]*role="control")(?=[^}]*node="mem-node")(?=[^}]*kind="heap_total")[^}]*\} 67108864$/m,
    );
    expect(text).toMatch(
      /^llamactl_agent_runtime_memory_bytes\{(?=[^}]*role="control")(?=[^}]*node="mem-node")(?=[^}]*kind="external")[^}]*\} 8388608$/m,
    );
    expect(text).toMatch(
      /^llamactl_agent_runtime_memory_bytes\{(?=[^}]*role="control")(?=[^}]*node="mem-node")(?=[^}]*kind="array_buffers")[^}]*\} 2097152$/m,
    );
  });

  test("defaults the role label to agent and emits no budget series without an identity", async () => {
    setSampler(() => memorySample());

    const text = await scrape();
    expect(text).toMatch(
      /^llamactl_agent_runtime_memory_bytes\{(?=[^}]*role="agent")(?=[^}]*node="mem-node")(?=[^}]*kind="rss")[^}]*\} 314572800$/m,
    );
    expect(text).not.toMatch(/^llamactl_agent_runtime_memory_budget_bytes\{/m);
  });

  test("emits the configured budget and flags an over-budget charge", async () => {
    setIdentity({ role: "control", memoryBudgetBytes: 256 * MiB });
    setSampler(() => memorySample({ rss: 300 * MiB }));

    let text = await scrape();
    expect(text).toMatch(
      /^llamactl_agent_runtime_memory_budget_bytes\{(?=[^}]*role="control")(?=[^}]*node="mem-node")[^}]*\} 268435456$/m,
    );
    expect(text).toMatch(
      /^llamactl_agent_runtime_memory_over_budget\{(?=[^}]*role="control")(?=[^}]*node="mem-node")[^}]*\} 1$/m,
    );

    setSampler(() => memorySample({ rss: 200 * MiB }));
    text = await scrape();
    expect(text).toMatch(
      /^llamactl_agent_runtime_memory_over_budget\{(?=[^}]*role="control")(?=[^}]*node="mem-node")[^}]*\} 0$/m,
    );
  });

  test("charges rss alone and never sums heap or external into the budget check", async () => {
    setIdentity({ role: "control", memoryBudgetBytes: 256 * MiB });
    setSampler(() => memorySample({ rss: 200 * MiB, heapUsed: 100 * MiB, external: 100 * MiB }));

    const text = await scrape();
    expect(text).toMatch(
      /^llamactl_agent_runtime_memory_over_budget\{(?=[^}]*role="control")(?=[^}]*node="mem-node")[^}]*\} 0$/m,
    );
  });

  test("drops the rss kind and the over-budget series when rss is not a finite byte count", async () => {
    setIdentity({ role: "control", memoryBudgetBytes: 256 * MiB });
    for (const rss of [Number.NaN, -1]) {
      setSampler(() => memorySample({ rss }));

      const text = await scrape();
      expect(text).not.toMatch(/^llamactl_agent_runtime_memory_bytes\{(?=[^}]*kind="rss")[^}]*\}/m);
      expect(text).not.toMatch(/^llamactl_agent_runtime_memory_over_budget\{/m);
      expect(text).toMatch(
        /^llamactl_agent_runtime_memory_bytes\{(?=[^}]*role="control")(?=[^}]*node="mem-node")(?=[^}]*kind="heap_used")[^}]*\} 41943040$/m,
      );
    }
  });

  test("startAgentServer wires runtimeRole and runtimeMemoryBudgetBytes into the metrics", async () => {
    const agent = startAgentServer({
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: "0".repeat(64),
      advertiseMdns: false,
      nodeName: "mem-node",
      runtimeRole: "control",
      runtimeMemoryBudgetBytes: 512 * MiB,
    });
    try {
      const text = await scrape();
      expect(text).toMatch(
        /^llamactl_agent_runtime_memory_bytes\{(?=[^}]*role="control")(?=[^}]*node="mem-node")(?=[^}]*kind="rss")[^}]*\} [0-9]+$/m,
      );
      expect(text).toMatch(
        /^llamactl_agent_runtime_memory_budget_bytes\{(?=[^}]*role="control")(?=[^}]*node="mem-node")[^}]*\} 536870912$/m,
      );
    } finally {
      await agent.stop();
    }
  });

  test("budget series stays present when Date.now() advances between rssReading.observedAtMs and options.nowMs", async () => {
    const originalNow = Date.now;
    let tick = 0;
    Date.now = (): number => (tick++ === 0 ? 1_000_000_000_000 : 1_000_000_000_001);
    try {
      setIdentity({ role: "control", memoryBudgetBytes: 256 * MiB });
      setSampler(() => memorySample({ rss: 200 * MiB }));

      const text = await scrape();
      expect(text).toMatch(
        /^llamactl_agent_runtime_memory_budget_bytes\{(?=[^}]*role="control")(?=[^}]*node="mem-node")[^}]*\} 268435456$/m,
      );
      expect(text).toMatch(
        /^llamactl_agent_runtime_memory_over_budget\{(?=[^}]*role="control")(?=[^}]*node="mem-node")[^}]*\} 0$/m,
      );
    } finally {
      Date.now = originalNow;
    }
  });
});
