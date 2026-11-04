// Same-origin guards + session helpers for the #410 P2b console server
// (plan §0.8/§0.9, folds in the plan's session.ts). Checks are pure
// Request → Response | null predicates; server.ts runs them in the
// order Host → (api) Sec-Fetch-Site/Origin → cookie → batch path.

import { randomBytes, timingSafeEqual } from "node:crypto";

export interface ConsoleSession {
  cookieName: string;
  nonce: string;
  setCookie: string;
}

export function newConsoleSession(port: number): ConsoleSession {
  const nonce = randomBytes(32).toString("hex");
  const cookieName = `llamactl_console_${String(port)}`;
  return {
    cookieName,
    nonce,
    setCookie: `${cookieName}=${nonce}; Path=/; HttpOnly; SameSite=Strict`,
  };
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function checkConsoleHost(req: Request, port: number): Response | null {
  const host = req.headers.get("host") ?? "";
  if (host !== `127.0.0.1:${String(port)}` && host !== `localhost:${String(port)}`) {
    return jsonError(421, "misdirected_host");
  }
  return null;
}

export function checkConsoleSameOrigin(req: Request): Response | null {
  if (req.headers.get("sec-fetch-site") !== "same-origin") {
    return jsonError(403, "cross_site_request_forbidden");
  }
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== `http://${req.headers.get("host") ?? ""}`) {
    return jsonError(403, "cross_site_request_forbidden");
  }
  return null;
}

function cookieValue(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const pair = part.trim();
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}

export function checkConsoleSession(req: Request, session: ConsoleSession): Response | null {
  const presented = cookieValue(req.headers.get("cookie"), session.cookieName);
  if (presented === null) return jsonError(401, "invalid_session");
  const expected = Buffer.from(session.nonce, "utf8");
  const actual = Buffer.from(presented, "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return jsonError(401, "invalid_session");
  }
  return null;
}

export type ConsoleTrpcPathCheck =
  | { ok: true; names: string[] }
  | { ok: false; status: number; error: "bad_batch" | "procedure_not_exposed" };

const MAX_BATCH_SEGMENTS = 16;

export function checkConsoleTrpcPath(
  pathname: string,
  allowed?: ReadonlySet<string>,
): ConsoleTrpcPathCheck {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { ok: false, status: 400, error: "bad_batch" };
  }
  const segments = decoded.split(",");
  if (segments.some((segment) => segment === "")) {
    return { ok: false, status: 400, error: "bad_batch" };
  }
  if (segments.length > MAX_BATCH_SEGMENTS) {
    return { ok: false, status: 400, error: "bad_batch" };
  }
  if (new Set(segments).size !== segments.length) {
    return { ok: false, status: 400, error: "bad_batch" };
  }
  if (allowed !== undefined && segments.some((segment) => !allowed.has(segment))) {
    return { ok: false, status: 404, error: "procedure_not_exposed" };
  }
  return { ok: true, names: segments };
}
