// packages/app/e2e/harness/fixture-backend.ts — #410 P5b part 1.
// A tRPC router exposing exactly the CONSOLE_ALLOWLIST procedures over
// the seed fixtures, plus the controls the loopback control server
// uses to record calls per node, flip reachability, drive serverStop
// modes and open/drop/emit serverLogs streams. No real nodes, no real
// processes: every procedure answers from the seed, and the REAL
// console server (startConsoleServer) sits in front of this router.

import type { ClusterNode } from "@llamactl/core/config/schema";

import { resolveNodeKind } from "@llamactl/core/config/schema";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";

import * as seed from "./fixtures/seed.js";

export type ServerStopMode = "not-stopped" | "ok" | "throw";

export interface RecordedCall {
  input: unknown;
  node: string;
  procedure: string;
}

export interface StreamEntry {
  node: string;
  open: boolean;
  workload: string;
}

export interface FixtureControls {
  calls(node: string): RecordedCall[];
  drop(node: string, workload: string): void;
  emitLog(node: string, workload: string, line: string): void;
  reset(): void;
  setReachable(node: string, reachable: boolean): void;
  setServerStopMode(mode: ServerStopMode): void;
  streams(node: string): StreamEntry[];
}

export interface FixtureBackend {
  controls: FixtureControls;
  // Matches the test's structural check ({ _def: { procedures } });
  // buildConsoleRouter consumes it as `unknown` on the real path.
  router: { _def: { procedures: Record<string, unknown> } };
}

interface MutableStream {
  dropped: boolean;
  node: string;
  open: boolean;
  queue: string[];
  wake: (() => void) | null;
  workload: string;
}

interface WorkloadRow {
  endpoint: string | null;
  kind: "ModelRun";
  listenerPid: number | null;
  name: string;
  node: string;
  phase: "Running" | "Stopped";
  rel: string;
  statePid: number | null;
  status: seed.E2EModelRun["status"] | null;
  workerCount: number;
  workerNodes: string[];
}

// Mirrors the fixture kubeconfig nodes (P2b RED 9 sentinels in the
// cli env + the rag endpoint), shaped as the parsed ClusterNode output
// the real nodeList procedure returns before its projection.
const FIXTURE_NODES: readonly ClusterNode[] = [
  { endpoint: "inproc://local", name: "local" },
  {
    cli: [
      {
        advertisedModels: [],
        capabilities: ["reasoning"],
        env: { ANTHROPIC_API_KEY: seed.E2E_SENTINELS.cli },
        format: "text",
        name: "claude",
        preset: "claude",
        timeoutMs: 120_000,
      },
    ],
    endpoint: "https://agent-1.fixture:8443",
    kind: "agent",
    name: "agent-1",
  },
  { endpoint: "https://agent-off.fixture:8443", kind: "agent", name: "agent-off" },
  {
    cloud: { baseUrl: "http://gw-1.fixture:8080/v1", provider: "openai-compatible" },
    endpoint: "",
    kind: "gateway",
    name: "gw-1",
  },
  {
    endpoint: "",
    kind: "rag",
    name: "ragdb",
    rag: {
      endpoint: `postgres://rag:${seed.E2E_SENTINELS.pg}@db.local:5432/rag`,
      extraArgs: [],
      provider: "pgvector",
    },
  },
];

const t = initTRPC.context<{ node: string | null }>().create();

const nodeTestInput = z.object({ name: z.string().min(1) });
const statusInput = z.object({ workload: z.string().min(1) });
const describeInput = z.object({ name: z.string().min(1) });
const stopInput = z.object({
  graceSeconds: z.number().int().positive().max(60).optional(),
  workload: z.string().min(1),
});
const logsInput = z.object({
  follow: z.boolean().optional(),
  lines: z.number().int().min(0).max(1000).optional(),
  workload: z.string().min(1),
});

function statusRow(workload: string): seed.E2EServerStatus {
  const row = seed.E2E_SERVER_STATUS[workload];
  if (row === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message: "workload_not_found" });
  }
  return row;
}

function manifestOf(name: string): seed.E2EModelRun {
  const manifest = seed.E2E_MODEL_RUNS[name];
  if (manifest === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message: "workload_not_found" });
  }
  return manifest;
}

function rowFrom(manifest: seed.E2EModelRun): WorkloadRow {
  const status = seed.E2E_SERVER_STATUS[manifest.metadata.name];
  let phase: WorkloadRow["phase"] = "Stopped";
  let statePid: number | null = null;
  if (status?.state === "up" && !status.foreign) {
    phase = "Running";
    statePid = status.pid;
  }
  return {
    endpoint: status?.advertisedEndpoint ?? null,
    kind: "ModelRun",
    listenerPid: status?.listenerPid ?? null,
    name: manifest.metadata.name,
    node: manifest.spec.node,
    phase,
    rel: manifest.spec.target.value,
    statePid,
    status: manifest.status ?? null,
    workerCount: manifest.spec.workers.length,
    workerNodes: manifest.spec.workers.map((worker) => worker.node),
  };
}

async function nextLine(
  stream: MutableStream,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  for (;;) {
    const queued = stream.queue.shift();
    if (queued !== undefined) return queued;
    if (stream.dropped || (signal?.aborted ?? false)) return undefined;
    await new Promise<void>((resolve) => {
      stream.wake = resolve;
      signal?.addEventListener("abort", () => {
        resolve();
      });
    });
  }
}

