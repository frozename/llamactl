import { openaiProxy } from "@llamactl/core";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

import { router } from "../src/router.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { generateToken } from "../src/server/auth.js";
import { type RunningAgent, startAgentServer } from "../src/server/serve.js";
import { generateSelfSignedCert } from "../src/server/tls.js";
import { type ControllerClosedGuard, installControllerClosedGuard } from "./helpers.js";

/**
 * #220 end-to-end pin: GET /v1/models must gate ModelHost routes on their
 * declared readiness probe instead of listing every live route. On the base
 * revision serve.ts calls listOpenAIModels unfiltered, so the warming / hung /
 * refused hosts all appear in `data` and the not.toContain assertions fail.
 *
 *   fake upstreams (Bun.serve on 127.0.0.1)
 *     /ready -> 503 loading | 200 ready | never answers
 *     ↑
 *     | plain HTTP probes from checkServingReadiness
 *     |
 *   llamactl agent (TLS + bearer)
 *     ↑
 *     | HTTPS + bearer
 *     |
 *   test client (Bun fetch with tls.ca pinned)
 */

type Upstream = {
  label: string;
  server: ReturnType<typeof Bun.serve>;
};

type ModelHostReadinessFixture = {
  path: string;
  expectStatus?: number;
  expectJson?: Record<string, string | number | boolean>;
};

const DECLARED_COLD_ID = "cold/declared-model.gguf";

let agent: RunningAgent | null = null;
let devStorage = "";
let runtimeDir = "";
let agentToken = "";
let caPem = "";
let controllerGuard: ControllerClosedGuard;
const upstreams: Upstream[] = [];
const originalEnv = { ...process.env };

beforeAll(async () => {
  controllerGuard = installControllerClosedGuard();
  devStorage = mkdtempSync(join(tmpdir(), "llamactl-openai-readiness-"));
  runtimeDir = join(devStorage, "ai-models", "local-ai");
  mkdirSync(runtimeDir, { recursive: true });

  const startUpstream = (
    label: string,
    handler: (url: URL) => Response | Promise<Response>,
  ): { port: number } => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        return handler(new URL(req.url));
      },
    });
    upstreams.push({ label, server });
    return { port: server.port! };
  };
  const notFound = (): Response => new Response("not found", { status: 404 });

  const u503 = startUpstream("u503", (url) =>
    url.pathname === "/ready" ? Response.json({ status: "loading" }, { status: 503 }) : notFound(),
  );
  const u200 = startUpstream("u200", (url) =>
    url.pathname === "/ready" ? Response.json({ status: "ready" }) : notFound(),
  );
  const uhang = startUpstream("uhang", (url) =>
    url.pathname === "/ready"
      ? new Promise<Response>(() => {
          // Never settles: models a host that accepts the probe and hangs.
        })
      : notFound(),
  );

  // A port that was bound and immediately released: probes get ECONNREFUSED.
  const refusedHolder = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("held"),
  });
  const refusedPort = refusedHolder.port!;
  await refusedHolder.stop(true);

  process.env["DEV_STORAGE"] = devStorage;
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
  process.env["LLAMA_CPP_PORT"] = String(u200.port);
  process.env["LLAMACTL_NODE_NAME"] = "readiness-test-agent";

  const writeHost = (
    name: string,
    port: number,
    modelId: string,
    readiness?: ModelHostReadinessFixture,
  ): void => {
    const dir = join(runtimeDir, "workloads", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "modelhost.pid"), `${String(process.pid)}\n`);
    writeFileSync(
      join(dir, "modelhost.state"),
      JSON.stringify({
        kind: "ModelHost",
        engine: "llamacpp",
        pid: process.pid,
        host: "127.0.0.1",
        port,
        modelAliases: [modelId],
        startedAt: new Date().toISOString(),
        ...(readiness !== undefined ? { readiness } : {}),
      }),
    );
  };

  writeHost("warming-host", u503.port, "warming-model", { path: "/ready" });
  writeHost("ready-host", u200.port, "ready-model", {
    path: "/ready",
    expectJson: { status: "ready" },
  });
  writeHost("hung-host", uhang.port, "hung-model", { path: "/ready" });
  writeHost("refused-host", refusedPort, "refused-model", { path: "/ready" });
  writeHost("plain-host", u200.port, "plain-model");

  // nodeModels on an inproc:// node stands in for the agent's /v1/models,
  // so it must apply the same gate (#220).
  const configPath = join(devStorage, "kubeconfig.yaml");
  writeFileSync(
    configPath,
    stringify({
      apiVersion: "llamactl/v1",
      kind: "Config",
      currentContext: "default",
      contexts: [{ name: "default", cluster: "home", user: "me", defaultNode: "local" }],
      clusters: [{ name: "home", nodes: [{ name: "local", endpoint: "inproc://local" }] }],
      users: [{ name: "me", token: "unused-inproc-token" }],
    }),
  );
  process.env["LLAMACTL_CONFIG"] = configPath;

  // Order matters: the reset nulls the declared source, so it must run
  // before the setter re-installs it. The warming host also appears as a
  // declared (loading) entry to pin how ?include=declared treats it.
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
  openaiProxy.setDeclaredModelSource(() => [
    {
      id: "warming-model",
      workload: "warming-host",
      kind: "ModelHost",
      ownerNodeId: "local",
      state: "loading",
      autoLoadEligible: true,
    },
    {
      id: DECLARED_COLD_ID,
      workload: "wl-cold",
      kind: "ModelRun",
      ownerNodeId: "local",
      state: "cold",
      autoLoadEligible: true,
    },
  ]);

  const cert = await generateSelfSignedCert({
    dir: join(devStorage, "agent"),
    commonName: "127.0.0.1",
    hostnames: ["127.0.0.1", "localhost"],
  });
  caPem = cert.certPem;

  const token = generateToken();
  agentToken = token.token;
  agent = startAgentServer({
    bindHost: "127.0.0.1",
    port: 0,
    tokenHash: token.hash,
    tls: { certPath: cert.certPath, keyPath: cert.keyPath },
    advertiseMdns: false,
  });
});

