import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { createPenumbraHandoffReader, readPenumbraHandoffs } from "../../src/console/penumbra.js";
import { startConsoleServer } from "../../src/console/server.js";
import { symlinkSync, writeFileSync } from "../../src/safe-fs.js";
import { apiHeaders, cleanupConsoleTest, consoleTestFixture, tmpDir } from "./helpers.js";

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

// Hermetic reader tests: an injected fetch stands in for the daemon, so nothing here
// opens a socket. Port 9 is never contacted.
const FAKE_ORIGIN = "http://127.0.0.1:9";

async function readerEnv(): Promise<NodeJS.ProcessEnv> {
  const { distPath } = consoleTestFixture();
  const tokenFile = join(distPath, "..", "penumbra-reader-token");
  await Bun.write(tokenFile, "fixture-reader-token\n");
  return { LLAMACTL_PENUMBRA_URL: FAKE_ORIGIN, LLAMACTL_PENUMBRA_TOKEN_FILE: tokenFile };
}

type Status =
  | "pending"
  | "approved"
  | "dispatched"
  | "completed"
  | "failed"
  | "expired"
  | "redirected"
  | "rejected";

interface Row {
  handoff_id: string;
  ts: string;
  to_agent: string;
  status: Status;
  resolved_at: string | null;
}

function handoff(index: number, status: Status, resolved: boolean): Row {
  const stamp = `2026-11-25T00:${String(index).padStart(2, "0")}:00Z`;
  return {
    handoff_id: `${status}-${String(index)}`,
    ts: resolved ? "2026-11-24T00:00:00Z" : stamp,
    to_agent: "seat",
    status,
    resolved_at: resolved ? stamp : null,
  };
}

interface RecordedCall {
  url: string;
  authorization: string | null;
}

function recordingFetch(respond: () => Response | Promise<Response>): {
  calls: RecordedCall[];
  impl: typeof fetch;
} {
  const calls: RecordedCall[] = [];
  const impl = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return await respond();
  }) as typeof fetch;
  return { calls, impl };
}

test("requests only active statuses, which the daemon bounds by status", async () => {
  const env = await readerEnv();
  const { calls, impl } = recordingFetch(() => Response.json({ handoffs: [] }));
  const read = createPenumbraHandoffReader({ fetch: impl });
  expect(await read(env)).toEqual({ state: "ready", handoffs: [] });
  expect(calls).toHaveLength(1);
  const url = new URL(calls[0]!.url);
  expect(url.origin).toBe(FAKE_ORIGIN);
  expect(url.pathname).toBe("/handoffs");
  expect([...url.searchParams.keys()]).toEqual(["status"]);
  expect(url.searchParams.get("status")).toBe("pending,approved,dispatched");
  expect(calls[0]!.authorization).toBe("Bearer fixture-reader-token");
});

test("caps a bounded feed at 30 active and 30 terminal rows, newest first", async () => {
  const env = await readerEnv();
  const active = Array.from({ length: 35 }, (_, i) =>
    handoff(i, (["pending", "approved", "dispatched"] as const)[i % 3]!, false),
  );
  const terminal = Array.from({ length: 35 }, (_, i) =>
    handoff(
      i,
      (["completed", "failed", "expired", "redirected", "rejected"] as const)[i % 5]!,
      true,
    ),
  );
  const { impl } = recordingFetch(() =>
    Response.json({ handoffs: [...terminal, ...active].reverse() }),
  );
  const result = await createPenumbraHandoffReader({ fetch: impl })(env);
  if (result.state !== "ready") throw new Error(`expected ready, got ${result.state}`);
  const ids = result.handoffs.map((row) => row.handoff_id);
  const newestFirst = (rows: Row[]): string[] =>
    rows
      .slice()
      .reverse()
      .slice(0, 30)
      .map((row) => row.handoff_id);
  expect(ids).toEqual([...newestFirst(active), ...newestFirst(terminal)]);
});

