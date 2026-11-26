import { z } from "zod";

import { readFile } from "../safe-fs.js";
import { redactDeep } from "./redact.js";

const Handoff = z.object({
  handoff_id: z.string(),
  ts: z.string(),
  to_agent: z.string(),
  status: z.enum([
    "pending",
    "approved",
    "dispatched",
    "completed",
    "failed",
    "expired",
    "redirected",
    "rejected",
  ]),
  resolved_at: z.string().nullable(),
});

type HandoffRow = z.infer<typeof Handoff>;

export type PenumbraHandoffs =
  | { state: "unconfigured" | "unavailable" }
  | { state: "ready"; handoffs: HandoffRow[] };

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ROWS_PER_GROUP = 30;
const DEFAULT_CACHE_TTL_MS = 10_000;
// The Penumbra daemon's GET /handoffs honours `status` but has no row limit, and its
// terminal statuses grow without bound. Ask only for active work so each read stays
// small. Terminal history comes from a bounded feed such as
// tools/penumbra-handoff-feed.ts, which returns its own capped terminal rows.
const ACTIVE_STATUSES = ["pending", "approved", "dispatched"] as const;

function isActive(row: HandoffRow): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(row.status);
}

async function readHandoffs(response: Response): Promise<HandoffRow[]> {
  if (response.body === null) throw new Error("empty response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("response limit");
      text += decoder.decode(value, { stream: true });
    }
    const body = z
      .object({ handoffs: z.array(Handoff) })
      .parse(JSON.parse(text + decoder.decode()));
    return body.handoffs;
  } finally {
    await reader.cancel();
  }
}

async function fetchHandoffs(
  origin: string,
  tokenFile: string,
  fetchImpl: typeof fetch,
): Promise<PenumbraHandoffs> {
  try {
    const url = new URL(origin);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return { state: "unavailable" };

    const token = (await readFile(tokenFile, "utf8")).trim();
    if (!token) return { state: "unavailable" };
    url.pathname = "/handoffs";
    url.searchParams.set("status", ACTIVE_STATUSES.join(","));
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { state: "unavailable" };
    }
    const handoffs = await readHandoffs(response);
    handoffs.sort((a, b) => (b.resolved_at ?? b.ts).localeCompare(a.resolved_at ?? a.ts));
    const active = handoffs.filter(isActive);
    const terminal = handoffs.filter((row) => !isActive(row));
    return {
      state: "ready",
      handoffs: redactDeep([
        ...active.slice(0, MAX_ROWS_PER_GROUP),
        ...terminal.slice(0, MAX_ROWS_PER_GROUP),
      ]),
    };
  } catch {
    return { state: "unavailable" };
  }
}

export interface PenumbraHandoffReaderOptions {
  fetch?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
}

/**
 * Builds a handoff reader with a short shared cache. Every console tab polls the same
 * endpoint, so concurrent and repeated reads within `ttlMs` share one daemon request.
 */
export function createPenumbraHandoffReader(
  options: PenumbraHandoffReaderOptions = {},
): (env?: NodeJS.ProcessEnv) => Promise<PenumbraHandoffs> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  let cached: { key: string; expiresAt: number; result: Promise<PenumbraHandoffs> } | undefined;

  return (env = process.env) => {
    const origin = env["LLAMACTL_PENUMBRA_URL"];
    const tokenFile = env["LLAMACTL_PENUMBRA_TOKEN_FILE"];
    if (!origin && !tokenFile) return Promise.resolve({ state: "unconfigured" });
    if (!origin || !tokenFile) return Promise.resolve({ state: "unavailable" });

    const key = JSON.stringify([origin, tokenFile]);
    const at = now();
    if (cached?.key === key && at < cached.expiresAt) return cached.result;
    const result = fetchHandoffs(origin, tokenFile, options.fetch ?? fetch);
    cached = { key, expiresAt: at + ttlMs, result };
    return result;
  };
}

export const readPenumbraHandoffs = createPenumbraHandoffReader();
