import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { config as cfgMod, makePinnedFetch } from '@llamactl/remote';
import { getGlobals, isLocalDispatch } from '../dispatcher.js';

/**
 * `llamactl agent update --node <n> [--binary <path> | --from-release vX.Y]`
 *
 * Push a new agent binary to a remote node + restart it. Hits the
 * agent's `/agent/update` HTTP endpoint over the same pinned-TLS +
 * bearer-auth surface every other tRPC call uses, so credentials +
 * cert pinning come straight from kubeconfig — no SSH, no scp.
 *
 * The agent verifies the SHA-256 we declare in the X-Sha256 header,
 * stages the binary alongside its own `process.execPath`, atomic-
 * renames over itself, snapshots the previous binary as
 * `<execPath>.previous`, and exits 0 so launchd's KeepAlive respawns
 * into the new build. We then poll the agent's tRPC `nodeFacts` /
 * `/healthz` until the new build comes back up (or rollback hint
 * surfaces on timeout).
 *
 * macOS TCC: a binary signed with a stable identity (see
 * `artifacts build-agent --sign=…`) doesn't re-prompt on swap;
 * an ad-hoc-signed binary will trigger a Removable Volumes / Files
 * & Folders prompt on the target machine and must be approved on
 * its physical/VNC display before the agent's first read of
 * /Volumes/* succeeds.
 */

const USAGE = `llamactl agent update — push a new agent binary to a remote node

USAGE:
  llamactl --node <name> agent update --binary=<path>
  llamactl --node <name> agent update --from-release=<tag> [--repo=<owner/repo>]

FLAGS:
  --binary=<path>        Local path to the new llamactl-agent binary.
  --from-release=<tag>   Fetch from GitHub Releases via 'artifacts fetch'
                         before pushing. Mutually exclusive with --binary.
  --repo=<owner/repo>    With --from-release; default: frozename/llamactl.
  --readiness-timeout=<s> How long to wait for the new agent to come
                         back online after restart. Default: 30.
  --json                 Emit a single JSON record instead of human text.

The push goes over the existing pinned-TLS + bearer-auth surface
the kubeconfig already trusts. Requires --node to point at a
non-local agent.
`;

interface ParsedArgs {
  binary?: string;
  fromRelease?: string;
  repo: string;
  readinessTimeoutSec: number;
  json: boolean;
}

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const out: ParsedArgs = {
    repo: 'frozename/llamactl',
    readinessTimeoutSec: 30,
    json: false,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { error: '__help' };
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    const eq = arg.indexOf('=');
    if (!arg.startsWith('--') || eq < 0) {
      return { error: `agent update: flags must be --key=value (${arg})` };
    }
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    switch (key) {
      case 'binary':
        out.binary = value;
        break;
      case 'from-release':
        out.fromRelease = value;
        break;
      case 'repo':
        out.repo = value;
        break;
      case 'readiness-timeout': {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n <= 0) {
          return { error: `agent update: --readiness-timeout must be a positive integer (got ${value})` };
        }
        out.readinessTimeoutSec = n;
        break;
      }
      default:
        return { error: `agent update: unknown flag --${key}` };
    }
  }
  if (!out.binary && !out.fromRelease) {
    return { error: 'agent update: pass --binary=<path> or --from-release=<tag>' };
  }
  if (out.binary && out.fromRelease) {
    return { error: 'agent update: --binary and --from-release are mutually exclusive' };
  }
  return out;
}