test("shares one daemon request across concurrent and repeated reads within the TTL", async () => {
  const env = await readerEnv();
  let clock = 1_000;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { calls, impl } = recordingFetch(async () => {
    await gate;
    return Response.json({ handoffs: [handoff(1, "dispatched", false)] });
  });
  const read = createPenumbraHandoffReader({ fetch: impl, now: () => clock });

  const first = read(env);
  const second = read(env);
  // Let the first read get past its token-file read and into fetch.
  for (let i = 0; i < 50 && calls.length === 0; i += 1) await Bun.sleep(1);
  expect(calls).toHaveLength(1);
  release?.();
  const [a, b] = await Promise.all([first, second]);
  expect(a).toEqual(b);
  expect(a.state).toBe("ready");

  clock += 9_999;
  expect(await read(env)).toEqual(a);
  expect(calls).toHaveLength(1);

  clock += 1;
  await read(env);
  expect(calls).toHaveLength(2);

  // A different daemon configuration never reuses another one's cached rows.
  await read({ ...env, LLAMACTL_PENUMBRA_URL: "http://127.0.0.1:10" });
  expect(calls).toHaveLength(3);
});

test("reports a non-OK daemon response as unavailable", async () => {
  const env = await readerEnv();
  let cancelled = false;
  const { impl } = recordingFetch(
    () =>
      new Response(
        new ReadableStream({
          cancel(): void {
            cancelled = true;
          },
        }),
        { status: 503 },
      ),
  );
  expect(await createPenumbraHandoffReader({ fetch: impl })(env)).toEqual({
    state: "unavailable",
  });
  expect(cancelled).toBe(true);
});

test("reports a response over 2 MiB as unavailable", async () => {
  const env = await readerEnv();
  const chunk = new Uint8Array(256 * 1024).fill(0x20);
  let sent = 0;
  const { impl } = recordingFetch(
    () =>
      new Response(
        new ReadableStream({
          pull(controller): void {
            if (sent === 0) controller.enqueue(new TextEncoder().encode('{"handoffs":['));
            sent += 1;
            if (sent > 20) controller.close();
            else controller.enqueue(chunk);
          },
        }),
      ),
  );
  expect(await createPenumbraHandoffReader({ fetch: impl })(env)).toEqual({
    state: "unavailable",
  });
  // The reader stopped pulling soon after the limit instead of draining the stream.
  expect(sent).toBeLessThan(20);
});

test("refuses a token file that is a symlink", async () => {
  const dir = tmpDir("llamactl-penumbra-token-");
  writeFileSync(join(dir, "real-token"), "fixture-link-token\n");
  symlinkSync(join(dir, "real-token"), join(dir, "token-link"));
  const { calls, impl } = recordingFetch(() => Response.json({ handoffs: [] }));

  const result = await createPenumbraHandoffReader({ fetch: impl })({
    LLAMACTL_PENUMBRA_URL: FAKE_ORIGIN,
    LLAMACTL_PENUMBRA_TOKEN_FILE: join(dir, "token-link"),
  });

  expect(result).toEqual({ state: "unavailable" });
  expect(calls).toHaveLength(0);
});

test("refuses a token file over 4 KiB", async () => {
  const dir = tmpDir("llamactl-penumbra-token-");
  writeFileSync(join(dir, "big-token"), "a".repeat(4097));
  const { calls, impl } = recordingFetch(() => Response.json({ handoffs: [] }));

  const result = await createPenumbraHandoffReader({ fetch: impl })({
    LLAMACTL_PENUMBRA_URL: FAKE_ORIGIN,
    LLAMACTL_PENUMBRA_TOKEN_FILE: join(dir, "big-token"),
  });

  expect(result).toEqual({ state: "unavailable" });
  expect(calls).toHaveLength(0);
});

