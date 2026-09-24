import type { ClusterNode } from "@llamactl/core/config/schema";
import type { UnifiedStreamEvent } from "@nova/contracts";

import { freshConfig } from "@llamactl/core/config/schema";
import { saveConfig, upsertNode } from "@llamactl/core/config/kubeconfig";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { router } from "../src/router.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "../src/safe-fs.js";
import { type ControllerClosedGuard, installControllerClosedGuard } from "./helpers.js";

/**
 * P0.2 router coverage — cancellation + provenance-honest usage over
 * REAL transports (Bun.serve fixtures, real spawned executables):
 *
 *   1. chatComplete forwards the tRPC resolver AbortSignal into the
 *      provider's upstream fetch — cancelling the caller kills the
 *      HTTP request the fixture is holding open.
 *   2. chatStream routes the adapter's onUsageObservation through the
 *      V2->V1 projection: cumulative usage lands as exactly one V1
 *      row; partial or absent usage lands nothing; the corpus never
 *      sees a V2 row.
 *   3. A node whose provider has no streamResponse falls back to
 *      createResponse and yields its real content + done
 *      'upstream' — never a content-less done.
 */

const ENV_KEYS = ["LLAMACTL_CONFIG", "LLAMACTL_USAGE_DIR", "LLAMACTL_CLI_JOURNAL_DIR"] as const;

let dir = "";
let upstream: ReturnType<typeof Bun.serve> | undefined;
let envBackup: Record<string, string | undefined> = {};

let controllerGuard: ControllerClosedGuard;
beforeAll(() => {
  controllerGuard = installControllerClosedGuard();
  envBackup = {};
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
});
afterAll(() => {
  controllerGuard.dispose();
});

