// Best-effort per-node contact record (#221): `get workloads` writes when each
// node last answered and its latest error under <workloadsDir>/.node-contact,
// so `node ls` can name the last-seen time without contacting any node.
// Every write is wrapped in try/catch: an unwritable workloads dir must never
// fail a command.
import { workloadStore } from "@llamactl/remote";
import { dirname, join } from "node:path";

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "./safe-fs.js";

export interface NodeContactRecord {
  node: string;
  lastSeen: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

const NODE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isValidNodeName(node: string): boolean {
  return NODE_NAME_PATTERN.test(node) && node !== "." && node !== "..";
}

function contactFile(node: string, dir: string | undefined): string | null {
  if (!isValidNodeName(node)) return null;
  return join(dir ?? workloadStore.defaultWorkloadsDir(), ".node-contact", `${node}.json`);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function parseRecord(value: unknown): NodeContactRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as Partial<Record<keyof NodeContactRecord, unknown>>;
  if (typeof rec.node !== "string") return null;
  if (!isNullableString(rec.lastSeen) || !isNullableString(rec.lastError)) return null;
  if (!isNullableString(rec.lastErrorAt)) return null;
  return {
    node: rec.node,
    lastSeen: rec.lastSeen,
    lastError: rec.lastError,
    lastErrorAt: rec.lastErrorAt,
  };
}

export function readNodeContact(node: string, dir?: string): NodeContactRecord | null {
  const file = contactFile(node, dir);
  if (file === null) return null;
  try {
    if (!existsSync(file)) return null;
    return parseRecord(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function writeContact(node: string, rec: NodeContactRecord, dir: string | undefined): void {
  const file = contactFile(node, dir);
  if (file === null) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmpPath = `${file}.${String(process.pid)}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(rec, null, 2)}\n`);
    renameSync(tmpPath, file);
  } catch {
    // Best effort: an unwritable directory never fails the command.
  }
}

export function recordNodeAnswered(node: string, now: Date, dir?: string): void {
  writeContact(
    node,
    { node, lastSeen: now.toISOString(), lastError: null, lastErrorAt: null },
    dir,
  );
}

export function recordNodeFailed(node: string, message: string, now: Date, dir?: string): void {
  const prior = readNodeContact(node, dir);
  writeContact(
    node,
    {
      node,
      lastSeen: prior?.lastSeen ?? null,
      lastError: message,
      lastErrorAt: now.toISOString(),
    },
    dir,
  );
}

export function clearNodeContact(node: string, dir?: string): void {
  const file = contactFile(node, dir);
  if (file === null) return;
  try {
    rmSync(file, { force: true });
  } catch {
    // Best effort: a stuck record only costs one stale note.
  }
}

export function nodeUnreachable(
  rec: NodeContactRecord | null,
): rec is NodeContactRecord & { lastError: string } {
  return rec !== null && rec.lastError !== null;
}
