/**
 * P0.1 (#129) characterization — the POST /v1/chat/completions `via`/`rag`
 * JSON path through the real agent HTTP stack:
 *   handleRequest → bearer gate → handleRagChatCompletions → real
 *   appRouter.createCaller → chatComplete → providerForNode →
 *   createOpenAICompatProvider → a loopback Bun.serve "cloud" upstream.
 * Also pins the no-extension fallthrough to the local openaiProxy.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config as kubecfg } from "../src/index.js";
import { existsSync, mkdtempSync, rmSync } from "../src/safe-fs.js";
import { type Cluster, makeCluster } from "./helpers.js";

interface CloudCall {
  url: string;
  method: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

const ENV_KEYS = [
  "LLAMACTL_CONFIG",
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_HOST",
  "LLAMA_CPP_PORT",
  "PATH",
] as const;

let cluster: Cluster | undefined;
let cloud: ReturnType<typeof Bun.serve> | undefined;
let cloudCalls: CloudCall[];
let bearer: string;
let envBackup: Record<string, string | undefined>;
let sandbox: string;

function chatCompletions(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const agent = cluster?.nodes[0]?.agent;
  if (!agent?.handleRequest) throw new Error("handleRequest unavailable");
  return agent.handleRequest(
    new Request(`${agent.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

function preferWorkingOpenssl(): void {
  // tls.generateSelfSignedCert shells out to `openssl req -x509 -key …`
  // with no explicit -new. /usr/bin/openssl on this host is LibreSSL
  // 3.3.x, which rejects that invocation ("unable to load X509 request"),
  // while OpenSSL ≥1.1.1 accepts it. When the PATH openssl is LibreSSL
  // and a Homebrew OpenSSL exists, prefer it for the cert fixture —
  // test-environment plumbing only; product code is unchanged.
  const probe = spawnSync("openssl", ["version"], { encoding: "utf8" });
  if (!probe.stdout.includes("LibreSSL")) return;
  const homebrewOpenssl = "/opt/homebrew/opt/openssl/bin";
  if (!existsSync(join(homebrewOpenssl, "openssl"))) return;
  process.env["PATH"] = `${homebrewOpenssl}:${process.env["PATH"] ?? ""}`;
}

beforeAll(async () => {
  envBackup = {};
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  preferWorkingOpenssl();

  sandbox = mkdtempSync(join(tmpdir(), "llamactl-proxy-char-"));
  // Hermetic globals — the in-proc pipeline reads process.env per call:
  // kubeconfig for chatComplete's provider lookup, LOCAL_AI_RUNTIME_DIR for
  // the proxy's local workload table, DEV_STORAGE for usage journals, and a
  // guaranteed-closed llama-server port for the fallback path.
  process.env["DEV_STORAGE"] = join(sandbox, "dev-storage");
  process.env["LOCAL_AI_RUNTIME_DIR"] = join(sandbox, "runtime");
  process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
  process.env["LLAMA_CPP_PORT"] = "1"; // nothing listens — deterministic ECONNREFUSED

  cloudCalls = [];
  cloud = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const parsed = new URL(req.url);
      let body: Record<string, unknown> | null = null;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        body = null;
      }
      cloudCalls.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.get("authorization"),
        body,
      });
      if (req.method === "POST" && parsed.pathname === "/v1/chat/completions") {
        return Response.json({
          id: "chatcmpl-cloud-1",
          object: "chat.completion",
          model: body?.["model"] ?? "cloud-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "cloud reply" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
        });
      }
      return new Response("", { status: 404 });
    },
  });

  cluster = await makeCluster({ nodes: 1 });

  // Extend the cluster kubeconfig with a gateway node pointing at the
  // loopback "cloud" — `via` then resolves through providerForNode's
  // gateway branch to providerForCloudNode.
  const cfg = kubecfg.loadConfig(cluster.clusterConfigPath);
  bearer = cfg.users.find((u) => u.name === "me")?.token ?? "";
  if (!bearer) throw new Error("cluster kubeconfig has no 'me' user token");
  const withGateway = kubecfg.upsertNode(cfg, "home", {
    name: "fake-cloud",
    kind: "gateway",
    endpoint: "",
    cloud: {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${String(cloud.port)}`,
    },
  });
  kubecfg.saveConfig(withGateway, cluster.clusterConfigPath);
  process.env["LLAMACTL_CONFIG"] = cluster.clusterConfigPath;
});

afterAll(async () => {
  if (cluster !== undefined) await cluster.cleanup();
  if (cloud !== undefined) await cloud.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const prev = envBackup[key];
    if (prev === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = prev;
  }
});

describe("POST /v1/chat/completions via/rag JSON path (P0.1)", () => {
  beforeEach(() => {
    cloudCalls = [];
  });

  test("via routes through chatComplete to the gateway node's upstream", async () => {
    const res = await chatCompletions({
      model: "fake-model",
      messages: [{ role: "user", content: "hello cloud" }],
      via: "fake-cloud",
      temperature: 0.5,
      providerOptions: { user: "test-operator" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-llamactl-rag")).toBeNull();
    const body = (await res.json()) as Record<string, unknown>;

    // The OpenAI-compat adapter POSTs <baseUrl>/chat/completions with
    // stream forced off, providerOptions spread into the wire body, and
    // a Bearer header carrying the (absent) apiKeyRef as empty.
    expect(cloudCalls).toHaveLength(1);
    const call = cloudCalls[0]!;
    expect(call.url).toBe(`http://127.0.0.1:${String(cloud?.port)}/v1/chat/completions`);
    expect(call.method).toBe("POST");
    expect(call.body?.["model"]).toBe("fake-model");
    expect(call.body?.["stream"]).toBe(false);
    expect(call.body?.["user"]).toBe("test-operator");
    expect(call.body?.["temperature"]).toBe(0.5);
    expect(call.authorization).toBe("Bearer");

    // chatComplete returns the upstream JSON + provider/latency fields.
    expect(body["object"]).toBe("chat.completion");
    expect(body["provider"]).toBe("fake-cloud");
    expect(typeof body["latencyMs"]).toBe("number");
    expect((body["choices"] as { message: { content: string } }[])[0]!.message.content).toBe(
      "cloud reply",
    );
  });

  test("via targeting an agent node dials the agent's own /v1 surface", async () => {
    // `via: node1` resolves to kind 'agent' → providerForNode points an
    // OpenAI-compat adapter at <endpoint>/v1. The fetch reaches the
    // agent's TLS listener (the fixture serves the self-signed cert that
    // makeCluster generated) and fails certificate validation — no
    // pinned CA is configured on the dial. chatComplete wraps that as a
    // TRPCError, which forwardChat maps to the upstream_error envelope
    // at the TRPC-derived status (INTERNAL_SERVER_ERROR → 500).
    const res = await chatCompletions({
      model: "any",
      messages: [{ role: "user", content: "hi" }],
      via: "node1",
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: {
        message: "self signed certificate",
        type: "upstream_error",
        code: "INTERNAL_SERVER_ERROR",
      },
    });
    expect(cloudCalls).toHaveLength(0);
  });

  test("rag without via returns the invalid_request_error envelope", async () => {
    const res = await chatCompletions({
      model: "fake-model",
      messages: [{ role: "user", content: "hi" }],
      rag: { node: "node1" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        message:
          "via is required — name the llamactl node to route chat through (gateway / agent / cloud)",
        type: "invalid_request_error",
      },
    });
    expect(cloudCalls).toHaveLength(0);
  });

  test("via + rag on a non-rag node returns the rag_error envelope", async () => {
    const res = await chatCompletions({
      model: "fake-model",
      messages: [{ role: "user", content: "what is llamactl?" }],
      via: "fake-cloud",
      rag: { node: "node1", topK: 2 },
    });
    // ragSearch rejects ("not a RAG node") → 502 rag_error; chatComplete
    // never runs, so the upstream sees nothing.
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: {
        message: "retrieval failed: node 'node1' is not a RAG node",
        type: "rag_error",
      },
    });
    expect(cloudCalls).toHaveLength(0);
  });

  test("a request without via/rag falls through to the local openaiProxy fallback", async () => {
    const res = await chatCompletions({
      model: "no-local-workload",
      messages: [{ role: "user", content: "hi" }],
    });
    // No local workloads in the hermetic runtime dir and LLAMA_CPP_PORT=1
    // is closed — the legacy fallback surfaces the 502 upstream envelope.
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("llamactl_upstream_error");
    expect(body.error.message.startsWith("upstream llama-server unreachable:")).toBe(true);
    expect(cloudCalls).toHaveLength(0);
  });

  test("POST /v1/chat/completions without a bearer returns the 401 envelope", async () => {
    const agent = cluster?.nodes[0]?.agent;
    if (!agent?.handleRequest) throw new Error("handleRequest unavailable");
    const res = await agent.handleRequest(
      new Request(`${agent.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await res.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "invalid bearer token" },
    });
    expect(cloudCalls).toHaveLength(0);
  });
});
