/**
 * #218 — multiple named operator bearer tokens. agent.yaml's optional
 * `bearerTokens` block lists `{name, tokenHash, createdAt}` entries the
 * agent accepts beside its primary bearer. The block is opaque to the
 * config schema and validated only by its reader, re-read per request,
 * so an add or revoke applies without a restart.
 */
import * as agentConfigMod from "@llamactl/core/config/agent-config";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import { generateToken, type NamedBearerToken } from "../src/server/auth.js";
import { type RunningAgent, startAgentServer } from "../src/server/serve.js";

const HEX = (c: string): string => c.repeat(64);

function baseConfig(overrides: Record<string, unknown> = {}): agentConfigMod.AgentConfig {
  return {
    apiVersion: "llamactl/v1",
    kind: "AgentConfig",
    bindHost: "127.0.0.1",
    port: 7843,
    certPath: "/tmp/agent.crt",
    keyPath: "/tmp/agent.key",
    tokenHash: HEX("a"),
    fingerprint: `sha256:${HEX("b")}`,
    ...overrides,
  };
}

function bearerEntry(name: string, tokenHash: string): agentConfigMod.AgentBearerToken {
  return { name, tokenHash, createdAt: "2026-10-24T00:00:00.000Z" };
}

/** Run fn with stderr captured; returns what it wrote. */
function captureStderr(fn: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return buf;
}

describe("bearerTokensReader", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-bearer-tokens-"));
    configPath = join(dir, "agent.yaml");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("an absent block reads as undefined", () => {
    agentConfigMod.saveAgentConfig(baseConfig(), configPath);
    expect(agentConfigMod.bearerTokensReader(configPath)()).toBeUndefined();
  });

  test("a valid block reads as its entries", () => {
    const entries = [bearerEntry("ci", HEX("c")), bearerEntry("grafana", HEX("d"))];
    agentConfigMod.saveAgentConfig(baseConfig({ bearerTokens: entries }), configPath);
    expect(agentConfigMod.bearerTokensReader(configPath)()).toEqual(entries);
  });

  test("duplicate names are ignored", () => {
    const entries = [bearerEntry("ci", HEX("c")), bearerEntry("ci", HEX("d"))];
    agentConfigMod.saveAgentConfig(baseConfig({ bearerTokens: entries }), configPath);
    const stderr = captureStderr(() => {
      expect(agentConfigMod.bearerTokensReader(configPath)()).toBeUndefined();
    });
    expect(stderr).toContain("ignoring the bearerTokens block");
  });

  test("two distinct names sharing one hash are ignored", () => {
    const entries = [bearerEntry("ci", HEX("c")), bearerEntry("grafana", HEX("c"))];
    agentConfigMod.saveAgentConfig(baseConfig({ bearerTokens: entries }), configPath);
    const stderr = captureStderr(() => {
      expect(agentConfigMod.bearerTokensReader(configPath)()).toBeUndefined();
    });
    expect(stderr).toContain("ignoring the bearerTokens block");
  });

  test("a malformed hash is ignored and the config still loads", () => {
    const entries = [bearerEntry("ci", "not-hex")];
    agentConfigMod.saveAgentConfig(baseConfig({ bearerTokens: entries }), configPath);
    expect(agentConfigMod.bearerTokensReader(configPath)()).toBeUndefined();
    expect(() => agentConfigMod.loadAgentConfig(configPath)).not.toThrow();
  });

  test("a hash reused as a worker-RPC service credential is ignored", () => {
    const shared = HEX("c");
    const claims = {
      serviceId: "svc",
      operations: ["submit"],
      deployments: ["deploy/w/a"],
      models: [],
      tenants: ["t"],
      credentialScopeId: "scope",
    };
    agentConfigMod.saveAgentConfig(
      baseConfig({
        bearerTokens: [bearerEntry("ci", shared)],
        workerRpc: { versions: [], serviceCredentials: [{ ...claims, tokenHash: shared }] },
      }),
      configPath,
    );
    const stderr = captureStderr(() => {
      expect(agentConfigMod.bearerTokensReader(configPath)()).toBeUndefined();
    });
    expect(stderr).toContain("ignoring the bearerTokens block");
  });

  test("a hash reused as a worker-RPC relay credential is ignored", () => {
    const shared = HEX("c");
    agentConfigMod.saveAgentConfig(
      baseConfig({
        bearerTokens: [bearerEntry("ci", shared)],
        workerRpcRelay: { tokenHashes: [shared] },
      }),
      configPath,
    );
    const stderr = captureStderr(() => {
      expect(agentConfigMod.bearerTokensReader(configPath)()).toBeUndefined();
    });
    expect(stderr).toContain("ignoring the bearerTokens block");
  });

  test("the same reader sees a later revoke", () => {
    const entries = [bearerEntry("ci", HEX("c"))];
    agentConfigMod.saveAgentConfig(baseConfig({ bearerTokens: entries }), configPath);
    const read = agentConfigMod.bearerTokensReader(configPath);
    expect(read()).toEqual(entries);
    agentConfigMod.saveAgentConfig(baseConfig(), configPath);
    expect(read()).toBeUndefined();
  });
});

describe("named bearer tokens at the gate", () => {
  const originalEnv = { ...process.env };
  let dir: string;
  let server: RunningAgent;
  let list: NamedBearerToken[];
  const primary = generateToken();
  const named = generateToken();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-bearer-serve-"));
    process.env["DEV_STORAGE"] = dir;
    process.env["LOCAL_AI_RUNTIME_DIR"] = join(dir, "runtime");
    process.env["LLAMACTL_CONFIG"] = join(dir, "no-kubeconfig");
    list = [{ name: "ci", tokenHash: named.hash }];
    server = startAgentServer({ tokenHash: primary.hash, bearerTokens: () => list });
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
    for (const key of ["DEV_STORAGE", "LOCAL_AI_RUNTIME_DIR", "LLAMACTL_CONFIG"]) {
      if (originalEnv[key] === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = originalEnv[key]!;
    }
  });

  function get(pathname: string, token: string): Promise<Response> {
    return server.handleRequest!(
      new Request(`http://x${pathname}`, { headers: { authorization: `Bearer ${token}` } }),
      { address: "192.168.1.50", port: 1, family: "IPv4" },
    );
  }

  test("GET /metrics accepts the primary bearer", async () => {
    expect((await get("/metrics", primary.token)).status).toBe(200);
  });

  test("GET /metrics accepts a named bearer", async () => {
    expect((await get("/metrics", named.token)).status).toBe(200);
  });

  test("GET /metrics refuses an unknown bearer", async () => {
    expect((await get("/metrics", generateToken().token)).status).toBe(401);
  });

  test("a named bearer spliced out of the list is refused on the next request", async () => {
    expect((await get("/metrics", named.token)).status).toBe(200);
    list.splice(0, list.length);
    expect((await get("/metrics", named.token)).status).toBe(401);
  });

  test("a named bearer reaches /trpc/env", async () => {
    expect((await get("/trpc/env", named.token)).status).toBe(200);
  });
});
