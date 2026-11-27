import { Database } from "bun:sqlite";
import { dirname, isAbsolute } from "node:path";

import { closeSync, constants, fstatSync, lstatSync, openSync } from "../safe-fs.js";

export const CAPTURE_PATH = "/fleet/request-capture";
export const REQUEST_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const RETENTION_MS = 15 * 60 * 1000;
const ROWS = 50;

export interface RequestSummary {
  id: string;
  at: number;
  path: string;
  model: string | null;
  status: number;
  durationMs: number;
}

export interface CapturedRequest extends RequestSummary {
  firstByteMs: number | null;
  cancelled: boolean;
  truncated: boolean;
  request: unknown;
  response: unknown;
}

export function configuredCapture(): string | undefined {
  const path = process.env["LLAMACTL_REQUEST_CAPTURE_FILE"];
  return path === "" ? undefined : path;
}

function privateDb(path: string): Database {
  if (!isAbsolute(path)) throw new Error("Capture file must use an absolute path");
  const parent = lstatSync(dirname(path));
  const uid = process.getuid?.();
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) {
    throw new Error("Capture directory must be private");
  }
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW | constants.O_RDWR,
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
      throw new Error("Capture file must be private");
    }
  } finally {
    closeSync(fd);
  }
  const db = new Database(path, { strict: true });
  try {
    db.run("PRAGMA busy_timeout=25");
    db.run("PRAGMA secure_delete=ON");
    db.run(`
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY, at INTEGER NOT NULL, expires INTEGER NOT NULL,
        path TEXT NOT NULL, model TEXT, status INTEGER NOT NULL, durationMs INTEGER NOT NULL,
        detail TEXT NOT NULL
      );`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function pruneCaptures(path: string, now = Date.now()): void {
  const db = privateDb(path);
  try {
    db.run("DELETE FROM captures WHERE expires <= ?", [now]);
  } finally {
    db.close();
  }
}

export function storeCapture(path: string, capture: CapturedRequest, now = Date.now()): void {
  const db = privateDb(path);
  try {
    db.transaction(() => {
      db.run("DELETE FROM captures WHERE expires <= ?", [now]);
      db.run("INSERT INTO captures VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        capture.id,
        capture.at,
        now + RETENTION_MS,
        capture.path,
        capture.model,
        capture.status,
        capture.durationMs,
        JSON.stringify(capture),
      ]);
      db.run(
        "DELETE FROM captures WHERE id IN (SELECT id FROM captures ORDER BY expires DESC, rowid DESC LIMIT -1 OFFSET ?)",
        [ROWS],
      );
    })();
  } finally {
    db.close();
  }
}

export function listCaptures(path: string, now = Date.now()): RequestSummary[] {
  const db = privateDb(path);
  try {
    return db
      .query<
        RequestSummary,
        [number, number]
      >("SELECT id, at, path, model, status, durationMs FROM captures WHERE expires > ? ORDER BY expires DESC, rowid DESC LIMIT ?")
      .all(now, ROWS);
  } finally {
    db.close();
  }
}

export function findCapture(path: string, id: string, now = Date.now()): CapturedRequest | null {
  const db = privateDb(path);
  try {
    const row = db
      .query<
        { detail: string },
        [string, number]
      >("SELECT detail FROM captures WHERE id = ? AND expires > ?")
      .get(id, now);
    return row ? (JSON.parse(row.detail) as CapturedRequest) : null;
  } finally {
    db.close();
  }
}

export function captureResponse(id?: string): Response {
  const path = configuredCapture();
  const headers = { "cache-control": "no-store" };
  try {
    if (id === undefined) {
      return Response.json(
        { enabled: path !== undefined, requests: path ? listCaptures(path) : [] },
        { headers },
      );
    }
    const result = path ? findCapture(path, id) : null;
    if (result) return Response.json(result, { headers });
    return Response.json({ error: "request_not_found" }, { status: 404, headers });
  } catch {
    return Response.json({ error: "capture_unavailable" }, { status: 503, headers });
  }
}
