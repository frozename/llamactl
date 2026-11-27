import { writeModelHostState } from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";

import * as consoleServer from "../../src/console/server.js";
import { startAgentServer } from "../../src/server/serve.js";
import {
  apiHeaders,
  cleanupConsoleTest,
  consoleTestFixture,
  setEnv,
  startConsole,
  tmpDir,
} from "./helpers.js";

afterEach(cleanupConsoleTest);

test("the inspector reads captured requests from the authenticated fleet agent", async () => {
  const fixture = "fixture-inspection";
  const token = "tok-console-test";
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      const payload: unknown = await req.json();
      expect(payload).toMatchObject({ model: fixture });
      return new Response(
        'data: {"choices":[{"delta":{"content":"Model answer Bearer "}}]}\n\ndata: {"choices":[{"delta":{"content":"fixture-stream-secret"}}]}\n\ndata: [DONE]\n\n',
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  });
  let agent: ReturnType<typeof startAgentServer> | undefined;
  try {
    const { distPath } = consoleTestFixture();
    setEnv("LOCAL_AI_RUNTIME_DIR", tmpDir("request-inspection-runtime-"));
    setEnv("LLAMACTL_UNIFIED_PROXY", "0");
    setEnv("LLAMACTL_REQUEST_CAPTURE_FILE", join(tmpDir("request-inspection-"), "capture.sqlite"));
    writeModelHostState(
      {
        kind: "ModelHost",
        engine: "llamacpp",
        pid: process.pid,
        host: "127.0.0.1",
        port: upstream.port!,
        modelAliases: [fixture],
        startedAt: "2026-11-26T00:00:00.000Z",
      },
      { name: fixture },
      resolveEnv(),
    );
    agent = startAgentServer({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      noAuth: true,
    });
    const base = `http://127.0.0.1:${String(agent.port)}`;
    consoleTestFixture({ nodes: [{ name: "fixture", endpoint: base }] });
    const console = await startConsole(consoleServer, { distPath });
    const capture = `${base}/fleet/request-capture`;
    const route = `${console.url}/api/n/fixture/requests`;
    expect((await fetch(capture)).status).toBe(401);
    expect((await fetch(route)).status).toBe(403);
    const inference = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "fixture-header-secret" },
      body: JSON.stringify({
        model: fixture,
        stream: true,
        temperature: 0.2,
        provider_options: { api_key: "fixture-body-secret" },
        messages: [{ role: "user", content: "Fixture prompt" }],
      }),
    });
    expect(inference.status).toBe(200);
    expect(await inference.text()).toContain("Model answer");
    const headers = apiHeaders(console);
    const listing = await fetch(route, { headers });
    expect(listing.status).toBe(200);
    const list = (await listing.json()) as { requests: { id: string }[] };
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0]).toMatchObject({
      model: fixture,
      path: "/v1/chat/completions",
      status: 200,
    });
    expect(list.requests[0]).not.toHaveProperty("request");
    const detail = await fetch(`${route}/${list.requests[0]!.id}`, { headers });
    expect(detail.headers.get("cache-control")).toBe("no-store");
    const captured = await detail.text();
    expect(captured).toContain("Fixture prompt");
    expect(captured).toContain("Model answer");
    expect(captured).toContain("temperature");
    expect(captured).not.toContain("fixture-header-secret");
    expect(captured).not.toContain("fixture-body-secret");
    expect(captured).not.toContain("fixture-stream-secret");
    expect(captured).toContain("Bearer [redacted]");
  } finally {
    if (agent) await agent.stop();
    await upstream.stop(true);
  }
});

test("disabled capture has an empty catalog and expired payloads are removed", async () => {
  const { distPath } = consoleTestFixture();
  setEnv("LLAMACTL_REQUEST_CAPTURE_FILE", undefined);
  const console = await startConsole(consoleServer, { distPath });
  const route = `${console.url}/api/n/local/requests`;
  const headers = apiHeaders(console);
  expect(await (await fetch(route, { headers })).json()).toEqual({ enabled: false, requests: [] });
  const file = join(tmpDir("inspection-expiry-"), "capture.sqlite");
  setEnv("LLAMACTL_REQUEST_CAPTURE_FILE", file);
  const id = "5f512abf-b81a-4612-a7df-0881d0e7171d";
  const { storeCapture, pruneCaptures, findCapture } =
    await import("../../src/request-capture/store.js");
  const now = Date.now();
  const record = {
    id,
    at: now,
    path: "/v1/chat/completions",
    model: "fixture",
    status: 200,
    durationMs: 50,
    firstByteMs: 25,
    cancelled: false,
    truncated: false,
    request: { messages: ["retained briefly"] },
    response: { reply: "result" },
  };
  storeCapture(file, record, now);
  expect(findCapture(file, id, now + 14 * 60_000)).toEqual(record);
  expect(findCapture(file, id, now + 15 * 60_000)).toBeNull();
  pruneCaptures(file, now + 15 * 60_000);
  expect(findCapture(file, id, now)).toBeNull();
});
