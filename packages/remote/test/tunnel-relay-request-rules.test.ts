import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TunnelServer } from "../src/tunnel/index.js";
import type { TunnelJournalEntry } from "../src/tunnel/journal.js";
import type { TunnelReq, TunnelRes } from "../src/tunnel/messages.js";

import { existsSync, mkdtempSync, readFileSync, rmSync } from "../src/safe-fs.js";
import { generateToken } from "../src/server/auth.js";
import { handleTunnelRelay } from "../src/server/tunnel-relay.js";

// Pin the HTTP edge of handleTunnelRelay: validation order, send vs
// sendSubscribe wiring, SSE error-code mapping and journal discipline.
// One rule per test; the stub records what the relay forwarded.

const dir = mkdtempSync(join(tmpdir(), "tunnel-relay-rules-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const operator = generateToken();

interface StubOpts {
  res?: TunnelRes;
  err?: Error;
  iterable?: AsyncIterable<unknown>;
}

function stubTunnel(opts: StubOpts = {}): {
  calls: { nodeName: string; req: Omit<TunnelReq, "type"> }[];
  subCalls: { nodeName: string; req: Omit<TunnelReq, "type"> }[];
  server: TunnelServer;
} {
  const calls: { nodeName: string; req: Omit<TunnelReq, "type"> }[] = [];
  const subCalls: { nodeName: string; req: Omit<TunnelReq, "type"> }[] = [];
  const server = {
    send: (nodeName: string, req: Omit<TunnelReq, "type">): Promise<TunnelRes> => {
      calls.push({ nodeName, req });
      if (opts.res !== undefined) return Promise.resolve(opts.res);
      return Promise.reject(opts.err ?? new Error("stubTunnel: no res configured"));
    },
    sendSubscribe: (nodeName: string, req: Omit<TunnelReq, "type">): AsyncIterable<unknown> => {
      subCalls.push({ nodeName, req });
      if (opts.iterable === undefined) throw new Error("stubTunnel: no iterable configured");
      return opts.iterable;
    },
  } as unknown as TunnelServer;
  return { calls, subCalls, server };
}

function journalPathFor(name: string): string {
  return join(dir, `${name}.jsonl`);
}

function readJournal(path: string): TunnelJournalEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TunnelJournalEntry);
}

interface ReqOpts {
  method?: string;
  bearer?: string;
  body?: unknown;
  rawBody?: string;
}

function buildReq(rawUrl: string, opts: ReqOpts = {}): { req: Request; url: URL } {
  const url = new URL(rawUrl);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.bearer !== undefined) headers["authorization"] = `Bearer ${opts.bearer}`;
  const init: RequestInit = { method: opts.method ?? "POST", headers };
  if (opts.rawBody !== undefined) init.body = opts.rawBody;
  else if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  return { req: new Request(url.href, init), url };
}

interface DoneData {
  ok: boolean;
  error?: { code: string; message: string };
}

function doneFrameData(body: string): DoneData {
  const frame = body
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f.startsWith("event: done"))
    .pop();
  const dataLine = (frame ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("data:"));
  return JSON.parse((dataLine ?? "null").slice(5).trim()) as DoneData;
}

function emptyIterable(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<unknown>> =>
        Promise.resolve({ value: undefined, done: true }),
    }),
  };
}

function rejectingIterable(thrown: unknown): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<unknown>> =>
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is one of the cases under test.
        Promise.reject(thrown),
    }),
  };
}

