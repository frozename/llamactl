import { dirname, join } from "node:path";
import {
  isMap,
  isNode,
  isScalar,
  parseDocument,
  parse as parseYaml,
  stringify as stringifyYaml,
} from "yaml";
import { z } from "zod";

import {
  InferenceRpcVersionSchema,
  InferenceServiceClaimsV1Schema,
} from "../inference/rpc-schema.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "../safe-fs.js";
import { llamactlHome, nonEmpty } from "./env.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * A worker-RPC service credential (P4.1): stored only as the SHA-256 of
 * the token (the agent bearer's mechanics), bound to the claims every
 * request presenting it gets. Rotate by adding the new credential's
 * binding, moving callers over, then removing the old one; revoke by
 * removing the binding.
 */
export const AgentWorkerRpcCredentialSchema = InferenceServiceClaimsV1Schema.extend({
  tokenHash: z.string().regex(SHA256_HEX),
});
export type AgentWorkerRpcCredential = z.infer<typeof AgentWorkerRpcCredentialSchema>;

/**
 * The optional InferenceRpcV1 worker block. Absent or with no versions,
 * the RPC is not advertised; emptying `versions` stops the advertisement
 * for new requests while active streams drain.
 */
export const AgentWorkerRpcSchema = z.object({
  versions: z.array(InferenceRpcVersionSchema).default([]),
  serviceCredentials: z.array(AgentWorkerRpcCredentialSchema).default([]),
});
export type AgentWorkerRpc = z.infer<typeof AgentWorkerRpcSchema>;

export const AgentConfigSchema = z.object({
  apiVersion: z.literal("llamactl/v1"),
  kind: z.literal("AgentConfig"),
  nodeName: z.string().optional(),
  bindHost: z.string().default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(7843),
  certPath: z.string(),
  keyPath: z.string(),
  tokenHash: z.string().regex(SHA256_HEX),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /**
   * The optional worker-RPC block, opaque here so a malformed one never
   * stops the agent, its token rotation or its status: only its reader
   * validates it, and an invalid block is not advertised. Re-saves write
   * it back as it was read.
   */
  workerRpc: z.unknown().optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/** The blocks only their readers validate; a re-save keeps their source text. */
const OPAQUE_BLOCKS = ["workerRpc"] as const;

interface BlockSource {
  /** The block's value as read, to tell an unchanged block from an edited one. */
  json: string;
  /** The block's source text, key included. */
  text: string;
}

/** Each file's opaque blocks as last loaded, keyed by path. */
const loadedBlocks = new Map<string, Map<string, BlockSource>>();

export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = nonEmpty(env["LLAMACTL_AGENT_DIR"]);
  if (override) return override;
  const base = llamactlHome(env);
  return base;
}

export function defaultAgentConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultAgentDir(env), "agent.yaml");
}

/** The source span of a top-level `key: value` pair, from the key to the value's end. */
function pairSpan(pair: { key: unknown; value: unknown }): [string, number, number] | null {
  if (!isScalar(pair.key) || typeof pair.key.value !== "string") return null;
  const keyRange = pair.key.range;
  const valueRange = isNode(pair.value) ? pair.value.range : undefined;
  if (!keyRange || !valueRange) return null;
  return [pair.key.value, keyRange[0], valueRange[2]];
}

function blockSources(raw: string, value: unknown): Map<string, BlockSource> {
  const out = new Map<string, BlockSource>();
  const doc = parseDocument(raw);
  if (!isMap(doc.contents) || typeof value !== "object" || value === null) return out;
  for (const pair of doc.contents.items) {
    const span = pairSpan(pair);
    if (span === null || !(OPAQUE_BLOCKS as readonly string[]).includes(span[0])) continue;
    const [key, start, end] = span;
    const json = JSON.stringify((value as Record<string, unknown>)[key]) as string | undefined;
    if (json !== undefined) out.set(key, { json, text: raw.slice(start, end).trimEnd() });
  }
  return out;
}

export function loadAgentConfig(path: string = defaultAgentConfigPath()): AgentConfig {
  if (!existsSync(path)) {
    throw new Error(`agent config not found at ${path} — run 'llamactl agent init' first`);
  }
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw) as unknown;
  const config = AgentConfigSchema.parse(parsed);
  loadedBlocks.set(path, blockSources(raw, parsed));
  return config;
}

