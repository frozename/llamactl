import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import {
  InferenceRpcVersionSchema,
  InferenceServiceClaimsV1Schema,
} from "../inference/rpc-schema.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "../safe-fs.js";
import { llamactlHome, nonEmpty } from "./env.js";

/**
 * A worker-RPC service credential (P4.1): stored only as the SHA-256 of
 * the token (the agent bearer's mechanics), bound to the claims every
 * request presenting it gets. Rotate by adding the new credential's
 * binding, moving callers over, then removing the old one; revoke by
 * removing the binding.
 */
export const AgentWorkerRpcCredentialSchema = InferenceServiceClaimsV1Schema.extend({
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
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
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  workerRpc: AgentWorkerRpcSchema.optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = nonEmpty(env["LLAMACTL_AGENT_DIR"]);
  if (override) return override;
  const base = llamactlHome(env);
  return base;
}

export function defaultAgentConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultAgentDir(env), "agent.yaml");
}

export function loadAgentConfig(path: string = defaultAgentConfigPath()): AgentConfig {
  if (!existsSync(path)) {
    throw new Error(`agent config not found at ${path} — run 'llamactl agent init' first`);
  }
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw) as unknown;
  return AgentConfigSchema.parse(parsed);
}

export function saveAgentConfig(
  config: AgentConfig,
  path: string = defaultAgentConfigPath(),
): void {
  AgentConfigSchema.parse(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(config), "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * Reads agent.yaml's worker-RPC block afresh on every call, so a
 * rotated or revoked credential, or a stopped advertisement, applies to
 * the next request without a restart. A file that is missing or does
 * not parse yields undefined: nothing advertised, no credential accepted.
 */
export function workerRpcSettingsReader(
  path: string = defaultAgentConfigPath(),
): () => AgentWorkerRpc | undefined {
  return () => {
    try {
      return loadAgentConfig(path).workerRpc;
    } catch {
      return undefined;
    }
  };
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