describe("handleTunnelRelay request rules", () => {
  test("GET with an operator bearer is 405, send is never called, no journal", async () => {
    const { calls, server } = stubTunnel();
    const journal = journalPathFor("get-405");
    const { req, url } = buildReq("http://agent.test/tunnel-relay/gpu1", {
      method: "GET",
      bearer: operator.token,
    });
    const res = await handleTunnelRelay(req, url, server, operator.hash, journal);
    expect(res.status).toBe(405);
    expect(await res.text()).toBe("method not allowed");
    expect(calls).toHaveLength(0);
    expect(existsSync(journal)).toBe(false);
  });

  test("POST /tunnel-relay/ with a valid body is 400 missing node name", async () => {
    const { server } = stubTunnel();
    const { req, url } = buildReq("http://agent.test/tunnel-relay/", {
      bearer: operator.token,
      body: { method: "catalog.list" },
    });
    const res = await handleTunnelRelay(req, url, server, operator.hash, journalPathFor("no-node"));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("missing node name");
  });

  test("the same empty-name request without a bearer is 401 — auth runs first", async () => {
    const { server } = stubTunnel();
    const { req, url } = buildReq("http://agent.test/tunnel-relay/", {
      body: { method: "catalog.list" },
    });
    const res = await handleTunnelRelay(
      req,
      url,
      server,
      operator.hash,
      journalPathFor("no-node-noauth"),
    );
    expect(res.status).toBe(401);
  });

  test("a body without method is 400 missing or invalid method, send not called", async () => {
    const { calls, server } = stubTunnel();
    const { req, url } = buildReq("http://agent.test/tunnel-relay/gpu1", {
      bearer: operator.token,
      body: { input: { a: 1 } },
    });
    const res = await handleTunnelRelay(
      req,
      url,
      server,
      operator.hash,
      journalPathFor("no-method"),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("missing or invalid method");
    expect(calls).toHaveLength(0);
  });

  test("a non-string method is 400 missing or invalid method, send not called", async () => {
    const { calls, server } = stubTunnel();
    const { req, url } = buildReq("http://agent.test/tunnel-relay/gpu1", {
      bearer: operator.token,
      body: { method: 42 },
    });
    const res = await handleTunnelRelay(
      req,
      url,
      server,
      operator.hash,
      journalPathFor("bad-method"),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("missing or invalid method");
    expect(calls).toHaveLength(0);
  });

  test("malformed JSON is 400 invalid json and writes no journal", async () => {
    const { calls, server } = stubTunnel();
    const journal = journalPathFor("bad-json");
    const { req, url } = buildReq("http://agent.test/tunnel-relay/gpu1", {
      bearer: operator.token,
      rawBody: "{ not json",
    });
    const res = await handleTunnelRelay(req, url, server, operator.hash, journal);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid json");
    expect(calls).toHaveLength(0);
    expect(existsSync(journal)).toBe(false);
  });

  test("a percent-encoded node name is decoded before send and journaling", async () => {
    const { calls, server } = stubTunnel({ res: { type: "res", id: "r", result: null } });
    const journal = journalPathFor("encoded-node");
    const { req, url } = buildReq("http://agent.test/tunnel-relay/gpu%20alpha", {
      bearer: operator.token,
      body: { method: "catalog.list" },
    });
    const res = await handleTunnelRelay(req, url, server, operator.hash, journal);
    expect(res.status).toBe(200);
    expect(calls[0]?.nodeName).toBe("gpu alpha");
    const call = readJournal(journal).find((e) => e.kind === "tunnel-relay-call");
    if (call?.kind !== "tunnel-relay-call") throw new Error("missing tunnel-relay-call entry");
    expect(call.nodeName).toBe("gpu alpha");
  });

  test("omitted type defaults params to query and a fresh id; explicit mutation forwards", async () => {
    const { calls, server } = stubTunnel({ res: { type: "res", id: "r", result: null } });
    const journal = journalPathFor("type-forwarding");
    const first = buildReq("http://agent.test/tunnel-relay/gpu1", {
      bearer: operator.token,
      body: { method: "catalog.list", input: { a: 1 } },
    });
    await handleTunnelRelay(first.req, first.url, server, operator.hash, journal);
    const second = buildReq("http://agent.test/tunnel-relay/gpu1", {
      bearer: operator.token,
      body: { method: "catalog.list", type: "mutation", input: { b: 2 } },
    });
    await handleTunnelRelay(second.req, second.url, server, operator.hash, journal);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.req.params).toEqual({ type: "query", input: { a: 1 } });
    expect(calls[1]?.req.params).toEqual({ type: "mutation", input: { b: 2 } });
    const firstId = calls[0]?.req.id;
    expect(typeof firstId).toBe("string");
    expect(firstId?.length).toBeGreaterThan(0);
    expect(firstId).not.toBe(calls[1]?.req.id);
  });

  test("success returns the stub TunnelRes verbatim and journals metadata only", async () => {
    const tunnelRes: TunnelRes = { type: "res", id: "r1", result: { rows: [1, 2] } };
    const { server } = stubTunnel({ res: tunnelRes });
    const journal = journalPathFor("success");
    const { req, url } = buildReq("http://agent.test/tunnel-relay/gpu1", {
      bearer: operator.token,
      body: { method: "catalog.list", input: { secret: "do-not-journal" } },
    });
    const res = await handleTunnelRelay(req, url, server, operator.hash, journal);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(tunnelRes);
    const entries = readJournal(journal);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry?.kind !== "tunnel-relay-call") throw new Error("missing tunnel-relay-call entry");
    expect(entry.method).toBe("catalog.list");
    expect(entry.ok).toBe(true);
    expect(typeof entry.durationMs).toBe("number");
    expect("input" in entry).toBe(false);
    expect("result" in entry).toBe(false);
  });

  test("a send throw is a 502 tunnel-send-failed and journals exactly one error", async () => {
    const { server } = stubTunnel({ err: new Error("boom") });
    const journal = journalPathFor("send-fail");
    const { req, url } = buildReq("http://agent.test/tunnel-relay/gpu1", {
      bearer: operator.token,
      body: { method: "catalog.list" },
    });
    const res = await handleTunnelRelay(req, url, server, operator.hash, journal);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      type: "res",
      id: "",
      error: { code: "tunnel-send-failed", message: "boom" },
    });
    const entries = readJournal(journal);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry?.kind !== "tunnel-relay-error") throw new Error("missing tunnel-relay-error entry");
    expect(entry.code).toBe("tunnel-send-failed");
    expect(entry.message).toBe("boom");
    expect(entry.method).toBe("catalog.list");
  });

  test("?stream=1 takes the non-stream path: send is called, sendSubscribe is not", async () => {
    const { calls, subCalls, server } = stubTunnel({
      res: { type: "res", id: "r", result: { ok: 1 } },
    });
    const { req, url } = buildReq("http://agent.test/tunnel-relay/gpu1?stream=1", {
      bearer: operator.token,
      body: { method: "catalog.list" },
    });
    const res = await handleTunnelRelay(
      req,
      url,
      server,
      operator.hash,
      journalPathFor("stream-1"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(calls).toHaveLength(1);
    expect(subCalls).toHaveLength(0);
  });

  test("?stream=true calls sendSubscribe with type subscription even for a query body", async () => {
    const { calls, subCalls, server } = stubTunnel({ iterable: emptyIterable() });
    const { req, url } = buildReq("http://agent.test/tunnel-relay/gpu1?stream=true", {
      bearer: operator.token,
      body: { method: "catalog.list", type: "query", input: { q: 1 } },
    });
    const res = await handleTunnelRelay(
      req,
      url,
      server,
      operator.hash,
      journalPathFor("stream-true"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.text();
    expect(calls).toHaveLength(0);
    expect(subCalls).toHaveLength(1);
    expect(subCalls[0]?.req.params).toEqual({ type: "subscription", input: { q: 1 } });
  });

  test("a non-Error rejection ends the SSE stream with tunnel-send-failed", async () => {
    const { server } = stubTunnel({ iterable: rejectingIterable("kaput") });
    const { req, url } = buildReq("http://agent.test/tunnel-relay/gpu1?stream=true", {
      bearer: operator.token,
      body: { method: "catalog.list", type: "subscription" },
    });
    const res = await handleTunnelRelay(
      req,
      url,
      server,
      operator.hash,
      journalPathFor("sse-nonerror"),
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(doneFrameData(await res.text())).toEqual({
      ok: false,
      error: { code: "tunnel-send-failed", message: "kaput" },
    });
  });

  test("a numeric err.code is not propagated — falls back to tunnel-send-failed", async () => {
    const err = Object.assign(new Error("x"), { code: 42 });
    const { server } = stubTunnel({ iterable: rejectingIterable(err) });
    const { req, url } = buildReq("http://agent.test/tunnel-relay/gpu1?stream=true", {
      bearer: operator.token,
      body: { method: "catalog.list", type: "subscription" },
    });
    const res = await handleTunnelRelay(
      req,
      url,
      server,
      operator.hash,
      journalPathFor("sse-num-code"),
    );
    expect(doneFrameData(await res.text())).toEqual({
      ok: false,
      error: { code: "tunnel-send-failed", message: "x" },
    });
  });

  test("a string err.code is propagated verbatim into the done frame", async () => {
    const err = Object.assign(new Error("x"), { code: "custom-code" });
    const { server } = stubTunnel({ iterable: rejectingIterable(err) });
    const { req, url } = buildReq("http://agent.test/tunnel-relay/gpu1?stream=true", {
      bearer: operator.token,
      body: { method: "catalog.list", type: "subscription" },
    });
    const res = await handleTunnelRelay(
      req,
      url,
      server,
      operator.hash,
      journalPathFor("sse-str-code"),
    );
    expect(doneFrameData(await res.text())).toEqual({
      ok: false,
      error: { code: "custom-code", message: "x" },
    });
  });
});
