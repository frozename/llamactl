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

export type PenumbraHandoffs =
  | { state: "unconfigured" | "unavailable" }
  | { state: "ready"; handoffs: z.infer<typeof Handoff>[] };

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

async function readHandoffs(response: Response): Promise<z.infer<typeof Handoff>[]> {
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

export async function readPenumbraHandoffs(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PenumbraHandoffs> {
  const origin = env["LLAMACTL_PENUMBRA_URL"];
  const tokenFile = env["LLAMACTL_PENUMBRA_TOKEN_FILE"];
  if (!origin && !tokenFile) return { state: "unconfigured" };
  if (!origin || !tokenFile) return { state: "unavailable" };
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
    url.searchParams.set(
      "status",
      "pending,approved,dispatched,completed,failed,expired,redirected,rejected",
    );
    const response = await fetch(url, {
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
    const isActive = (row: z.infer<typeof Handoff>): boolean =>
      row.status === "dispatched" || row.status === "approved" || row.status === "pending";
    const active = handoffs.filter(isActive);
    const terminal = handoffs.filter((row) => !isActive(row));
    return {
      state: "ready",
      handoffs: redactDeep([...active.slice(0, 30), ...terminal.slice(0, 30)]),
    };
  } catch {
    return { state: "unavailable" };
  }
}
