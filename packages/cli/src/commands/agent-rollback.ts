import type { Config } from "@llamactl/remote";

import { config as cfgMod, makePinnedFetch } from "@llamactl/remote";

import { getGlobals, isLocalDispatch } from "../dispatcher.js";
import { required } from "../required.js";
import { hasBoolean, hasString, isRecord } from "../runtime-shape.js";

/**
 * `llamactl --node <n> agent rollback`
 *
 * POSTs `/agent/rollback` on the target agent — the agent swaps
 * `<execPath>` and `<execPath>.previous` and exits 0 so launchd
 * respawns into the prior binary. Symmetric: a second rollback
 * flips back to whatever was there before.
 *
 * Same auth + pinned-TLS surface as `agent update`. Polls the
 * agent's `/healthz` post-restart to confirm the rollback target
 * actually started up; surfaces a clear hint when not.
 */

const USAGE = `llamactl agent rollback — restore the previous agent binary on a remote node

USAGE:
  llamactl --node <name> agent rollback [--readiness-timeout=<s>] [--json]

The agent's previous binary lives at \`<install-path>.previous\` —
written by the last \`agent update\` push. Calling rollback swaps
that back into place, restarts the agent, and confirms it came
back online.

Symmetric: calling rollback twice flips between the two binaries.
This makes "I pushed a bad build, fix it" a single repeated
command.
`;

interface ParsedArgs {
  readinessTimeoutSec: number;
  json: boolean;
}

function applyRollbackFlag(arg: string, out: ParsedArgs): { error: string } | null {
  if (arg === "--help" || arg === "-h") return { error: "__help" };
  if (arg === "--json") {
    out.json = true;
    return null;
  }
  const eq = arg.indexOf("=");
  if (!arg.startsWith("--") || eq < 0) {
    return { error: `agent rollback: flags must be --key=value (${arg})` };
  }
  const key = arg.slice(2, eq);
  const value = arg.slice(eq + 1);
  if (key !== "readiness-timeout") {
    return { error: `agent rollback: unknown flag --${key}` };
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return {
      error: `agent rollback: --readiness-timeout must be a positive integer (got ${value})`,
    };
  }
  out.readinessTimeoutSec = n;
  return null;
}

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const out: ParsedArgs = { readinessTimeoutSec: 30, json: false };
  for (const arg of argv) {
    const err = applyRollbackFlag(arg, out);
    if (err) return err;
  }
  return out;
}

type KubeNode = Config["clusters"][number]["nodes"][number];

interface RollbackResponse {
  ok: boolean;
  restoredAt: string;
  newSha256: string;
  rolledOutSha256: string;
}

function resolveRollbackNode(
  nodeName: string,
  contextName: string | null | undefined,
): { node: KubeNode; token: string } | { error: string } {
  const cfg = cfgMod.loadConfig();
  const ctx = cfg.contexts.find((c) => c.name === (contextName ?? cfg.currentContext));
  if (!ctx) {
    return { error: "agent rollback: context not found in kubeconfig" };
  }
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  const node = cluster?.nodes.find((n) => n.name === nodeName);
  if (!node) {
    return { error: `agent rollback: node '${nodeName}' not found in current context` };
  }
  if (node.endpoint.startsWith("inproc://")) {
    return {
      error: `agent rollback: '${nodeName}' is a local in-proc node — nothing to roll back`,
    };
  }
  const user = cfg.users.find((u) => u.name === ctx.user);
  if (!user) {
    return { error: `agent rollback: user '${ctx.user}' not found in kubeconfig` };
  }
  return { node, token: cfgMod.resolveToken(user) };
}

function parseRollbackResponse(text: string): RollbackResponse | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isAgentRollbackResponse(parsed)) throw new Error("invalid rollback response");
    return parsed;
  } catch {
    return null;
  }
}

export async function runAgentRollback(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    if (parsed.error === "__help") {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }

  const globals = getGlobals();
  if (isLocalDispatch()) {
    process.stderr.write(`agent rollback: --node is required + must point at a non-local agent\n`);
    return 1;
  }
  const nodeName = required(globals.nodeName);
  const resolved = resolveRollbackNode(nodeName, globals.contextName);
  if ("error" in resolved) {
    process.stderr.write(`${resolved.error}\n`);
    return 1;
  }
  const { node, token } = resolved;

  const url = `${node.endpoint.replace(/\/$/, "")}/agent/rollback`;
  process.stderr.write(`agent rollback: requesting swap on ${url}\n`);

  const pinnedFetch = makePinnedFetch(node);
  let res: Response;
  try {
    res = await pinnedFetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (err) {
    process.stderr.write(`agent rollback: request failed: ${(err as Error).message}\n`);
    return 1;
  }
  const text = await res.text();
  if (!res.ok) {
    process.stderr.write(`agent rollback: agent rejected (${String(res.status)}): ${text}\n`);
    return 1;
  }
  const result = parseRollbackResponse(text);
  if (result === null) {
    process.stderr.write(`agent rollback: invalid response: ${text}\n`);
    return 1;
  }
  process.stderr.write(
    `agent rollback: swap accepted — rolled-out=${result.rolledOutSha256.slice(0, 12)}\u2026 ` +
      `now-active=${result.newSha256.slice(0, 12)}\u2026\n`,
  );

  const healthUrl = `${node.endpoint.replace(/\/$/, "")}/healthz`;
  process.stderr.write(
    `agent rollback: waiting for respawn (timeout ${String(parsed.readinessTimeoutSec)}s)\u2026\n`,
  );
  const deadline = Date.now() + parsed.readinessTimeoutSec * 1000;
  const healthy = await pollAgentHealth(pinnedFetch, healthUrl, token, deadline);
  return reportRollbackOutcome(healthy, result, parsed);
}

async function pollAgentHealth(
  pinnedFetch: ReturnType<typeof makePinnedFetch>,
  healthUrl: string,
  token: string,
  deadline: number,
): Promise<boolean> {
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const probe = await pinnedFetch(healthUrl, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      });
      if (probe.ok) {
        return true;
      }
    } catch {
      // launchd respawning — keep polling
    }
  }
  return false;
}

function reportRollbackOutcome(
  healthy: boolean,
  result: RollbackResponse,
  parsed: ParsedArgs,
): number {
  if (!healthy) {
    process.stderr.write(
      `agent rollback: WARNING \u2014 agent did not come back within ${String(parsed.readinessTimeoutSec)}s.\n` +
        `  the rolled-out binary may have been corrupt; manual intervention required.\n`,
    );
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ ...result, healthy: false }, null, 2)}\n`);
    }
    return 1;
  }
  process.stderr.write(`agent rollback: ok — agent back online with prior binary\n`);
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ ...result, healthy: true }, null, 2)}\n`);
  }
  return 0;
}

function isAgentRollbackResponse(value: unknown): value is RollbackResponse {
  return (
    isRecord(value) &&
    hasBoolean(value, "ok") &&
    hasString(value, "restoredAt") &&
    hasString(value, "newSha256") &&
    hasString(value, "rolledOutSha256")
  );
}
