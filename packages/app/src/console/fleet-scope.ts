// #410 P5a-3c, pure scope model behind the fleet and nodes views: the
// shared nodeTest cadence, per-query reachability tone+label, the
// consoleNodeRows projection (kind fallback, default/tab flags, the
// dispatchable gate and fleet deep links), the exposed-workloads filter
// and the tab-node card's secret-safe env/facts rows. Relative imports
// only, so bun tests load it without the "@/" alias.

import type { ConsoleNodeList } from "./node-scope";

import { dispatchableNodes } from "./node-scope";
import { consoleHref } from "./router";

export const NODE_TEST_INTERVAL_MS = 30_000;

export type ReachabilityTone = "ok" | "err" | "idle";

export interface NodeReachability {
  tone: ReachabilityTone;
  label: string;
}

export interface ConsoleNodeRow {
  name: string;
  kind: string;
  endpoint: string | null;
  endpointHref: string | null;
  isDefault: boolean;
  isTabNode: boolean;
  dispatchable: boolean;
  newTabHref: string | null;
}

export interface ExposedWorkload {
  name: string;
  node: string;
  endpoint: string;
}

export interface CardEntry {
  key: string;
  value: string;
}

const HTTP_ENDPOINT = /^https?:\/\//;

const REDACTED = "[redacted]";

// Mirrors packages/remote/src/console/allowlist.ts. Defense in depth:
// if the server projection ever misses a secret key, the card still
// renders "set". Copied deliberately — console must not import
// @llamactl/remote.
const ENV_SECRET_KEY = /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unreachableLabel(error: unknown): string {
  const reason = typeof error === "string" && error !== "" ? error : "unknown";
  return `unreachable: ${reason}`;
}

export function nodeReachability(query: unknown): NodeReachability {
  const record = asRecord(query);
  if (record === null) return { tone: "idle", label: "checking" };
  if (record["isError"] === true) return { tone: "err", label: "unreachable" };
  const result = asRecord(record["data"]);
  if (result === null) return { tone: "idle", label: "checking" };
  if (result["ok"] === true) return { tone: "ok", label: "reachable" };
  if (result["ok"] === false) return { tone: "err", label: unreachableLabel(result["error"]) };
  return { tone: "idle", label: "checking" };
}

export function consoleNodeRows(nodeList: unknown, tabNode: string): ConsoleNodeRow[] {
  if (typeof nodeList !== "object" || nodeList === null) return [];
  const list = nodeList as ConsoleNodeList;
  if (!Array.isArray(list.nodes)) return [];
  const dispatchableNames = new Set(dispatchableNodes(list).map((entry) => entry.name));
  return list.nodes.map((entry) => {
    const endpoint = entry.endpoint ?? null;
    const endpointHref = endpoint !== null && HTTP_ENDPOINT.test(endpoint) ? endpoint : null;
    const dispatchable = dispatchableNames.has(entry.name);
    return {
      name: entry.name,
      kind: entry.effectiveKind ?? "agent",
      endpoint,
      endpointHref,
      isDefault: entry.name === list.defaultNode,
      isTabNode: entry.name === tabNode,
      dispatchable,
      newTabHref:
        dispatchable && entry.name !== tabNode
          ? consoleHref({ view: "fleet", node: entry.name })
          : null,
    };
  });
}

function toExposedWorkload(row: unknown): ExposedWorkload | null {
  const record = asRecord(row);
  if (record === null) return null;
  if (record["phase"] !== "Running") return null;
  const endpoint = record["endpoint"];
  if (typeof endpoint !== "string" || !HTTP_ENDPOINT.test(endpoint)) return null;
  const name = record["name"];
  const node = record["node"];
  return {
    name: typeof name === "string" ? name : "",
    node: typeof node === "string" ? node : "",
    endpoint,
  };
}

export function exposedWorkloads(rows: unknown): ExposedWorkload[] {
  if (!Array.isArray(rows)) return [];
  const exposed: ExposedWorkload[] = [];
  for (const row of rows) {
    const entry = toExposedWorkload(row);
    if (entry !== null) exposed.push(entry);
  }
  return exposed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function envValue(key: string, value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  if (text === REDACTED) return "set";
  if (ENV_SECRET_KEY.test(key) && text !== "") return "set";
  return text;
}

function factValue(facts: Record<string, unknown>, path: string[]): string | null {
  let current: unknown = facts;
  for (const hop of path) {
    const record = asRecord(current);
    if (record === null) return null;
    current = record[hop];
  }
  if (typeof current === "string") return current;
  if (typeof current === "number" || typeof current === "boolean" || typeof current === "bigint") {
    return String(current);
  }
  return null;
}

export function tabNodeCard(
  env: unknown,
  facts: unknown,
): { facts: CardEntry[]; env: CardEntry[] } {
  const envEntries: CardEntry[] = [];
  const envRecord = asRecord(env);
  if (envRecord !== null) {
    for (const [key, value] of Object.entries(envRecord)) {
      envEntries.push({ key, value: envValue(key, value) });
    }
    envEntries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  const factEntries: CardEntry[] = [];
  const factsRecord = asRecord(facts);
  if (factsRecord !== null) {
    for (const [key, path] of [
      ["nodeName", ["nodeName"]],
      ["platform", ["platform"]],
      ["versions.llamactl", ["versions", "llamactl"]],
      ["advertisedEndpoint", ["advertisedEndpoint"]],
      ["startedAt", ["startedAt"]],
    ] as const) {
      const value = factValue(factsRecord, [...path]);
      if (value !== null) factEntries.push({ key, value });
    }
  }

  return { facts: factEntries, env: envEntries };
}