function sameValues(a: unknown, b: Record<string, unknown>): boolean {
  if (typeof a !== "object" || a === null) return false;
  const read = a as Record<string, unknown>;
  const keys = new Set([...Object.keys(read), ...Object.keys(b)]);
  return [...keys].every(
    (key) =>
      (JSON.stringify(read[key]) as string | undefined) ===
      (JSON.stringify(b[key]) as string | undefined),
  );
}

/**
 * The YAML to write: an opaque block unchanged since it was loaded from
 * this file is written back as its source text, byte for byte, as long as
 * the result reads as the same config.
 */
function serialize(config: AgentConfig, path: string): string {
  const plain = stringifyYaml(config);
  const sources = loadedBlocks.get(path);
  if (sources === undefined) return plain;
  const rest: Record<string, unknown> = { ...config };
  const kept: string[] = [];
  for (const key of OPAQUE_BLOCKS) {
    const source = sources.get(key);
    const json = JSON.stringify(rest[key]) as string | undefined;
    if (source === undefined || json !== source.json) continue;
    Reflect.deleteProperty(rest, key);
    kept.push(`${source.text}\n`);
  }
  if (kept.length === 0) return plain;
  const spliced = `${stringifyYaml(rest)}${kept.join("")}`;
  try {
    return sameValues(parseYaml(spliced), config) ? spliced : plain;
  } catch {
    return plain;
  }
}

export function saveAgentConfig(
  config: AgentConfig,
  path: string = defaultAgentConfigPath(),
): void {
  AgentConfigSchema.parse(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialize(config, path), "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}

function warnIgnored(path: string, block: string, reason: string): void {
  process.stderr.write(`[agent] ${path}: ignoring the ${block} block (${reason})\n`);
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "invalid";
  const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${at}${issue.message}`;
}

/**
 * A reader of one agent.yaml block that re-reads the file only when it
 * changed: the same inode, size, mtime and ctime reuse the last result,
 * so a request costs one stat and a rotation still applies to the next
 * request without a restart. A file that is missing or does not parse
 * yields undefined.
 */
function agentYamlBlockReader<T>(
  path: string,
  select: (config: AgentConfig) => T | undefined,
): () => T | undefined {
  let stamp: string | null = null;
  let value: T | undefined;
  return () => {
    let next: string;
    try {
      const stat = statSync(path);
      next = [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    } catch {
      stamp = null;
      return undefined;
    }
    if (next === stamp) return value;
    stamp = next;
    try {
      value = select(AgentConfigSchema.parse(parseYaml(readFileSync(path, "utf8"))));
    } catch {
      value = undefined;
    }
    return value;
  };
}

/**
 * Reads agent.yaml's worker-RPC block, re-reading the file whenever it
 * changes, so a rotated or revoked credential, or a stopped
 * advertisement, applies to the next request without a restart. A block
 * that does not validate, or that binds the operator bearer's hash as a
 * service credential, is ignored with a warning: nothing is advertised
 * and no credential is accepted, while the agent itself runs on.
 */
export function workerRpcSettingsReader(
  path: string = defaultAgentConfigPath(),
): () => AgentWorkerRpc | undefined {
  return agentYamlBlockReader(path, (config) => {
    if (config.workerRpc === undefined) return undefined;
    const parsed = AgentWorkerRpcSchema.safeParse(config.workerRpc);
    if (!parsed.success) {
      warnIgnored(path, "workerRpc", firstIssue(parsed.error));
      return undefined;
    }
    if (parsed.data.serviceCredentials.some((b) => b.tokenHash === config.tokenHash)) {
      warnIgnored(path, "workerRpc", "a service credential reuses the operator bearer's hash");
      return undefined;
    }
    return parsed.data;
  });
}

export interface BootstrapBlob {
  url: string;
  fingerprint: string;
  token: string;
  certificate: string; // PEM — required by Bun's fetch to trust the self-signed cert
}

export function encodeBootstrap(blob: BootstrapBlob): string {
  return Buffer.from(JSON.stringify(blob), "utf8").toString("base64url");
}

export function decodeBootstrap(encoded: string): BootstrapBlob {
  const raw = Buffer.from(encoded, "base64url").toString("utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed["url"] !== "string") throw new Error("bootstrap: missing url");
  if (typeof parsed["fingerprint"] !== "string") throw new Error("bootstrap: missing fingerprint");
  if (typeof parsed["token"] !== "string") throw new Error("bootstrap: missing token");
  if (typeof parsed["certificate"] !== "string") throw new Error("bootstrap: missing certificate");
  return {
    url: parsed["url"],
    fingerprint: parsed["fingerprint"],
    token: parsed["token"],
    certificate: parsed["certificate"],
  };
}