test("retries a failed read after 2 seconds, not the full TTL", async () => {
  const dir = tmpDir("llamactl-penumbra-token-");
  const tokenFile = join(dir, "retry-token");
  writeFileSync(tokenFile, "fixture-retry-token\n");
  let clock = 1_000;
  let responses = 0;
  const { calls, impl } = recordingFetch(() => {
    responses += 1;
    if (responses === 1) return new Response(null, { status: 503 });
    return Response.json({ handoffs: [handoff(1, "dispatched", false)] });
  });
  const read = createPenumbraHandoffReader({ fetch: impl, now: () => clock });
  const env = { LLAMACTL_PENUMBRA_URL: FAKE_ORIGIN, LLAMACTL_PENUMBRA_TOKEN_FILE: tokenFile };
  const ready = { state: "ready" as const, handoffs: [handoff(1, "dispatched", false)] };

  expect(await read(env)).toEqual({ state: "unavailable" });
  expect(calls).toHaveLength(1);

  clock += 1_999;
  expect(await read(env)).toEqual({ state: "unavailable" });
  expect(calls).toHaveLength(1);

  clock += 1;
  expect(await read(env)).toEqual(ready);
  expect(calls).toHaveLength(2);

  clock += 9_999;
  expect(await read(env)).toEqual(ready);
  expect(calls).toHaveLength(2);
});

// Non-RED pin for issue item 1: passes at base and kills cache keys that omit the token file.
test("token-file change bypasses the cache", async () => {
  const dir = tmpDir("llamactl-penumbra-token-");
  const firstTokenFile = join(dir, "first-token");
  const secondTokenFile = join(dir, "second-token");
  writeFileSync(firstTokenFile, "fixture-first-token\n");
  writeFileSync(secondTokenFile, "fixture-second-token\n");
  const { calls, impl } = recordingFetch(() => Response.json({ handoffs: [] }));
  const read = createPenumbraHandoffReader({ fetch: impl });
  const env = {
    LLAMACTL_PENUMBRA_URL: FAKE_ORIGIN,
    LLAMACTL_PENUMBRA_TOKEN_FILE: firstTokenFile,
  };

  expect(await read(env)).toEqual({ state: "ready", handoffs: [] });
  expect(await read({ ...env, LLAMACTL_PENUMBRA_TOKEN_FILE: secondTokenFile })).toEqual({
    state: "ready",
    handoffs: [],
  });
  expect(calls).toHaveLength(2);
  expect(calls[1]!.authorization).toBe("Bearer fixture-second-token");
});

// Non-RED pin: passes at base and fixes the accepted token-size boundary at exactly 4 KiB.
test("accepts a 4096-byte token", async () => {
  const dir = tmpDir("llamactl-penumbra-token-");
  const tokenFile = join(dir, "edge-token");
  writeFileSync(tokenFile, "b".repeat(4096));
  const { calls, impl } = recordingFetch(() => Response.json({ handoffs: [] }));

  const result = await createPenumbraHandoffReader({ fetch: impl })({
    LLAMACTL_PENUMBRA_URL: FAKE_ORIGIN,
    LLAMACTL_PENUMBRA_TOKEN_FILE: tokenFile,
  });

  expect(result).toEqual({ state: "ready", handoffs: [] });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.authorization).toBe("Bearer " + "b".repeat(4096));
});

// Non-RED pin for README item 3: passes at base and pins the documented loopback URL forms.
test.each([
  ["HTTP://127.0.0.1:9", true],
  ["http://127.1:9", true],
  ["http://127.0.0.1:9/", true],
  ["http://localhost:9", false],
  ["http://[::1]:9", false],
  ["https://127.0.0.1:9", false],
  ["http://127.0.0.1:9/x", false],
  ["http://127.0.0.1:9/?q=1", false],
  ["http://u:p@127.0.0.1:9", false],
] as const)("pins the README wording on accepted URL forms: %s", async (origin, accepted) => {
  const dir = tmpDir("llamactl-penumbra-token-");
  const tokenFile = join(dir, "url-token");
  writeFileSync(tokenFile, "fixture-url-token\n");
  const { calls, impl } = recordingFetch(() => Response.json({ handoffs: [] }));

  const result = await createPenumbraHandoffReader({ fetch: impl })({
    LLAMACTL_PENUMBRA_URL: origin,
    LLAMACTL_PENUMBRA_TOKEN_FILE: tokenFile,
  });

  if (accepted) {
    expect(result).toEqual({ state: "ready", handoffs: [] });
    expect(calls).toHaveLength(1);
  } else {
    expect(result).toEqual({ state: "unavailable" });
    expect(calls).toHaveLength(0);
  }
});