afterEach(async () => {
  if (upstream !== undefined) {
    await upstream.stop(true);
    upstream = undefined;
  }
  for (const key of ENV_KEYS) {
    const prev = envBackup[key];
    if (prev === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = prev;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function writeConfig(nodes: ClusterNode[]): string {
  let cfg = freshConfig();
  for (const n of nodes) cfg = upsertNode(cfg, "home", n);
  const path = join(mkdtempSync(join(tmpdir(), "p02-cfg-")), "config");
  saveConfig(cfg, path);
  return path;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function usageRecords(): Record<string, unknown>[] {
  const udir = process.env["LLAMACTL_USAGE_DIR"];
  if (udir === undefined || !existsSync(udir)) return [];
  const rows: Record<string, unknown>[] = [];
  for (const f of readdirSync(udir)) {
    const lines = readFileSync(join(udir, f), "utf8").trim().split("\n");
    for (const l of lines) if (l) rows.push(JSON.parse(l) as Record<string, unknown>);
  }
  return rows;
}

describe("chatComplete — tRPC cancellation reaches the provider fetch", () => {
  test("cancelling the caller aborts the in-flight upstream request", async () => {
    dir = mkdtempSync(join(tmpdir(), "p02-router-"));
    let sawRequestResolve: () => void = () => {};
    let sawAbortResolve: () => void = () => {};
    const sawRequest = new Promise<void>((r) => {
      sawRequestResolve = r;
    });
    const sawAbort = new Promise<void>((r) => {
      sawAbortResolve = r;
    });
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        req.signal.addEventListener("abort", () => {
          sawAbortResolve();
        });
        sawRequestResolve();
        // Hang forever — only the client's abort ends this request.
        return new Promise<Response>(() => {});
      },
    });
    const cfgPath = writeConfig([
      {
        name: "gw",
        endpoint: "",
        kind: "gateway",
        cloud: { provider: "openai", baseUrl: `http://127.0.0.1:${String(upstream.port)}/v1` },
      },
    ]);
    process.env["LLAMACTL_CONFIG"] = cfgPath;

    const caller = new AbortController();
    const client = router.createCaller({}, { signal: caller.signal });
    const pending = client.chatComplete({
      node: "gw",
      request: { model: "m", messages: [{ role: "user", content: "hi" }] },
    });
    await sawRequest;
    caller.abort();
    await expect(pending).rejects.toBeTruthy();
    // The abort propagated through the provider's fetch to the wire.
    await Promise.race([
      sawAbort,
      new Promise((_, rej) => setTimeout(() => rej(new Error("upstream never saw abort")), 5_000)),
    ]);
  });
});

describe("chatStream — usage observation → V1 corpus", () => {
  function sseUpstream(frames: string[]): void {
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(frames.join(""), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
  }

  function streamEvents(): Promise<UnifiedStreamEvent[]> {
    const client = router.createCaller({});
    return (async () => {
      const gen = (await client.chatStream({
        node: "gw",
        request: { model: "m", messages: [{ role: "user", content: "hi" }] },
      })) as AsyncIterable<UnifiedStreamEvent>;
      const events: UnifiedStreamEvent[] = [];
      for await (const e of gen) events.push(e);
      return events;
    })();
  }

  function gwNode(): ClusterNode {
    return {
      name: "gw",
      endpoint: "",
      kind: "gateway",
      cloud: { provider: "openai", baseUrl: `http://127.0.0.1:${String(upstream!.port)}/v1` },
    };
  }

  test("cumulative stream usage writes exactly one V1 row; no 'v'/'observation' keys", async () => {
    dir = mkdtempSync(join(tmpdir(), "p02-usage-"));
    process.env["LLAMACTL_USAGE_DIR"] = join(dir, "usage");
    sseUpstream([
      `data: ${JSON.stringify({
        id: "c1",
        model: "served",
        choices: [{ index: 0, delta: { role: "assistant", content: "he" } }],
        usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 },
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "c1",
        model: "served",
        choices: [{ index: 0, delta: { content: "y" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
      })}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    process.env["LLAMACTL_CONFIG"] = writeConfig([gwNode()]);

    const events = await streamEvents();
    expect(events.some((e) => e.type === "done")).toBe(true);
    await flush();
    const rows = usageRecords();
    expect(rows).toHaveLength(1);
    const rec = rows[0]!;
    expect(rec["provider"]).toBe("openai");
    expect(rec["model"]).toBe("served");
    expect(rec["prompt_tokens"]).toBe(9);
    expect(rec["completion_tokens"]).toBe(4);
    expect(rec["total_tokens"]).toBe(13);
    expect("v" in rec).toBe(false);
    expect("observation" in rec).toBe(false);
  });

  test("a stream reporting no usage writes nothing", async () => {
    dir = mkdtempSync(join(tmpdir(), "p02-usage-"));
    process.env["LLAMACTL_USAGE_DIR"] = join(dir, "usage");
    sseUpstream([
      `data: ${JSON.stringify({
        id: "c1",
        model: "served",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
      })}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    process.env["LLAMACTL_CONFIG"] = writeConfig([gwNode()]);

    await streamEvents();
    await flush();
    expect(usageRecords()).toHaveLength(0);
  });
});

describe("chatStream — non-streaming provider fallback", () => {
  test("a provider without streamResponse emits its real content then done 'upstream'", async () => {
    dir = mkdtempSync(join(tmpdir(), "p02-fallback-"));
    process.env["LLAMACTL_USAGE_DIR"] = join(dir, "usage");
    process.env["LLAMACTL_CLI_JOURNAL_DIR"] = join(dir, "cli-journal");
    // A CLI-source virtual provider node: 'mac-mini.fake' resolves
    // to the agent's custom cli[] binding — a preset with
    // stream:false, so the adapter exposes no streamResponse and
    // the router falls back to createResponse.
    const cfgPath = writeConfig([
      {
        name: "mac-mini",
        endpoint: "https://mac-mini.lan:7843",
        kind: "agent",
        cli: [
          {
            name: "fake",
            preset: "custom",
            command: "/bin/sh",
            args: ["-c", "printf 'fallback-content'"],
            format: "text",
            timeoutMs: 10_000,
            advertisedModels: [],
            capabilities: ["reasoning"],
          },
        ],
      },
    ]);
    process.env["LLAMACTL_CONFIG"] = cfgPath;

    const client = router.createCaller({});
    const gen = (await client.chatStream({
      node: "mac-mini.fake",
      request: { model: "m", messages: [{ role: "user", content: "hi" }] },
    })) as AsyncIterable<UnifiedStreamEvent>;
    const events: UnifiedStreamEvent[] = [];
    for await (const e of gen) events.push(e);

    const chunks = events.filter(
      (e): e is Extract<UnifiedStreamEvent, { type: "chunk" }> => e.type === "chunk",
    );
    const done = events.filter(
      (e): e is Extract<UnifiedStreamEvent, { type: "done" }> => e.type === "done",
    );
    // Real content — not the pre-P0.2 content-less done.
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const text = chunks.map((c) => c.chunk.choices[0]?.delta.content ?? "").join("");
    expect(text).toBe("fallback-content");
    expect(done).toHaveLength(1);
    expect(done[0]!.completion).toBe("upstream");
  });
});
