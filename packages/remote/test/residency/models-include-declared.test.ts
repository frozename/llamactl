/**
 * #280 DF-07 — negotiated `?include=declared` on GET /v1/models and on
 * the nodeModels tRPC procedure. RED pins: every opt-in case fails by
 * assertion at base — the HTTP surface still emits only {object,data}
 * and nodeModels only {node,kind,models} — while the inert-default
 * cases pass at base and must keep passing. One hermetic TLS agent, one
 * plain-HTTP older peer, one in-proc kubeconfig; no live state.
 */
import { openaiProxy } from "@llamactl/core";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

import * as routerMod from "../../src/router.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { generateToken } from "../../src/server/auth.js";
import { type RunningAgent, startAgentServer } from "../../src/server/serve.js";
import { generateSelfSignedCert } from "../../src/server/tls.js";

const { router } = routerMod;

// The projection helper lands with the fix; the optional-member cast
// keeps this file typechecking at base so every case fails by
// assertion, never by a missing export or a type error.
const projectModelsBody = (
  routerMod as unknown as {
    projectModelsBody?: (body: unknown, includeDeclared: boolean) => Record<string, unknown>;
  }
).projectModelsBody;

const DECLARED_ID = "cold/model-a.gguf";
const DECLARED_LIST_KEYS = ["data", "declared", "object", "unavailable"];
const NODE_MODELS_DECLARED_KEYS = ["declared", "kind", "models", "node", "unavailable"];

let tmp = "";
let agent: RunningAgent | null = null;
let oldPeer: ReturnType<typeof Bun.serve> | null = null;
let agentToken = "";
let certPem = "";
let originalEnv: NodeJS.ProcessEnv | null = null;
const agentSeen: string[] = [];
const oldSeen: string[] = [];

beforeAll(async () => {
  originalEnv = { ...process.env };
  tmp = mkdtempSync(join(tmpdir(), "llamactl-models-include-"));
  const devStorage = join(tmp, "devstorage");
  const runtimeDir = join(devStorage, "ai-models", "local-ai");
  const modelsDir = join(devStorage, "ai-models", "llama.cpp", "models");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });

  process.env["DEV_STORAGE"] = devStorage;
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  process.env["LLAMA_CPP_MODELS"] = modelsDir;
  process.env["LLAMA_CPP_MACHINE_PROFILE"] = "balanced";
  // generateSelfSignedCert shells out to `openssl`; macOS's LibreSSL
  // rejects `req -x509` without -new, so prefer a Homebrew OpenSSL
  // when one is installed. Restored with the rest of process.env.
  process.env["PATH"] = `/opt/homebrew/bin:${process.env["PATH"] ?? ""}`;
  // Hermetic defaults (#240): unavailableModelEntries drops ids equal
  // to the resolved default targets, so pin both unset.
  delete process.env["LLAMA_CPP_DEFAULT_MODEL"];
  delete process.env["LLAMA_CPP_SERVER_ALIAS"];

  const cert = await generateSelfSignedCert({
    dir: tmp,
    commonName: "127.0.0.1",
    hostnames: ["127.0.0.1", "localhost"],
  });
  certPem = cert.certPem;
  const tok = generateToken();
  agentToken = tok.token;

  agent = startAgentServer({
    bindHost: "127.0.0.1",
    port: 0,
    tokenHash: tok.hash,
    tls: { certPath: cert.certPath, keyPath: cert.keyPath },
    nodeName: "models-include-node",
    version: "0.0.0",
    advertiseMdns: false,
    onRequest: (u) => {
      agentSeen.push(u.pathname + u.search);
    },
  });

  // An older peer: plain HTTP, no cert (makePinnedFetch permits
  // loopback), and it ignores ?include — always the pre-#280 body.
  oldPeer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      oldSeen.push(u.pathname + u.search);
      return Response.json({ object: "list", data: [{ id: "old/m" }] });
    },
  });

  const kubeconfig = {
    apiVersion: "llamactl/v1",
    kind: "Config",
    currentContext: "default",
    contexts: [{ name: "default", cluster: "home", user: "me", defaultNode: "local" }],
    clusters: [
      {
        name: "home",
        nodes: [
          { name: "local", endpoint: "inproc://local" },
          {
            name: "peer",
            endpoint: agent.url.replace(/\/+$/, ""),
            certificate: cert.certPem,
            certificateFingerprint: cert.fingerprint,
          },
          { name: "oldpeer", endpoint: `http://127.0.0.1:${String(oldPeer.port)}` },
        ],
      },
    ],
    users: [{ name: "me", token: tok.token }],
  };
  const configPath = join(tmp, "kubeconfig.yaml");
  writeFileSync(configPath, stringify(kubeconfig));
  process.env["LLAMACTL_CONFIG"] = configPath;

  // Order matters: the reset nulls the declared source, so it must
  // run before the setter re-installs it.
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
  openaiProxy.setDeclaredModelSource(() => [
    {
      id: DECLARED_ID,
      workload: "wl-declared",
      kind: "ModelRun",
      ownerNodeId: "local",
      state: "cold",
      autoLoadEligible: true,
    },
  ]);
  expect(openaiProxy.listOpenAIModels().declared.map((d) => d.id)).toContain(DECLARED_ID);
});