afterAll(async () => {
  openaiProxy.setDeclaredModelSource(null);
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
  await agent?.stop();
  for (const upstream of upstreams) await upstream.server.stop(true);
  rmSync(devStorage, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, originalEnv);
  controllerGuard.dispose();
});

function pinnedFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${agent!.url}${path}`;
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${agentToken}`);
  return fetch(url, {
    ...init,
    headers,
    ...({ tls: { ca: caPem } } as Record<string, unknown>),
  });
}

type ModelsBody = {
  object: string;
  data: { id: string }[];
  declared?: { id: string }[];
};

describe("agent /v1/models serving readiness (#220)", () => {
  test("GET /v1/models omits ModelHosts whose declared readiness fails", async () => {
    const start = Date.now();
    const res = await pinnedFetch("/v1/models");
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsBody;
    expect(body.object).toBe("list");
    const ids = body.data.map((entry) => entry.id);
    expect(ids).toContain("ready-model");
    expect(ids).toContain("plain-model");
    expect(ids).not.toContain("warming-model");
    expect(ids).not.toContain("hung-model");
    expect(ids).not.toContain("refused-model");
    expect(elapsed).toBeLessThan(4000);
  }, 10_000);

  test("GET /v1/models?include=declared keeps the same data gating", async () => {
    const res = await pinnedFetch("/v1/models?include=declared");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsBody;
    expect(body.object).toBe("list");
    const ids = body.data.map((entry) => entry.id);
    expect(ids).toContain("ready-model");
    expect(ids).toContain("plain-model");
    expect(ids).not.toContain("warming-model");
    expect(ids).not.toContain("hung-model");
    expect(ids).not.toContain("refused-model");
  }, 10_000);

  test("GET /v1/models?include=declared lists a warming host in neither data nor declared", async () => {
    // Current behaviour, pinned: declared[] is derived from the ungated
    // route set, so a host that is routed but warming is skipped there as
    // "routed" while the gate drops it from data. It surfaces in neither.
    const res = await pinnedFetch("/v1/models?include=declared");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsBody;
    expect(body.data.map((entry) => entry.id)).not.toContain("warming-model");
    expect(Array.isArray(body.declared)).toBe(true);
    const declaredIds = (body.declared ?? []).map((entry) => entry.id);
    expect(declaredIds).toContain(DECLARED_COLD_ID);
    expect(declaredIds).not.toContain("warming-model");
  }, 10_000);
});

describe("nodeModels inproc serving readiness (#220)", () => {
  test("a local inproc node omits ModelHosts whose declared readiness fails", async () => {
    const out = await router.createCaller({}).nodeModels({ name: "local" });
    expect(out.node).toBe("local");
    const ids = (out.models as { id: string }[]).map((entry) => entry.id);
    expect(ids).toContain("ready-model");
    expect(ids).toContain("plain-model");
    expect(ids).not.toContain("warming-model");
    expect(ids).not.toContain("hung-model");
    expect(ids).not.toContain("refused-model");
  }, 10_000);

  test("chat routing still sees the warming host", () => {
    const ids = openaiProxy.listOpenAIModels().data.map((entry) => entry.id);
    expect(ids).toContain("warming-model");
    expect(ids).toContain("ready-model");
  });
});