export async function runAgentUpdate(argv: string[]): Promise<number> {
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
    process.stderr.write(
      `agent update: --node is required + must point at a non-local agent\n`,
    );
    return 1;
  }
  const nodeName = globals.nodeName!;
  const cfg = cfgMod.loadConfig();
  const ctx = cfg.contexts.find((c) => c.name === (globals.contextName ?? cfg.currentContext));
  if (!ctx) {
    process.stderr.write(`agent update: context not found in kubeconfig\n`);
    return 1;
  }
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  const node = cluster?.nodes.find((n) => n.name === nodeName);
  if (!node) {
    process.stderr.write(`agent update: node '${nodeName}' not found in current context\n`);
    return 1;
  }
  if (node.endpoint.startsWith('inproc://')) {
    process.stderr.write(`agent update: '${nodeName}' is a local in-proc node — cannot self-replace\n`);
    return 1;
  }
  const user = cfg.users.find((u) => u.name === ctx.user);
  if (!user) {
    process.stderr.write(`agent update: user '${ctx.user}' not found in kubeconfig\n`);
    return 1;
  }
  const token = cfgMod.resolveToken(user);

  // Resolve binary path: explicit --binary or fetched via 'artifacts fetch'.
  let binaryPath = parsed.binary;
  if (parsed.fromRelease) {
    const { infraArtifactsFetch } = await import('@llamactl/remote');
    const target = (node.facts?.platform as string | undefined) ?? 'darwin-arm64';
    process.stderr.write(`agent update: fetching ${parsed.repo} ${parsed.fromRelease} for ${target}…\n`);
    const fetchResult = await infraArtifactsFetch.fetchAgentRelease({
      repo: parsed.repo,
      version: parsed.fromRelease,
      target,
      verifySig: 'best-effort',
    });
    if (!fetchResult.ok) {
      process.stderr.write(`agent update: fetch failed: ${fetchResult.reason} — ${fetchResult.message}\n`);
      return 1;
    }
    binaryPath = fetchResult.path;
  }
  if (!binaryPath || !existsSync(binaryPath)) {
    process.stderr.write(`agent update: binary not found at ${binaryPath}\n`);
    return 1;
  }
  const bytes = readFileSync(binaryPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const size = statSync(binaryPath).size;

  const url = `${node.endpoint.replace(/\/$/, '')}/agent/update`;
  process.stderr.write(
    `agent update: pushing ${(size / (1024 * 1024)).toFixed(1)} MB (sha256=${sha256.slice(0, 12)}…) to ${url}\n`,
  );

  const pinnedFetch = makePinnedFetch(node);
  let res: Response;
  try {
    res = await pinnedFetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'x-sha256': sha256,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: bytes as any,
    });
  } catch (err) {
    process.stderr.write(`agent update: push failed: ${(err as Error).message}\n`);
    return 1;
  }
  const text = await res.text();
  if (!res.ok) {
    process.stderr.write(`agent update: agent rejected push (${res.status}): ${text}\n`);
    return 1;
  }
  let result: {
    ok: boolean;
    oldSha256: string;
    newSha256: string;
    oldSize: number;
    newSize: number;
    installedAt: string;
    previousAt: string;
  };
  try {
    result = JSON.parse(text);
  } catch {
    process.stderr.write(`agent update: invalid response from agent: ${text}\n`);
    return 1;
  }
  process.stderr.write(
    `agent update: swap accepted — old=${result.oldSha256.slice(0, 12)}… new=${result.newSha256.slice(0, 12)}…\n` +
      `  installed: ${result.installedAt}\n  previous:  ${result.previousAt}\n`,
  );

  // Poll the agent's /healthz over the same pinned cert until the
  // respawned binary comes up (or fall back to a clear timeout
  // message that points at .previous for rollback).
  process.stderr.write(`agent update: waiting for respawn (timeout ${parsed.readinessTimeoutSec}s)…\n`);
  const healthUrl = `${node.endpoint.replace(/\/$/, '')}/healthz`;
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
      // connection refused while launchd respawns — keep polling.
    }
  }
  if (!healthy) {
    process.stderr.write(
      `agent update: WARNING — agent did not come back within ${parsed.readinessTimeoutSec}s.\n` +
        `  rollback hint (run on the target node):\n` +
        `    mv ${result.previousAt} ${result.installedAt} && launchctl kickstart -k gui/$(id -u)/com.llamactl.agent\n`,
    );
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ ...result, healthy: false }, null, 2)}\n`);
    }
    return 1;
  }
  process.stderr.write(`agent update: ok — agent back online\n`);
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ ...result, healthy: true }, null, 2)}\n`);
  }
  return 0;
}
