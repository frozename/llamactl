/**
 * #218 — privileged agent routes must enter the same bearer-audit sink as
 * the ordinary API surface, while remaining primary-only. Rejected methods
 * and rejected bearers must stay unaudited; audit lines never carry a token
 * or its hash.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunningAgent } from "../src/server/serve.js";

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { handleAgentRollback, handleAgentUpdate } from "../src/server/agent-update.js";
import * as authMod from "../src/server/auth.js";
import { startAgentServer } from "../src/server/serve.js";

interface BearerAuthRecord {
  tokenName: string;
  method: string;
  pathname: string;
}

const ENV_KEYS = ["DEV_STORAGE", "LOCAL_AI_RUNTIME_DIR", "LLAMACTL_CONFIG"] as const;

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

function postRequest(pathname: string, token: string): Request {
  return new Request(`http://x${pathname}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: "",
  });
}

describe("privileged bearer auth audit", () => {
  const originalEnv = { ...process.env };
  let dir: string;
  let server: RunningAgent;
  let list: authMod.NamedBearerToken[];
  let records: BearerAuthRecord[];
  const primary = authMod.generateToken();
  const named = authMod.generateToken();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-bearer-audit-privileged-"));
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
      tunnelCentral: {
        expectedBearerHash: authMod.hashToken(authMod.generateToken().token),
      },
      tunnelJournalPath: join(dir, "tunnel.jsonl"),
    });
  });

  afterEach(async () => {
    await server.stop();
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

  function postEmpty(pathname: string, token: string): Promise<Response> {
    return server.handleRequest!(postRequest(pathname, token), {
      address: "192.168.1.50",
      port: 1,
      family: "IPv4",
    });
  }

  function postJson(pathname: string, token: string, body: string): Promise<Response> {
    return server.handleRequest!(
      new Request(`http://x${pathname}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
      }),
      { address: "192.168.1.50", port: 1, family: "IPv4" },
    );
  }

  test("POST /agent/update with the primary bearer is recorded once as default", async () => {
    const res = await postEmpty("/agent/update", primary.token);
    expect(res.status).not.toBe(401);
    expect(records).toEqual([{ tokenName: "default", method: "POST", pathname: "/agent/update" }]);
  });

  test("POST /agent/rollback with the primary bearer is recorded once as default", async () => {
    // The route rolls back `process.execPath`; the test runner has no
    // `.previous` beside it, so the admitted hop ends in the 409 refusal.
    expect(existsSync(`${process.execPath}.previous`)).toBe(false);
    const res = await postEmpty("/agent/rollback", primary.token);
    expect(res.status).toBe(409);
    expect(records).toEqual([
      { tokenName: "default", method: "POST", pathname: "/agent/rollback" },
    ]);
  });

  test("POST /agent/update rejects named and unknown bearers without audit", async () => {
    list.push({ name: "privileged-update-named", tokenHash: named.hash });
    expect((await postEmpty("/agent/update", named.token)).status).toBe(401);
    expect((await postEmpty("/agent/update", authMod.generateToken().token)).status).toBe(401);
    expect(records).toEqual([]);
  });

  test("GET /agent/update is rejected before auth and is not recorded", async () => {
    expect((await get("/agent/update", primary.token)).status).toBe(405);
    expect(records).toEqual([]);
  });

  test("POST /tunnel-relay/ghost with the primary bearer is recorded once as default", async () => {
    const res = await postJson(
      "/tunnel-relay/ghost",
      primary.token,
      JSON.stringify({ method: "nodeFacts" }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("tunnel-send-failed");
    expect(records).toEqual([
      { tokenName: "default", method: "POST", pathname: "/tunnel-relay/ghost" },
    ]);
  });

  test("tunnel relay rejects named bearers and non-POST methods without audit", async () => {
    list.push({ name: "privileged-relay-named", tokenHash: named.hash });
    expect(
      (await postJson("/tunnel-relay/ghost", named.token, JSON.stringify({ method: "nodeFacts" })))
        .status,
    ).toBe(401);
    expect((await get("/tunnel-relay/ghost", primary.token)).status).toBe(405);
    expect(records).toEqual([]);
  });

  test("handleAgentRollback audits before the missing-previous refusal", () => {
    const selfPath = join(dir, "llamactl-agent");
    writeFileSync(selfPath, "agent-under-test");
    let calls = 0;
    const onAuthenticated = (): void => {
      calls += 1;
    };
    const res = handleAgentRollback(postRequest("/agent/rollback", primary.token), {
      tokenHash: primary.hash,
      selfPath,
      exitAfter: false,
      onAuthenticated,
    });
    expect(res.status).toBe(409);
    expect(calls).toBe(1);
    const denied = handleAgentRollback(
      postRequest("/agent/rollback", authMod.generateToken().token),
      {
        tokenHash: primary.hash,
        selfPath,
        exitAfter: false,
        onAuthenticated,
      },
    );
    expect(denied.status).toBe(401);
    expect(calls).toBe(1);
  });

  test("handleAgentUpdate audits the primary bearer and never an unknown bearer", async () => {
    const selfPath = join(dir, "llamactl-agent");
    writeFileSync(selfPath, "agent-under-test");
    let calls = 0;
    const onAuthenticated = (): void => {
      calls += 1;
    };
    const res = await handleAgentUpdate(postRequest("/agent/update", primary.token), {
      tokenHash: primary.hash,
      selfPath,
      exitAfter: false,
      onAuthenticated,
    });
    expect(res.status).not.toBe(401);
    expect(calls).toBe(1);
    const denied = await handleAgentUpdate(
      postRequest("/agent/update", authMod.generateToken().token),
      {
        tokenHash: primary.hash,
        selfPath,
        exitAfter: false,
        onAuthenticated,
      },
    );
    expect(denied.status).toBe(401);
    expect(calls).toBe(1);
  });

  test("without a hook, POST /agent/update writes one redacted stderr audit line", async () => {
    const stderrServer = startAgentServer({
      tokenHash: primary.hash,
      bearerTokens: (): authMod.NamedBearerToken[] => list,
      tunnelCentral: {
        expectedBearerHash: authMod.hashToken(authMod.generateToken().token),
      },
      tunnelJournalPath: join(dir, "stderr-tunnel.jsonl"),
    });
    try {
      const captured = await captureStderr(async () => {
        const res = await stderrServer.handleRequest!(postRequest("/agent/update", primary.token), {
          address: "192.168.1.50",
          port: 1,
          family: "IPv4",
        });
        expect(res.status).not.toBe(401);
      });
      expect(captured).toContain("[agent] auth token=default POST /agent/update");
      expect(captured.includes(primary.token)).toBe(false);
      expect(captured.includes(primary.hash)).toBe(false);
    } finally {
      await stderrServer.stop();
    }
  });
});
