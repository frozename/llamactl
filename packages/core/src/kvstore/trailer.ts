import * as fs from "node:fs";
import { dirname } from "node:path";

import { type KvStorage, safeWrite } from "./storage.js";

export const EXT_FLAG_TOOL_MAP = 1 << 0;
export const EXT_FLAG_SESSION_TITLE = 1 << 1;

// ext_flags reserved for future use; THINKING_VISIBLE + RESPONSES_VISIBLE removed 2026-05-24 — never had consumers. Re-add when needed.

export interface KvTrailer {
  extFlags: number;
  toolMap?: Record<string, string>;
  sessionTitle?: string;
}

function trailerPath(slotFile: string): string {
  return `${slotFile}.trailer.json`;
}

export function readTrailer(slotFile: string): KvTrailer | null {
  const file = trailerPath(slotFile);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as KvTrailer;
  return parsed;
}

export function writeTrailer(
  slotFile: string,
  trailer: KvTrailer,
  storage?: KvStorage,
): { ok: true } | { ok: false; reason: "enospc" | "other"; error: Error } {
  const target = trailerPath(slotFile);
  const body = JSON.stringify(trailer);
  const fallback = { registry_write_fail_total: 0 } as KvStorage;
  return safeWrite(storage ?? fallback, () => {
    fs.mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${String(process.pid)}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, target);
  });
}
