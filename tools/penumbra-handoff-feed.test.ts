import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeReadError, startHandoffFeed } from "./penumbra-handoff-feed.js";

test("serves active and bounded recent terminal metadata without exposing handoff content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-handoff-feed-"));
  const path = join(dir, "db.sqlite");
  const db = new Database(path, { create: true });
  let feed: ReturnType<typeof startHandoffFeed> | undefined;
  try {
    db.exec(`CREATE TABLE handoffs (
      handoff_id TEXT NOT NULL, ts TEXT NOT NULL, to_agent TEXT NOT NULL,
      status TEXT NOT NULL, resolved_at TEXT, message TEXT NOT NULL
    )`);
    const insert = db.query("INSERT INTO handoffs VALUES (?, ?, ?, ?, ?, 'private prompt')");
    const ts = "2026-11-25T00:00:00Z";
    insert.run("active-old", ts, "kapitsa", "dispatched", null);
    insert.run("terminal-old", ts, "gufo", "completed", ts);
    for (let index = 0; index < 270; index++) {
      insert.run(`recent-${String(index).padStart(3, "0")}`, ts, "gufo", "completed", ts);
    }
    feed = startHandoffFeed({ databasePath: path, port: 0, token: "a-test-feed-token" });
    const url = new URL("/handoffs", feed.url);
    const headers = { authorization: "Bearer a-test-feed-token" };
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers, method: "POST" })).status).toBe(405);
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { handoffs } = (await response.json()) as {
      handoffs: {
        handoff_id: string;
        ts: string;
        to_agent: string;
        status: string;
        resolved_at: string | null;
      }[];
    };
    expect(handoffs).toHaveLength(31);
    expect(handoffs[0]).toEqual({
      handoff_id: "active-old",
      ts,
      to_agent: "kapitsa",
      status: "dispatched",
      resolved_at: null,
    });
    expect(handoffs[1]).toEqual({
      handoff_id: "recent-269",
      ts,
      to_agent: "gufo",
      status: "completed",
      resolved_at: ts,
    });
    expect(handoffs.map((row) => row.handoff_id)).not.toContain("terminal-old");
  } finally {
    if (feed) await feed.stop(true);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logs a redacted database error when the handoffs table is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-handoff-feed-"));
  const path = join(dir, "db.sqlite");
  const db = new Database(path, { create: true });
  db.close();
  const lines: string[] = [];
  let feed: ReturnType<typeof startHandoffFeed> | undefined;
  try {
    feed = startHandoffFeed({
      databasePath: path,
      port: 0,
      token: "a-test-feed-token",
      log: (line: string) => lines.push(line),
    });
    const response = await fetch(new URL("/handoffs", feed.url), {
      headers: { authorization: "Bearer a-test-feed-token" },
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/no such table/);
    expect(lines[0]).toMatch(/SQLiteError/);
    expect(lines[0]).not.toContain("a-test-feed-token");
    expect(lines[0]).not.toContain(dir);
  } finally {
    if (feed) await feed.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logs a redacted database error when the database file is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-handoff-feed-"));
  const lines: string[] = [];
  let feed: ReturnType<typeof startHandoffFeed> | undefined;
  try {
    feed = startHandoffFeed({
      databasePath: join(dir, "missing.sqlite"),
      port: 0,
      token: "a-test-feed-token",
      log: (line: string) => lines.push(line),
    });
    const response = await fetch(new URL("/handoffs", feed.url), {
      headers: { authorization: "Bearer a-test-feed-token" },
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/unable to open database/i);
    expect(lines[0]).not.toContain("a-test-feed-token");
    expect(lines[0]).not.toContain(dir);
  } finally {
    if (feed) await feed.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does not log database errors for unauthenticated requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-handoff-feed-"));
  const path = join(dir, "db.sqlite");
  const db = new Database(path, { create: true });
  db.close();
  const lines: string[] = [];
  let feed: ReturnType<typeof startHandoffFeed> | undefined;
  try {
    feed = startHandoffFeed({
      databasePath: path,
      port: 0,
      token: "a-test-feed-token",
      log: (line: string) => lines.push(line),
    });
    const response = await fetch(new URL("/handoffs", feed.url));
    expect(response.status).toBe(401);
    expect(lines).toHaveLength(0);
  } finally {
    if (feed) await feed.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("describeReadError replaces the database path and token in the error message", () => {
  const databasePath = "/fixture/state/handoffs.sqlite";
  const token = "fake-feed-token-0000";
  const error = new Error(`cannot open ${databasePath} with Bearer ${token}`);

  const description = describeReadError(error, { databasePath, port: 0, token });

  expect(description).toBe("Error: cannot open <database> with Bearer <redacted>");
  expect(description).not.toContain(databasePath);
  expect(description).not.toContain(token);
});
