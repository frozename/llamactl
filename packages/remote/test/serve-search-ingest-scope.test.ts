/**
 * #634 RED: agent-scoped search-ingest lifecycle. Each startAgentServer
 * boots its own search ingest; the per-agent stop handle — not the
 * process-wide stopSearchIngest() — must be what startup rollback and
 * stop() invoke, so one agent's teardown never disturbs another's.
 * `live` counts sessionEventBus.subscribeAll calls (one per sessions
 * ingest) through a spy installed in beforeAll.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { envForTemp, makeTempRuntime } from "../../core/test/helpers.js";
import { sessionEventBus } from "../src/ops-chat/sessions/event-bus.js";
import { writeFileSync } from "../src/safe-fs.js";
import { stopSearchIngest } from "../src/search/ingest/lifecycle.js";
import { generateToken } from "../src/server/auth.js";
import {
  type RunningAgent,
  type StartAgentOptions,
  startAgentServer,
} from "../src/server/serve.js";

const ENV_KEYS = ["DEV_STORAGE", "LOCAL_AI_RUNTIME_DIR", "LLAMACTL_CONFIG"] as const;

let temp: ReturnType<typeof makeTempRuntime>;
let live = 0;
let restoreLiveCounter: (() => void) | null = null;
const envBackup: Record<string, string | undefined> = {};
const agents: RunningAgent[] = [];

function installLiveIngestCounter(): () => void {
  // subscribeAll is only reached through startSessionsIngest, so one live
  // subscription equals one running search ingest. The rag node name is
  // unique per run: a stray sink call resolving it against a restored
  // operator config throws inside resolveRagNode and is swallowed by the
  // ingest loops, so the operator's real KB can never receive a write.
  const realSubscribeAll = sessionEventBus.subscribeAll.bind(sessionEventBus);
  const spy = spyOn(sessionEventBus, "subscribeAll").mockImplementation((listener) => {
    const off = realSubscribeAll(listener);
    live += 1;
    let done = false;
    return (): void => {
      if (!done) {
        done = true;
        live -= 1;
      }
      off();
    };
  });
  return () => {
    spy.mockRestore();
  };
}

function startAgent(options: StartAgentOptions): RunningAgent {
  // Snapshot the fatal handlers before the start: at base a failed
  // startAgentServer leaves the pair it installed behind (#633), so drop
  // whatever this call added before rethrowing.
  const uncaught = process.listeners("uncaughtException");
  const unhandled = process.listeners("unhandledRejection");
  try {
    const agent = startAgentServer(options);
    agents.push(agent);
    return agent;
  } catch (err) {
    for (const listener of process.listeners("uncaughtException")) {
      if (!uncaught.includes(listener)) {
        process.off("uncaughtException", listener as () => void);
      }
    }
    for (const listener of process.listeners("unhandledRejection")) {
      if (!unhandled.includes(listener)) {
        process.off("unhandledRejection", listener as () => void);
      }
    }
    throw err;
  }
}

function agentOptions(): StartAgentOptions {
  return {
    tokenHash: generateToken().hash,
    bindHost: "127.0.0.1",
    port: 0,
    advertiseMdns: false,
  };
}

beforeAll(() => {
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  temp = makeTempRuntime();
  const tempEnv = envForTemp(temp);
  process.env["DEV_STORAGE"] = tempEnv["DEV_STORAGE"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = tempEnv["LOCAL_AI_RUNTIME_DIR"];
  const ragName = `kb-test-${randomUUID()}`;
  const configPath = join(temp.devStorage, "llamactl-config.json");
  process.env["LLAMACTL_CONFIG"] = configPath;
  writeFileSync(
    configPath,
    JSON.stringify({
      apiVersion: "llamactl/v1",
      kind: "Config",
      currentContext: "local",
      contexts: [{ name: "local", cluster: "local", user: "local" }],
      clusters: [
        {
          name: "local",
          nodes: [
            { name: "local", kind: "agent", endpoint: "inproc://local" },
            {
              name: ragName,
              kind: "rag",
              rag: {
                provider: "pgvector",
                endpoint: "postgres://kb@127.0.0.1:1/kb",
                collection: "docs",
              },
            },
          ],
        },
      ],
    }),
  );
  restoreLiveCounter = installLiveIngestCounter();
});

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    await agent.stop();
  }
  stopSearchIngest();
});

afterAll(async () => {
  try {
    for (const agent of agents.splice(0)) {
      await agent.stop();
    }
    stopSearchIngest();
    // In-flight sink promises settle against the temp config before the
    // env and the spy come down.
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    restoreLiveCounter?.();
    restoreLiveCounter = null;
    for (const key of ENV_KEYS) {
      const prev = envBackup[key];
      if (prev === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = prev;
    }
    temp.cleanup();
  }
});

describe("agent search-ingest scope (#634)", () => {
  /**
   * Kills: dropping the stopOwnIngest call from the startup rollback —
   * the failed agent's ingest leaks (live stays 2). Replacing that call
   * with the process-wide stopSearchIngest() is also killed: live would
   * be 0 before a1.stop().
   */
  test("a second agent that fails at bind stops its own ingest and leaves the first agent's running", async () => {
    const a1 = startAgent(agentOptions());
    expect(live).toBe(1);

    const missingId = randomUUID();
    const failing: StartAgentOptions = {
      ...agentOptions(),
      tls: {
        certPath: join(tmpdir(), `llamactl-missing-${missingId}.crt`),
        keyPath: join(tmpdir(), `llamactl-missing-${missingId}.key`),
      },
    };
    expect(() => startAgent(failing)).toThrow("cert not found");
    expect(live).toBe(1);

    agents.splice(agents.indexOf(a1), 1);
    await a1.stop();
    expect(live).toBe(0);
  });

  /**
   * Kills: stop() calling the process-wide stopSearchIngest() instead of
   * the agent's own handle — stopping a2 would drop a1's ingest too
   * (live would be 0, not 1).
   */
  test("stopping one agent does not stop another agent's ingest", async () => {
    const a1 = startAgent(agentOptions());
    const a2 = startAgent(agentOptions());
    expect(live).toBe(2);

    agents.splice(agents.indexOf(a2), 1);
    await a2.stop();
    expect(live).toBe(1);

    agents.splice(agents.indexOf(a1), 1);
    await a1.stop();
    expect(live).toBe(0);
  });
});
