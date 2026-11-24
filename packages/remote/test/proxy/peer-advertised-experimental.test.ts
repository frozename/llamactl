import type { PeerNode } from "@llamactl/core/config/peers";
import type { ResolvedEnv } from "@llamactl/core/types";
import type { LocalRoute, PeerSnapshot } from "@llamactl/core/workloadRuntime";

import { resolveEnv } from "@llamactl/core/env";
/**
 * #518 (a) — peer-advertised experimental stage end to end. The peer
 * snapshot is built by running a buildLocalRoutesSnapshot payload through
 * fetchPeerSnapshot (never hand-written labels), so these pins fail if
 * either the producer drops the label or the forwarder drops it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type BackendExecutor,
  type BackendExecutorDescription,
  createProxy,
} from "../../src/proxy/create-proxy.js";
import { buildLocalRoutesSnapshot } from "../../src/routes/fleet.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { __peerSnapshotInternals } from "../../src/server/peer-snapshot-poller.js";

const originalFetch = globalThis.fetch;
const NOW = new Date("2026-11-23T12:00:00.000Z");

interface Fixture {
  sandbox: string;
  runtimeDir: string;
  catalogFile: string;
}

let fixture: Fixture | undefined;
let savedOverridesFile: string | undefined;

function fx(): Fixture {
  if (fixture === undefined) throw new Error("peer-advertised fixture not started");
  return fixture;
}

const PEER: PeerNode = { id: "peer-z", endpoint: "https://127.0.0.1:7843", token: "tok" };

function resolvedFor(extra: Record<string, string>, catalogFile?: string): ResolvedEnv {
  const f = fx();
  return resolveEnv({
    DEV_STORAGE: join(f.sandbox, "dev-storage"),
    LOCAL_AI_RUNTIME_DIR: f.runtimeDir,
    LOCAL_AI_CUSTOM_CATALOG_FILE: catalogFile ?? f.catalogFile,
    LLAMA_CPP_HOST: "127.0.0.1",
    LLAMA_CPP_PORT: "1",
    LLAMA_CPP_MACHINE_PROFILE: "balanced",
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "/tmp",
    ...extra,
  });
}

function route(over: Partial<LocalRoute> & Pick<LocalRoute, "model" | "workload">): LocalRoute {
  return {
    host: "127.0.0.1",
    port: 8080,
    engine: "omlx",
    kind: "ModelHost",
    pid: 4242,
    ...over,
  };
}

/** Run buildLocalRoutesSnapshot output through the fetch stub into fetchPeerSnapshot. */
async function peerSnapshotFromRoutes(
  routes: LocalRoute[],
  peer: PeerNode = PEER,
): Promise<Map<string, PeerSnapshot>> {
  const payload = buildLocalRoutesSnapshot(routes, (): string => "rev-1", NOW);
  if (payload === null) throw new Error("expected a local-routes snapshot");
  globalThis.fetch = ((_input: Request | string | URL, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;
  const snap = await __peerSnapshotInternals.fetchPeerSnapshot(peer, Date.now());
  if (snap === null) throw new Error("expected a peer snapshot");
  return new Map([[peer.id, snap]]);
}

function experimentalAliasPeerSnapshots(): Promise<Map<string, PeerSnapshot>> {
  return peerSnapshotFromRoutes([
    route({
      workload: "glm-host",
      model: "glm-alias",
      qualificationStage: "experimental",
    }),
    route({
      workload: "glm-host",
      model: "org/glm.gguf",
      qualificationStage: "experimental",
    }),
  ]);
}

function validatedOrgPeerSnapshots(): Promise<Map<string, PeerSnapshot>> {
  return peerSnapshotFromRoutes([
    route({ workload: "glm-host", model: "org/glm.gguf", qualificationStage: "validated" }),
  ]);
}

function chatReq(body: Record<string, unknown>): Request {
  return new Request("http://agent.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function recordingExecutor(id: string, calls: string[] = []): BackendExecutor {
  return {
    describe: (): BackendExecutorDescription => ({
      id,
      backendKinds: [],
      transports: [],
    }),
    execute: (envelope): Promise<Response> => {
      calls.push(envelope.publicModelId);
      return Promise.resolve(Response.json({ ok: true, executor: id }));
    },
    cancel: (): boolean => false,
    drain: (): Promise<void> => Promise.resolve(),
    close: (): Promise<void> => Promise.resolve(),
  };
}

interface UnifiedOutcome {
  status: number;
  servedBy: string;
  defaultCalls: string[];
}

async function unifiedServe(
  resolved: ResolvedEnv,
  peerSnapshots: Map<string, PeerSnapshot>,
  body: Record<string, unknown>,
  acquired: string[] = [],
): Promise<UnifiedOutcome> {
  const defaultCalls: string[] = [];
  const proxy = createProxy({
    env: { LLAMACTL_UNIFIED_PROXY: "1" },
    resolved: () => resolved,
    peers: [PEER],
    peerSnapshots,
    executor: recordingExecutor("default", defaultCalls),
    acquireExecutor: (candidate) => {
      const owner = candidate.advertisement.ownerNodeId;
      acquired.push(owner);
      return recordingExecutor(owner);
    },
  });
  const response = await proxy.handleRequest(chatReq(body));
  expect(response.status).toBe(200);
  const servedBy = defaultCalls.length > 0 ? "default" : (acquired.at(-1) ?? "unrouted");
  return { status: response.status, servedBy, defaultCalls };
}

beforeAll(() => {
  const sandbox = mkdtempSync(join(tmpdir(), "llamactl-peer-advertised-"));
  savedOverridesFile = process.env["LOCAL_AI_QUALIFICATION_OVERRIDES_FILE"];
  process.env["LOCAL_AI_QUALIFICATION_OVERRIDES_FILE"] = join(sandbox, "absent-overrides.tsv");
  const runtimeDir = join(sandbox, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const catalogFile = join(sandbox, "custom-catalog.tsv");
  writeFileSync(catalogFile, "");
  fixture = { sandbox, runtimeDir, catalogFile };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  try {
    if (fixture === undefined) return;
    rmSync(fixture.sandbox, { recursive: true, force: true });
  } finally {
    if (savedOverridesFile === undefined) {
      Reflect.deleteProperty(process.env, "LOCAL_AI_QUALIFICATION_OVERRIDES_FILE");
    } else {
      process.env["LOCAL_AI_QUALIFICATION_OVERRIDES_FILE"] = savedOverridesFile;
    }
    fixture = undefined;
  }
});

describe("unified proxy peer-advertised experimental stage (#518)", () => {
  test("U1: a peer-advertised experimental alias never captures a default-target id", async () => {
    // Kills: the label not produced (buildLocalRoutesSnapshot) or not
    // forwarded (collectPeerWorkloads) — on base the unlabeled peer route
    // is eligible and captures the default-target request.
    const peerSnapshots = await experimentalAliasPeerSnapshots();
    const acquired: string[] = [];
    const outcome = await unifiedServe(
      resolvedFor({ LLAMA_CPP_SERVER_ALIAS: "glm-alias" }),
      peerSnapshots,
      { model: "glm-alias" },
      acquired,
    );
    expect(outcome.servedBy).toBe("default");
    expect(acquired).not.toContain("peer-z");
  });

  test("U2: an exact pin still reaches the experimental peer", async () => {
    // Guard: pinned selection keeps the experimental candidate eligible —
    // dropping experimental even for pins flips servedBy to default.
    const peerSnapshots = await experimentalAliasPeerSnapshots();
    const acquired: string[] = [];
    const outcome = await unifiedServe(
      resolvedFor({}),
      peerSnapshots,
      { model: "glm-alias" },
      acquired,
    );
    expect(outcome.servedBy).toBe("peer-z");
    expect(acquired).toEqual(["peer-z"]);
  });

  test("U3: an unlabelled peer route keeps the local experimental stage", async () => {
    // Guard: a peer 'validated' stage produces no label, so stageByModel
    // inheritance still marks the route experimental — a peer never lifts
    // a local experimental stage. Kills: forwarding any non-experimental
    // peer stage as a label.
    const f = fx();
    const catalogFile = join(f.sandbox, "u3-catalog.tsv");
    writeFileSync(
      catalogFile,
      'glm-org\tGLM org\tglm\tcustom\tcustom\torg/glm.gguf\torg/glm\tgguf\t{"qualification":{"stage":"experimental"}}\n',
    );
    const peerSnapshots = await validatedOrgPeerSnapshots();
    const acquired: string[] = [];
    const outcome = await unifiedServe(
      resolvedFor({ LLAMA_CPP_DEFAULT_MODEL: "org/glm.gguf" }, catalogFile),
      peerSnapshots,
      { model: "org/glm.gguf" },
      acquired,
    );
    expect(outcome.servedBy).toBe("default");
    expect(acquired).not.toContain("peer-z");
  });
});
