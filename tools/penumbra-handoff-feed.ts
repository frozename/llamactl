import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";

const ACTIVE_STATES = "('pending','approved','dispatched')";
const TERMINAL_STATES = "('completed','failed','expired','redirected','rejected')";
const FIELDS = "handoff_id, ts, to_agent, status, resolved_at";

export interface HandoffFeedOptions {
  databasePath: string;
  port: number;
  token: string;
  log?: (_line: string) => void;
}

function readHandoffs(databasePath: string): unknown[] {
  const db = new Database(databasePath, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout=250");
    // Penumbra indexes status for active work. Bound the terminal walk by insertion
    // order before sorting it, so a dashboard refresh never scans the history.
    const active = db
      .query(
        `SELECT ${FIELDS} FROM handoffs WHERE status IN ${ACTIVE_STATES}
              ORDER BY ts DESC, rowid DESC LIMIT 30`,
      )
      .all();
    const terminal = db
      .query(
        `WITH recent AS (
                SELECT ${FIELDS}, rowid AS seq FROM handoffs ORDER BY rowid DESC LIMIT 256
              )
              SELECT ${FIELDS} FROM recent WHERE status IN ${TERMINAL_STATES}
              ORDER BY COALESCE(resolved_at, ts) DESC, seq DESC LIMIT 30`,
      )
      .all();
    return [...active, ...terminal];
  } finally {
    db.close();
  }
}

export function describeReadError(error: unknown, options: HandoffFeedOptions): string {
  let description: string;
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? ` ${error.code}` : "";
    description = `${error.name}${code}: ${error.message}`;
  } else {
    description = "unknown error";
  }
  let redacted = description.replaceAll(options.databasePath, "<database>");
  if (options.token !== "") redacted = redacted.replaceAll(options.token, "<redacted>");
  return redacted.replaceAll(/\s+/g, " ").slice(0, 300);
}

export function startHandoffFeed(options: HandoffFeedOptions): ReturnType<typeof Bun.serve> {
  const expected = Buffer.from(`Bearer ${options.token}`);
  const log =
    options.log ??
    ((line: string): void => {
      console.error(line);
    });
  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    fetch(request) {
      if (new URL(request.url).pathname !== "/handoffs") return new Response(null, { status: 404 });
      const presented = Buffer.from(request.headers.get("authorization") ?? "");
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        return new Response(null, { status: 401 });
      }
      if (request.method !== "GET") return new Response(null, { status: 405 });
      const headers = { "cache-control": "no-store" };
      try {
        return Response.json({ handoffs: readHandoffs(options.databasePath) }, { headers });
      } catch (error) {
        log(`penumbra handoff feed: read failed: ${describeReadError(error, options)}`);
        return new Response(null, { status: 503, headers });
      }
    },
  });
}

if (import.meta.main) {
  const [databasePath, tokenPath, portArg] = Bun.argv.slice(2);
  const port = Number(portArg);
  if (
    !databasePath ||
    !isAbsolute(databasePath) ||
    !tokenPath ||
    !isAbsolute(tokenPath) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(
      "Usage: bun tools/penumbra-handoff-feed.ts ABSOLUTE_DB_PATH ABSOLUTE_TOKEN_PATH PORT",
    );
  }
  const token = (await Bun.file(tokenPath).text()).trim();
  if (!token) throw new Error("Missing handoff feed credential");
  const server = startHandoffFeed({ databasePath, port, token });
  console.log(`Penumbra handoff feed listening on ${server.url.origin}`);
}
