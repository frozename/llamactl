import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { readPenumbraHandoffs } from "../../src/console/penumbra.js";
import { startConsoleServer } from "../../src/console/server.js";
import { apiHeaders, cleanupConsoleTest, consoleTestFixture } from "./helpers.js";

afterEach(async () => {
  await cleanupConsoleTest();
});

test("unconfigured add-on leaves the console usable", async () => {
  expect(await readPenumbraHandoffs({})).toEqual({ state: "unconfigured" });
  expect(
    await readPenumbraHandoffs({
      LLAMACTL_PENUMBRA_URL: "http://192.0.2.1",
      LLAMACTL_PENUMBRA_TOKEN_FILE: "/unused",
    }),
  ).toEqual({ state: "unavailable" });
});

test("passes only projected handoff metadata through the authenticated console", async () => {
  const { distPath } = consoleTestFixture();
  const tokenFile = join(distPath, "..", "penumbra-test-token");
  await Bun.write(tokenFile, "fixture-daemon-token\n");
  const row = {
    handoff_id: "handoff-1",
    ts: "2026-11-25T00:00:00Z",
    to_agent: "macbook-qwen",
    status: "dispatched",
    resolved_at: null,
  };
  let requests = 0;
  const daemon = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      requests += 1;
      expect(new URL(req.url).pathname).toBe("/handoffs");
      expect(req.headers.get("authorization")).toBe("Bearer fixture-daemon-token");
      return Response.json({
        handoffs: [{ ...row, message: "private task prompt", cwd_override: "/private/path" }],
      });
    },
  });
  const settings = {
    LLAMACTL_PENUMBRA_URL: daemon.url.origin,
    LLAMACTL_PENUMBRA_TOKEN_FILE: tokenFile,
  };
  const original = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const consoleServer = await startConsoleServer({ port: 0, distPath });
  try {
    const root = await fetch(consoleServer.url);
    const cookie = root.headers.get("set-cookie")?.split(";")[0] ?? "";
    const url = new URL("/api/addons/penumbra/handoffs", consoleServer.url);
    const headers = apiHeaders({ port: consoleServer.port, cookie });
    expect((await fetch(url)).status).toBe(403);
    expect((await fetch(url, { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(401);
    expect((await fetch(url, { headers, method: "POST" })).status).toBe(405);
    expect(requests).toBe(0);

    const result = await fetch(url, { headers });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ state: "ready", handoffs: [row] });
    expect(requests).toBe(1);
  } finally {
    await consoleServer.stop();
    await daemon.stop(true);
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
});
