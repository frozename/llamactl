import { config as cfgMod, makePinnedFetch } from '@llamactl/remote';
import { getGlobals, isLocalDispatch } from '../dispatcher.js';

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

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const out: ParsedArgs = { readinessTimeoutSec: 30, json: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { error: '__help' };
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    const eq = arg.indexOf('=');
    if (!arg.startsWith('--') || eq < 0) {
      return { error: `agent rollback: flags must be --key=value (${arg})` };
    }
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    if (key === 'readiness-timeout') {
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return { error: `agent rollback: --readiness-timeout must be a positive integer (got ${value})` };
      }
      out.readinessTimeoutSec = n;
    } else {
      return { error: `agent rollback: unknown flag --${key}` };
    }
  }
  return out;
}

export async function runAgentRollback(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    if (parsed.error === '__help') {
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
  const nodeName = globals.nodeName!;
  const cfg = cfgMod.loadConfig();
  const ctx = cfg.contexts.find((c) => c.name === (globals.contextName ?? cfg.currentContext));
  if (!ctx) {
    process.stderr.write(`agent rollback: context not found in kubeconfig\n`);
    return 1;
  }
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  const node = cluster?.nodes.find((n) => n.name === nodeName);
  if (!node) {
    process.stderr.write(`agent rollback: node '${nodeName}' not found in current context\n`);
    return 1;
  }
  if (node.endpoint.startsWith('inproc://')) {
    process.stderr.write(`agent rollback: '${nodeName}' is a local in-proc node — nothing to roll back\n`);
    return 1;
  }
  const user = cfg.users.find((u) => u.name === ctx.user);
  if (!user) {
    process.stderr.write(`agent rollback: user '${ctx.user}' not found in kubeconfig\n`);
    return 1;
  }
  const token = cfgMod.resolveToken(user);

  const url = `${node.endpoint.replace(/\/$/, '')}/agent/rollback`;
  process.stderr.write(`agent rollback: requesting swap on ${url}\n`);

  const pinnedFetch = makePinnedFetch(node);
  let res: Response;
  try {
    res = await pinnedFetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (err) {
    process.stderr.write(`agent rollback: request failed: ${(err as Error).message}\n`);
    return 1;
  }
  const text = await res.text();
  if (!res.ok) {
    process.stderr.write(`agent rollback: agent rejected (${res.status}): ${text}\n`);
    return 1;
  }
  let result: {
    ok: boolean;
    restoredAt: string;
    newSha256: string;
    rolledOutSha256: string;
  };
  try {
    result = JSON.parse(text);
  } catch {
    process.stderr.write(`agent rollback: invalid response: ${text}\n`);
    return 1;
  }
  process.stderr.write(
    `agent rollback: swap accepted — rolled-out=${result.rolledOutSha256.slice(0, 12)}\u2026 ` +
      `now-active=${result.newSha256.slice(0, 12)}\u2026\n`,
  );

  const healthUrl = `${node.endpoint.replace(/\/$/, '')}/healthz`;
  process.stderr.write(`agent rollback: waiting for respawn (timeout ${parsed.readinessTimeoutSec}s)\u2026\n`);
  const deadline = Date.now() + parsed.readinessTimeoutSec * 1000;
  let healthy = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const probe = await pinnedFetch(healthUrl, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      });
      if (probe.ok) {
        healthy = true;
        break;
      }
    } catch {
      // launchd respawning — keep polling
    }
  }
  if (!healthy) {
    process.stderr.write(
      `agent rollback: WARNING \u2014 agent did not come back within ${parsed.readinessTimeoutSec}s.\n` +
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