class FixtureState {
  readonly #calls: RecordedCall[] = [];
  readonly #openStreams = new Set<MutableStream>();
  readonly #reachability = new Map<string, boolean>(
    seed.E2E_UNREACHABLE_NODES.map((node) => [node, false]),
  );
  #serverStopMode: ServerStopMode = "ok";

  record(procedure: string, node: string | null, input: unknown): void {
    this.#calls.push({ input, node: node ?? "", procedure });
  }

  reachable(node: string): boolean {
    return this.#reachability.get(node) ?? true;
  }

  get serverStopMode(): ServerStopMode {
    return this.#serverStopMode;
  }

  addStream(stream: MutableStream): void {
    this.#openStreams.add(stream);
  }

  removeStream(stream: MutableStream): void {
    this.#openStreams.delete(stream);
  }

  controls: FixtureControls = {
    calls: (node) => this.#calls.filter((call) => call.node === node),
    drop: (node, workload) => {
      for (const stream of this.#openStreams) {
        if (stream.node === node && stream.workload === workload) {
          stream.dropped = true;
          stream.wake?.();
        }
      }
    },
    emitLog: (node, workload, line) => {
      for (const stream of this.#openStreams) {
        if (stream.node === node && stream.workload === workload) {
          stream.queue.push(line);
          stream.wake?.();
        }
      }
    },
    reset: () => {
      this.#reachability.clear();
      for (const node of seed.E2E_UNREACHABLE_NODES) this.#reachability.set(node, false);
      this.#serverStopMode = "ok";
      this.#calls.length = 0;
      for (const stream of this.#openStreams) {
        stream.dropped = true;
        stream.wake?.();
      }
    },
    setReachable: (node, reachable) => {
      this.#reachability.set(node, reachable);
    },
    setServerStopMode: (mode) => {
      this.#serverStopMode = mode;
    },
    streams: (node) =>
      [...this.#openStreams]
        .filter((stream) => stream.node === node)
        .map(({ node: streamNode, open, workload }) => ({ node: streamNode, open, workload })),
  };
}

function buildFixtureRouter(state: FixtureState): FixtureBackend["router"] {
  const record = (procedure: string, node: string | null, input: unknown): void => {
    state.record(procedure, node, input);
  };
  return t.router({
    env: t.procedure.query(({ ctx }) => {
      record("env", ctx.node, undefined);
      return seed.E2E_ENV;
    }),

    nodeFacts: t.procedure.query(({ ctx }) => {
      record("nodeFacts", ctx.node, undefined);
      return seed.E2E_NODE_FACTS;
    }),

    nodeList: t.procedure.query(({ ctx }) => {
      record("nodeList", ctx.node, undefined);
      return {
        cluster: "home",
        context: "default",
        defaultNode: seed.E2E_DEFAULT_NODE,
        nodes: FIXTURE_NODES.map((node) => ({ ...node, effectiveKind: resolveNodeKind(node) })),
      };
    }),

    nodeTest: t.procedure.input(nodeTestInput).query(({ ctx, input }) => {
      record("nodeTest", ctx.node, input);
      if (!state.reachable(input.name)) {
        return { error: "e2e node unreachable", ok: false as const };
      }
      return { facts: seed.E2E_NODE_FACTS, ok: true as const };
    }),

    serverLogs: t.procedure.input(logsInput).subscription(async function* ({ ctx, input, signal }) {
      record("serverLogs", ctx.node, input);
      const stream: MutableStream = {
        dropped: false,
        node: ctx.node ?? "",
        open: true,
        queue: [seed.E2E_BOOT_LINE],
        wake: null,
        workload: input.workload,
      };
      state.addStream(stream);
      try {
        for (;;) {
          const line = await nextLine(stream, signal);
          if (line === undefined) return;
          yield { line, type: "line" } satisfies seed.E2ELogLineEvent;
        }
      } finally {
        stream.open = false;
        state.removeStream(stream);
      }
    }),

    serverStatus: t.procedure.input(statusInput).query(({ ctx, input }) => {
      record("serverStatus", ctx.node, input);
      return statusRow(input.workload);
    }),

    serverStop: t.procedure.input(stopInput).mutation(({ ctx, input }) => {
      record("serverStop", ctx.node, input);
      if (state.serverStopMode === "throw") {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "fixture_server_stop_failed",
        });
      }
      const stopped = state.serverStopMode === "ok";
      return { killed: false, pid: seed.E2E_PID, stopped };
    }),

    workloadDescribe: t.procedure.input(describeInput).query(({ ctx, input }) => {
      record("workloadDescribe", ctx.node, input);
      return {
        liveStatus: seed.E2E_SERVER_STATUS[input.name] ?? null,
        manifest: manifestOf(input.name),
      };
    }),

    workloadList: t.procedure.query(({ ctx }) => {
      record("workloadList", ctx.node, undefined);
      return Object.values(seed.E2E_MODEL_RUNS).map((manifest) => rowFrom(manifest));
    }),

    workloadsDir: t.procedure.query(({ ctx }) => {
      record("workloadsDir", ctx.node, undefined);
      return { dir: seed.E2E_WORKLOADS_DIR };
    }),
  });
}

export function createFixtureBackend(): FixtureBackend {
  const state = new FixtureState();
  return { controls: state.controls, router: buildFixtureRouter(state) };
}
