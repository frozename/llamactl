// Best-effort per-node contact record (#221): `get workloads` writes when each
// node last answered and its latest error under <workloadsDir>/.node-contact,
// so `node ls` can name the last-seen time without contacting any node.
// Records are keyed by cluster as well as node name
// (<workloadsDir>/.node-contact/<cluster>/<node>.json), so a node named gpu1 in
// another context never reads as Unreachable here. Error text is redacted and
// collapsed to one control-free line before it is stored or printed.
// Every write is wrapped in try/catch: an unwritable workloads dir must never
// fail a command.
import { redactDeep, workloadStore } from "@llamactl/remote";
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
  cluster: string;
  node: string;
  lastSeen: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

const NODE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isValidName(name: string): boolean {
  return NODE_NAME_PATTERN.test(name) && name !== "." && name !== "..";
}

function contactFile(cluster: string, node: string, dir: string | undefined): string | null {
  if (!isValidName(cluster) || !isValidName(node)) return null;
  return join(dir ?? workloadStore.defaultWorkloadsDir(), ".node-contact", cluster, `${node}.json`);
}

// ANSI CSI/OSC sequences first, then any other C0/C1 control character.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * #221: the form of a node error that is safe to print, emit in --json and
 * persist: escape sequences and control characters stripped, collapsed to a
 * single line, and bearer tokens / URL userinfo redacted.
 */
export function sanitizeContactError(message: string): string {
  const oneLine = message
    .replaceAll(ANSI_ESCAPE, "")
    .replaceAll(CONTROL_CHARS, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return redactDeep(oneLine);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function parseRecord(value: unknown): NodeContactRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as Partial<Record<keyof NodeContactRecord, unknown>>;
  if (typeof rec.cluster !== "string" || typeof rec.node !== "string") return null;
  if (!isNullableString(rec.lastSeen) || !isNullableString(rec.lastError)) return null;
  if (!isNullableString(rec.lastErrorAt)) return null;
  return {
    cluster: rec.cluster,
    node: rec.node,
    lastSeen: rec.lastSeen,
    lastError: rec.lastError === null ? null : sanitizeContactError(rec.lastError),
    lastErrorAt: rec.lastErrorAt,
  };
}

export function readNodeContact(
  cluster: string,
  node: string,
  dir?: string,
): NodeContactRecord | null {
  const file = contactFile(cluster, node, dir);
  if (file === null) return null;
  try {
    if (!existsSync(file)) return null;
    const rec = parseRecord(JSON.parse(readFileSync(file, "utf8")));
    if (rec?.cluster !== cluster || rec.node !== node) return null;
    return rec;
  } catch {
    return null;
  }
}

function writeContact(rec: NodeContactRecord, dir: string | undefined): void {
  const file = contactFile(rec.cluster, rec.node, dir);
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

export function recordNodeAnswered(cluster: string, node: string, now: Date, dir?: string): void {
  writeContact(
    { cluster, node, lastSeen: now.toISOString(), lastError: null, lastErrorAt: null },
    dir,
  );
}

export function recordNodeFailed(
  cluster: string,
  node: string,
  message: string,
  now: Date,
  dir?: string,
): void {
  const prior = readNodeContact(cluster, node, dir);
  writeContact(
    {
      cluster,
      node,
      lastSeen: prior?.lastSeen ?? null,
      lastError: sanitizeContactError(message),
      lastErrorAt: now.toISOString(),
    },
    dir,
  );
}

export function clearNodeContact(cluster: string, node: string, dir?: string): void {
  const file = contactFile(cluster, node, dir);
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
