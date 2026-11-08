/**
 * Subprocess peer agent for test/openai-proxy.abort.test.ts (#316).
 *
 * Runs a real startAgentServer — TLS + bearer, the full /v1/* dispatch —
 * so the parent test can drive a two-agent chain (client → agent A →
 * this agent → fake engine) over production-shaped hops. Everything is
 * env-driven: the parent passes sandboxed storage dirs, the fake
 * engine's port, the TLS cert/key paths and the expected bearer hash.
 * Prints {"url": ...} on stdout once listening, then serves until
 * killed. NOT run under `bun test` — spawned directly with `bun`.
 */
import { startAgentServer } from "../../src/server/serve.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    process.stderr.write(`abort-peer-agent: missing required env ${name}\n`);
    process.exit(1);
  }
  return value;
}

process.env["DEV_STORAGE"] = requiredEnv("ABORT_PEER_DEV_STORAGE");
process.env["LOCAL_AI_RUNTIME_DIR"] = requiredEnv("ABORT_PEER_RUNTIME_DIR");
process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
process.env["LLAMA_CPP_PORT"] = requiredEnv("ABORT_PEER_ENGINE_PORT");
process.env["LLAMACTL_NODE_NAME"] = "abort-peer-agent";
// Keep the subprocess on the legacy dispatch the flag-gated unified
// proxy would otherwise replace, and off any inherited kubeconfig.
Reflect.deleteProperty(process.env, "LLAMACTL_UNIFIED_PROXY");
Reflect.deleteProperty(process.env, "LLAMACTL_CONFIG");

const agent = startAgentServer({
  bindHost: "127.0.0.1",
  port: 0,
  tokenHash: requiredEnv("ABORT_PEER_TOKEN_HASH"),
  tls: { certPath: requiredEnv("ABORT_PEER_CERT"), keyPath: requiredEnv("ABORT_PEER_KEY") },
  advertiseMdns: false,
});
process.stdout.write(`${JSON.stringify({ url: agent.url })}\n`);