afterAll(async () => {
  openaiProxy.setDeclaredModelSource(null);
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
  await agent?.stop();
  await oldPeer?.stop(true);
  if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
  if (originalEnv !== null) process.env = { ...originalEnv };
});

function pinnedFetch(path: string): Promise<Response> {
  return fetch(`${agent!.url}${path}`, {
    headers: { authorization: `Bearer ${agentToken}` },
    ...({ tls: { ca: certPem } } as Record<string, unknown>),
  });
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("GET /v1/models ?include=declared", () => {
  test("opt-in returns data + declared + unavailable + object", async () => {
    const res = await pinnedFetch("/v1/models?include=declared");
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(Object.keys(body).sort()).toEqual(DECLARED_LIST_KEYS);

    const declared = body["declared"];
    expect(Array.isArray(declared)).toBe(true);
    const hit = (declared as Record<string, unknown>[]).find((e) => e["id"] === DECLARED_ID);
    expect(hit).toBeDefined();
    expect(hit?.["owned_by"]).toBe("llamactl-declared");
    expect(hit?.["status"]).toBe("cold");
    expect(hit?.["routable"]).toBe(false);

    const unavailable = body["unavailable"];
    expect(Array.isArray(unavailable)).toBe(true);
    const unavailableIds = (unavailable as Record<string, unknown>[]).map((e) => e["id"]);
    expect(unavailableIds.length).toBeGreaterThan(0);
    expect(unavailableIds).toEqual(openaiProxy.listOpenAIModels().unavailable.map((e) => e.id));

    expect(body["data"]).toEqual([]);
  });

  test("include=declared parses comma-separated and repeated values", async () => {
    for (const qs of ["include=declared,other", "include=other&include=declared"]) {
      const res = await pinnedFetch(`/v1/models?${qs}`);
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(Object.keys(body).sort()).toEqual(DECLARED_LIST_KEYS);
    }
  });

  test("plain GET /v1/models keeps the default body", async () => {
    const res = await pinnedFetch("/v1/models");
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(Object.keys(body).sort()).toEqual(["data", "object"]);
    expect(body["object"]).toBe("list");
    expect(body["data"]).toEqual([]);
  });

  test("unknown or empty include values keep the default body", async () => {
    for (const qs of ["include=other", "include="]) {
      const res = await pinnedFetch(`/v1/models?${qs}`);
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(Object.keys(body).sort()).toEqual(["data", "object"]);
    }
  });

  test("declared opt-in does not flip llamactl_llama_server_up", async () => {
    const res = await pinnedFetch("/v1/models?include=declared");
    expect(res.status).toBe(200);
    const metrics = await pinnedFetch("/metrics");
    expect(metrics.status).toBe(200);
    const text = await metrics.text();
    const line = text.split("\n").find((l) => l.startsWith("llamactl_llama_server_up"));
    expect(line).toBeTruthy();
    expect(line).toMatch(/llamactl_llama_server_up.*\s0\s*$/);
  });
});

describe("nodeModels ?include=declared", () => {
  test("inproc node returns declared + unavailable on opt-in", async () => {
    const input: { name: string; include?: "declared"[] } = {
      name: "local",
      include: ["declared"],
    };
    const out = (await router.createCaller({}).nodeModels(input)) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(NODE_MODELS_DECLARED_KEYS);

    const declared = out["declared"];
    expect(Array.isArray(declared)).toBe(true);
    expect((declared as Record<string, unknown>[]).some((e) => e["id"] === DECLARED_ID)).toBe(true);

    const unavailable = out["unavailable"];
    expect(Array.isArray(unavailable)).toBe(true);
    expect((unavailable as unknown[]).length).toBeGreaterThan(0);
  });

  test("remote agent is asked with ?include=declared and projects the reply", async () => {
    agentSeen.length = 0;
    const input: { name: string; include?: "declared"[] } = {
      name: "peer",
      include: ["declared"],
    };
    const out = (await router.createCaller({}).nodeModels(input)) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(NODE_MODELS_DECLARED_KEYS);

    const declared = out["declared"];
    expect(Array.isArray(declared)).toBe(true);
    expect((declared as Record<string, unknown>[]).some((e) => e["id"] === DECLARED_ID)).toBe(true);

    const unavailable = out["unavailable"];
    expect(Array.isArray(unavailable)).toBe(true);
    expect((unavailable as unknown[]).length).toBeGreaterThan(0);

    expect(agentSeen).toContain("/v1/models?include=declared");
    expect(agentSeen).not.toContain("/v1/models");
  });

  test("older peer falls back to a projected empty declared set", async () => {
    oldSeen.length = 0;
    const input: { name: string; include?: "declared"[] } = {
      name: "oldpeer",
      include: ["declared"],
    };
    const out = (await router.createCaller({}).nodeModels(input)) as Record<string, unknown>;
    expect(out).toEqual({
      node: "oldpeer",
      kind: "agent",
      models: [{ id: "old/m" }],
      declared: [],
      unavailable: [],
    });
    expect(oldSeen).toEqual(["/v1/models?include=declared"]);
  });

  test("local node without include keeps the default shape", async () => {
    const out = (await router.createCaller({}).nodeModels({ name: "local" })) as Record<
      string,
      unknown
    >;
    expect(Object.keys(out).sort()).toEqual(["kind", "models", "node"]);
  });

  test("remote peer without include hits the byte-identical URL", async () => {
    agentSeen.length = 0;
    const out = (await router.createCaller({}).nodeModels({ name: "peer" })) as Record<
      string,
      unknown
    >;
    expect(Object.keys(out).sort()).toEqual(["kind", "models", "node"]);
    expect(agentSeen).toEqual(["/v1/models"]);
  });

  test("older peer without include keeps the default shape", async () => {
    oldSeen.length = 0;
    const out = (await router.createCaller({}).nodeModels({ name: "oldpeer" })) as Record<
      string,
      unknown
    >;
    expect(out).toEqual({ node: "oldpeer", kind: "agent", models: [{ id: "old/m" }] });
    expect(oldSeen).toEqual(["/v1/models"]);
  });
});

describe("projectModelsBody", () => {
  test("is exported as a function", () => {
    expect(typeof projectModelsBody).toBe("function");
  });

  test("projects an older-peer body under declared opt-in", () => {
    expect(projectModelsBody?.({ object: "list", data: [{ id: "m" }] }, true)).toEqual({
      models: [{ id: "m" }],
      declared: [],
      unavailable: [],
    });
  });

  test("passes declared + unavailable arrays through on opt-in", () => {
    const model = { id: "x" };
    const declared = { id: "d" };
    const unavailable = { id: "u" };
    expect(
      projectModelsBody?.(
        { object: "list", data: [model], declared: [declared], unavailable: [unavailable] },
        true,
      ),
    ).toEqual({ models: [model], declared: [declared], unavailable: [unavailable] });
  });

  test("omits declared + unavailable without opt-in", () => {
    const model = { id: "x" };
    expect(
      projectModelsBody?.(
        {
          object: "list",
          data: [model],
          declared: [{ id: "d" }],
          unavailable: [{ id: "u" }],
        },
        false,
      ),
    ).toEqual({ models: [model] });
  });

  test("non-array fields collapse to empty arrays", () => {
    expect(
      projectModelsBody?.({ object: "list", data: 5, declared: "x", unavailable: null }, true),
    ).toEqual({ models: [], declared: [], unavailable: [] });
  });

  test("null or undefined body yields empty models", () => {
    expect(projectModelsBody?.(null, false)).toEqual({ models: [] });
    expect(projectModelsBody?.(undefined, false)).toEqual({ models: [] });
  });
});
