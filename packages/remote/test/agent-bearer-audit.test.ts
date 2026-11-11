/**
 * #218 — per-request audit of which bearer authenticated, plus
 * per-token last use. An admitted request is recorded under the name
 * of the bearer that authenticated it — 'default' for the primary,
 * the entry name for a named token — through the optional
 * onAuthenticated hook, per-token request counters and last-used
 * gauges on /metrics, and, with no hook, one
 * `[agent] auth token=<name> <METHOD> <path>` stderr line. No record,
 * metric label or log line ever carries the token or its hash.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import * as authMod from "../src/server/auth.js";
import { type RunningAgent, startAgentServer } from "../src/server/serve.js";

/** What the audit hook (and the default stderr sink) reports per admitted request. */
interface BearerAuthRecord {
  tokenName: string;
  method: string;
  pathname: string;
}

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMACTL_CONFIG",
  "LLAMA_CPP_HOST",
  "LLAMA_CPP_PORT",
] as const;

/** Run fn with stderr captured; resolves to what it wrote. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return buf;
}

describe("bearer auth audit", () => {
  const originalEnv = { ...process.env };
  let dir: string;
  let server: RunningAgent;
  let stub: ReturnType<typeof Bun.serve> | null = null;
  let list: authMod.NamedBearerToken[];
  let records: BearerAuthRecord[];
  const primary = authMod.generateToken();
  const named = authMod.generateToken();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-bearer-audit-"));
    process.env["DEV_STORAGE"] = dir;
    process.env["LOCAL_AI_RUNTIME_DIR"] = join(dir, "runtime");
    process.env["LLAMACTL_CONFIG"] = join(dir, "no-kubeconfig");
    list = [];
    records = [];
    server = startAgentServer({
      tokenHash: primary.hash,
      bearerTokens: (): authMod.NamedBearerToken[] => list,
      onAuthenticated: (record: BearerAuthRecord): void => {
        records.push(record);
      },
    });
  });

  afterEach(async () => {
    await server.stop();
    await stub?.stop(true);
    stub = null;
    rmSync(dir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
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

  function post(pathname: string, token: string, body: string): Promise<Response> {
    return server.handleRequest!(
      new Request(`http://x${pathname}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
      }),
      { address: "192.168.1.50", port: 1, family: "IPv4" },
    );
  }

  test("bearerNameFor names the primary bearer default and a named bearer by its name", () => {
    const bearerNameForExport = (authMod as Record<string, unknown>)["bearerNameFor"];
    expect(typeof bearerNameForExport).toBe("function");
    const bearerNameFor = bearerNameForExport as (
      token: string | null | undefined,
      primaryHash: string,
      tokens: readonly authMod.NamedBearerToken[],
    ) => string | null;
    const name = "audit-name-for";
    list.push({ name, tokenHash: named.hash });
    expect(bearerNameFor(primary.token, primary.hash, list)).toBe("default");
    expect(bearerNameFor(named.token, primary.hash, list)).toBe(name);
    expect(bearerNameFor(authMod.generateToken().token, primary.hash, list)).toBeNull();
    expect(bearerNameFor(null, primary.hash, list)).toBeNull();
    expect(bearerNameFor("", primary.hash, list)).toBeNull();
    list.splice(0, list.length);
    expect(bearerNameFor(named.token, primary.hash, list)).toBeNull();
    expect((authMod as Record<string, unknown>)["PRIMARY_BEARER_NAME"]).toBe("default");
  });

  test("bearerNameFor gives default when a named entry carries the primary's hash", () => {
    list.push({ name: "audit-primary-clash", tokenHash: primary.hash });
    expect(authMod.bearerNameFor(primary.token, primary.hash, list)).toBe("default");
  });

  test("bearerNameFor gives the first of two named entries sharing a hash", () => {
    list.push({ name: "audit-first", tokenHash: named.hash });
    list.push({ name: "audit-second", tokenHash: named.hash });
    expect(authMod.bearerNameFor(named.token, primary.hash, list)).toBe("audit-first");
  });

  test("a throwing onAuthenticated hook still admits the request and notes the failure without the secret", async () => {
    const name = "audit-throwing-hook";
    list.push({ name, tokenHash: named.hash });
    await server.stop();
    server = startAgentServer({
      tokenHash: primary.hash,
      bearerTokens: () => list,
      onAuthenticated: (): void => {
        throw new Error("audit sink down");
      },
    });
    let status = 0;
    const captured = await captureStderr(async () => {
      status = (await get("/metrics?secret=zzz", named.token)).status;
    });
    expect(status).toBe(200);
    expect(captured).toContain(`[agent] auth sink failed for token=${name} GET /metrics`);
    expect(captured).not.toContain("zzz");
    for (const secret of [named.token, named.hash, primary.token, primary.hash]) {
      expect(captured).not.toContain(secret);
    }
  });

  test("a request authenticated by the primary bearer is recorded as default", async () => {
    list.push({ name: "audit-primary-default", tokenHash: named.hash });
    const res = await get("/metrics", primary.token);
    expect(res.status).toBe(200);
    expect(records).toEqual([{ tokenName: "default", method: "GET", pathname: "/metrics" }]);
  });

  test("a request authenticated by a named bearer is recorded under its name", async () => {
    const name = "audit-named-trpc";
    list.push({ name, tokenHash: named.hash });
    const res = await get("/trpc/env", named.token);
    expect(res.status).toBe(200);
    expect(records).toEqual([{ tokenName: name, method: "GET", pathname: "/trpc/env" }]);
  });

  test("a revoked or unknown bearer gets 401 and is never recorded", async () => {
    list.push({ name: "audit-revoked", tokenHash: named.hash });
    list.splice(0, list.length);
    expect((await get("/metrics", named.token)).status).toBe(401);
    expect((await get("/metrics", authMod.generateToken().token)).status).toBe(401);
    expect(records).toEqual([]);
    const res = await get("/metrics", primary.token);
    expect(res.status).toBe(200);
    expect(records).toEqual([{ tokenName: "default", method: "GET", pathname: "/metrics" }]);
  });

  test("per-token request count and last-used are exported and never expose the token or its hash", async () => {
    const name = "audit-metrics";
    list.push({ name, tokenHash: named.hash });
    const t0 = Math.floor(Date.now() / 1000);
    expect((await get("/trpc/env", named.token)).status).toBe(200);
    expect((await get("/trpc/env", named.token)).status).toBe(200);
    const scrape = await get("/metrics", primary.token);
    expect(scrape.status).toBe(200);
    const text = await scrape.text();
    expect(text).toMatch(
      new RegExp(`^llamactl_agent_bearer_requests_total\\{[^}]*token="${name}"[^}]*\\} 2$`, "m"),
    );
    const lastUsedMatch = new RegExp(
      `^llamactl_agent_bearer_last_used_timestamp_seconds\\{[^}]*token="${name}"[^}]*\\} (\\S+)$`,
      "m",
    ).exec(text);
    expect(lastUsedMatch).not.toBeNull();
    const lastUsedSeconds = Number(lastUsedMatch?.[1]);
    expect(Number.isFinite(lastUsedSeconds)).toBe(true);
    expect(lastUsedSeconds).toBeGreaterThanOrEqual(t0);
    expect(lastUsedSeconds).toBeLessThanOrEqual(Date.now() / 1000 + 1);
    expect(text).not.toContain(named.token);
    expect(text).not.toContain(named.hash);
    const recordsJson = JSON.stringify(records);
    expect(recordsJson).not.toContain(named.token);
    expect(recordsJson).not.toContain(named.hash);
  });

  test("the RAG fallback on POST /v1/chat/completions records the bearer once", async () => {
    const name = "audit-rag-fallback";
    list.push({ name, tokenHash: named.hash });
    stub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (): Response => Response.json({ ok: true }),
    });
    process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
    process.env["LLAMA_CPP_PORT"] = String(stub.port ?? 0);
    const res = await post(
      "/v1/chat/completions",
      named.token,
      JSON.stringify({ model: "audit-m", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).not.toBe(401);
    expect(records.filter((record) => record.tokenName === name)).toEqual([
      { tokenName: name, method: "POST", pathname: "/v1/chat/completions" },
    ]);
    const scrape = await get("/metrics", primary.token);
    expect(scrape.status).toBe(200);
    const text = await scrape.text();
    expect(text).toMatch(
      new RegExp(`^llamactl_agent_bearer_requests_total\\{[^}]*token="${name}"[^}]*\\} 1$`, "m"),
    );
  });

  test("with no hook the agent writes one stderr audit line per admitted request and never the secret", async () => {
    const name = "audit-stderr-sink";
    list.push({ name, tokenHash: named.hash });
    await server.stop();
    server = startAgentServer({ tokenHash: primary.hash, bearerTokens: () => list });
    const captured = await captureStderr(async () => {
      expect((await get("/metrics", named.token)).status).toBe(200);
      expect((await get("/metrics", authMod.generateToken().token)).status).toBe(401);
      expect((await get("/trpc/env?secret=zzz", primary.token)).status).toBe(200);
    });
    expect(captured).toContain(`[agent] auth token=${name} GET /metrics`);
    expect(captured).toContain("[agent] auth token=default GET /trpc/env");
    expect(captured).not.toContain("zzz");
    const auditLines = captured.split("\n").filter((line) => line.includes("[agent] auth token="));
    expect(auditLines).toHaveLength(2);
    for (const secret of [named.token, named.hash, primary.token, primary.hash]) {
      expect(captured).not.toContain(secret);
    }
  });
});
