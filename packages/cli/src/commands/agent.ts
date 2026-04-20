import { existsSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  agentConfig as agentConfigMod,
  auth,
  startAgentServer,
  tls,
} from '@llamactl/remote';
import { runHeal } from './heal.js';

const USAGE = `Usage: llamactl agent <subcommand>

Subcommands:
  init [--dir=<path>] [--host=<host>] [--port=<n>] [--name=<node>] [--bind=<host>] [--san=<host,...>] [--json]
      Generate a TLS cert + bearer token, write agent.yaml.
      Default output is a human-readable summary + a 'llamactl node add'
      bootstrap line. With --json emits a single-line JSON record
      (configPath, nodeName, bindHost, port, fingerprint, blob) so the
      install-agent.sh flow can capture stdout and shell-extract the
      bootstrap blob without jq.
  serve [--dir=<path>] [--bind=<host>] [--port=<n>]
        [--dial-central=<wss-url>] [--central-bearer=<token>] [--tunnel-node-name=<name>]
        [--tunnel-central=true] [--tunnel-bearer=<token>] [--tunnel-journal=<path>]
      Run the node agent (blocks until SIGINT/SIGTERM).
      With --dial-central + --central-bearer, the agent additionally
      dials a central's /tunnel endpoint so its tRPC router is
      reachable through the reverse tunnel. The bearer can also be
      provided via the LLAMACTL_TUNNEL_BEARER env var.
      With --tunnel-central=true + --tunnel-bearer, the agent mounts
      /tunnel (WS upgrade) and /tunnel-relay on itself so NAT'd nodes
      can dial in. The bearer can also come from
      LLAMACTL_TUNNEL_CENTRAL_BEARER.
      --tunnel-journal overrides the JSONL audit path for tunnel
      events (default ~/.llamactl/tunnel/journal.jsonl, also
      settable via LLAMACTL_TUNNEL_JOURNAL).
  status [--dir=<path>]
      Print the agent config and its advertised URL.
  heal [flags]
      Run the self-healing loop (observe + journal + plan/execute).
      See 'llamactl agent heal --help' for full flag set. Also
      available as the top-level alias 'llamactl heal'.

All state lives under \$LLAMACTL_AGENT_DIR or \$DEV_STORAGE or ~/.llamactl.
`;

export async function runAgent(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'init':
      return runInit(rest);
    case 'serve':
      return runServe(rest);
    case 'status':
      return runStatus(rest);
    case 'heal':
      return runHeal(rest);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown agent subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}

interface InitFlags {
  dir: string;
  host: string;                // the hostname/IP this node advertises externally
  port: number;
  nodeName: string;
  bindHost: string;            // what Bun.serve binds to
  sans: string[];              // SANs baked into the cert
  json: boolean;               // emit single-line JSON instead of human summary
}

function parseInitFlags(args: string[]): InitFlags | { error: string } {
  const flags: InitFlags = {
    dir: agentConfigMod.defaultAgentDir(),
    host: '127.0.0.1',
    port: 7843,
    nodeName: hostname() || 'local',
    bindHost: '127.0.0.1',
    sans: [],
    json: false,
  };
  for (const arg of args) {
    // --json is a flag-only switch; everything else is --key=value.
    if (arg === '--json') {
      flags.json = true;
      continue;
    }
    const [k, v] = splitFlag(arg);
    if (v === undefined) return { error: `agent init: flag must be --key=value: ${arg}` };
    switch (k) {
      case '--dir': flags.dir = v; break;
      case '--host': flags.host = v; break;
      case '--port': {
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n < 0 || n > 65535) {
          return { error: `agent init: invalid --port: ${v}` };
        }
        flags.port = n;
        break;
      }
      case '--name': flags.nodeName = v; break;
      case '--bind': flags.bindHost = v; break;
      case '--san': flags.sans = v.split(',').map((s) => s.trim()).filter(Boolean); break;
      default: return { error: `agent init: unknown flag ${k}` };
    }
  }
  return flags;
}

async function runInit(args: string[]): Promise<number> {
  const parsed = parseInitFlags(args);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const f = parsed;
  mkdirSync(f.dir, { recursive: true });

  const configPath = join(f.dir, 'agent.yaml');
  if (existsSync(configPath)) {
    process.stderr.write(
      `agent config already exists at ${configPath}. Remove it (and the cert/key) to re-init.\n`,
    );
    return 1;
  }

  const sans = f.sans.length > 0 ? f.sans : [f.host, f.bindHost];
  const cert = await tls.generateSelfSignedCert({
    dir: f.dir,
    commonName: f.host,
    hostnames: dedupe(sans),
  });

  const token = auth.generateToken();
  const config: agentConfigMod.AgentConfig = {
    apiVersion: 'llamactl/v1',
    kind: 'AgentConfig',
    nodeName: f.nodeName,
    bindHost: f.bindHost,
    port: f.port,
    certPath: cert.certPath,
    keyPath: cert.keyPath,
    tokenHash: token.hash,
    fingerprint: cert.fingerprint,
  };
  agentConfigMod.saveAgentConfig(config, configPath);

  const url = `https://${f.host}:${f.port}`;
  const bootstrap = agentConfigMod.encodeBootstrap({
    url,
    fingerprint: cert.fingerprint,
    token: token.token,
    certificate: cert.certPem,
  });

  if (f.json) {
    // Single-line JSON so the install-agent.sh flow can capture stdout
    // with `$()` and shell-extract `blob` via sed without needing jq
    // on the target host. All side-effect logging goes to stderr.
    process.stderr.write(
      [
        `wrote ${configPath}`,
        `cert   ${cert.certPath}`,
        `key    ${cert.keyPath}`,
        `bind   ${f.bindHost}:${f.port}`,
        `fp     ${cert.fingerprint}`,
      ].join('\n') + '\n',
    );
    const record = {
      configPath,
      nodeName: f.nodeName,
      bindHost: f.bindHost,
      port: f.port,
      fingerprint: cert.fingerprint,
      blob: bootstrap,
    };
    process.stdout.write(`${JSON.stringify(record)}\n`);
    return 0;
  }

  process.stdout.write(
    [
      `wrote ${configPath}`,
      `cert   ${cert.certPath}`,
      `key    ${cert.keyPath}`,
      `bind   ${f.bindHost}:${f.port}`,
      `fp     ${cert.fingerprint}`,
      ``,
      `On the control plane, run:`,
      ``,
      `  llamactl node add ${f.nodeName} --bootstrap ${bootstrap}`,
      ``,
    ].join('\n'),
  );
  return 0;
}

export interface ServeFlags {
  dir: string;
  bindHost?: string;
  port?: number;
  dialCentral?: string;
  centralBearer?: string;
  tunnelNodeName?: string;
  tunnelCentral?: boolean;
  tunnelBearer?: string;
  tunnelJournal?: string;
}

export function parseServeFlags(args: string[]): ServeFlags | { error: string } {
  const flags: ServeFlags = { dir: agentConfigMod.defaultAgentDir() };
  for (const arg of args) {
    const [k, v] = splitFlag(arg);
    if (v === undefined) return { error: `agent serve: flag must be --key=value: ${arg}` };
    switch (k) {
      case '--dir': flags.dir = v; break;
      case '--bind': flags.bindHost = v; break;
      case '--port': {
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n)) return { error: `agent serve: invalid --port: ${v}` };
        flags.port = n;
        break;
      }
      case '--dial-central': flags.dialCentral = v; break;
      case '--central-bearer': flags.centralBearer = v; break;
      case '--tunnel-node-name': flags.tunnelNodeName = v; break;
      case '--tunnel-central': flags.tunnelCentral = v === 'true'; break;
      case '--tunnel-bearer': flags.tunnelBearer = v; break;
      case '--tunnel-journal': flags.tunnelJournal = v; break;
      default: return { error: `agent serve: unknown flag ${k}` };
    }
  }
  return flags;
}

async function runServe(args: string[]): Promise<number> {
  const parsed = parseServeFlags(args);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const cfgPath = join(parsed.dir, 'agent.yaml');
  const cfg = agentConfigMod.loadAgentConfig(cfgPath);

  // --dial-central / --central-bearer must travel together. The
  // bearer can also come from LLAMACTL_TUNNEL_BEARER so the CLI line
  // doesn't need to embed secrets. Either both are present (and we
  // wire tunnelDial below) or neither is.
  const dialUrl = parsed.dialCentral;
  const dialBearer = parsed.centralBearer ?? process.env.LLAMACTL_TUNNEL_BEARER;
  const dialNodeName = parsed.tunnelNodeName ?? cfg.nodeName ?? 'agent';
  if (dialUrl || parsed.centralBearer) {
    if (!dialUrl || !dialBearer) {
      process.stderr.write(
        '--dial-central and --central-bearer must be provided together (or set LLAMACTL_TUNNEL_BEARER for the bearer)\n',
      );
      return 1;
    }
  }

  // --tunnel-central=true mounts /tunnel (WS) + /tunnel-relay on this
  // agent so NAT'd dialing nodes can reach its tRPC router. The bearer
  // is a distinct credential from tokenHash and from LLAMACTL_TUNNEL_BEARER
  // (that env is the dial-side secret). Bearer-without-central is a
  // warning, not a failure — the bearer is harmless when unused.
  const tunnelCentralOn = parsed.tunnelCentral === true;
  const tunnelCentralBearer =
    parsed.tunnelBearer ?? process.env.LLAMACTL_TUNNEL_CENTRAL_BEARER;
  if (tunnelCentralOn) {
    if (!tunnelCentralBearer) {
      process.stderr.write(
        '--tunnel-central=true requires --tunnel-bearer (or set LLAMACTL_TUNNEL_CENTRAL_BEARER)\n',
      );
      return 1;
    }
  } else if (parsed.tunnelBearer) {
    process.stderr.write(
      'warning: --tunnel-bearer set without --tunnel-central=true; ignoring\n',
    );
  }

  const running = startAgentServer({
    bindHost: parsed.bindHost ?? cfg.bindHost,
    port: parsed.port ?? cfg.port,
    tokenHash: cfg.tokenHash,
    tls: { certPath: cfg.certPath, keyPath: cfg.keyPath },
    // Undefined → journal.ts resolves the default path (honors
    // $LLAMACTL_TUNNEL_JOURNAL and $DEV_STORAGE).
    ...(parsed.tunnelJournal ? { tunnelJournalPath: parsed.tunnelJournal } : {}),
    ...(dialUrl && dialBearer
      ? {
          tunnelDial: {
            url: dialUrl,
            bearer: dialBearer,
            nodeName: dialNodeName,
            // Stderr-only diagnostics — never include the bearer or
            // central URL in the transition line.
            onStateChange: (s): void => {
              process.stderr.write(`tunnel: ${s}\n`);
            },
          },
        }
      : {}),
    ...(tunnelCentralOn && tunnelCentralBearer
      ? {
          tunnelCentral: {
            expectedBearerHash: auth.hashToken(tunnelCentralBearer),
            // onNodeConnect/onNodeDisconnect land in Slice D (journal).
          },
        }
      : {}),
  });

  process.stdout.write(
    `agent listening on ${running.url}\n` +
    `  node: ${cfg.nodeName ?? '(unset)'}\n` +
    `  fp:   ${running.fingerprint ?? '(none)'}\n` +
    `press Ctrl-C to stop\n`,
  );

  await new Promise<void>((resolve) => {
    const handle = (): void => resolve();
    process.once('SIGINT', handle);
    process.once('SIGTERM', handle);
  });
  // running.stop() tears down the tunnel client (when present)
  // before the HTTP server stops — see startAgentServer's stop().
  await running.stop();
  return 0;
}

function runStatus(args: string[]): number {
  const parsed = parseStatusFlags(args);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const cfgPath = join(parsed.dir, 'agent.yaml');
  if (!existsSync(cfgPath)) {
    process.stderr.write(`no agent config at ${cfgPath}\n`);
    return 1;
  }
  const cfg = agentConfigMod.loadAgentConfig(cfgPath);
  const out = {
    configPath: cfgPath,
    nodeName: cfg.nodeName,
    bind: `${cfg.bindHost}:${cfg.port}`,
    certPath: cfg.certPath,
    keyPath: cfg.keyPath,
    fingerprint: cfg.fingerprint,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}

function parseStatusFlags(args: string[]): { dir: string } | { error: string } {
  let dir = agentConfigMod.defaultAgentDir();
  for (const arg of args) {
    const [k, v] = splitFlag(arg);
    if (v === undefined) return { error: `agent status: flag must be --key=value: ${arg}` };
    if (k === '--dir') dir = v;
    else return { error: `agent status: unknown flag ${k}` };
  }
  return { dir };
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf('=');
  if (eq < 0) return [arg, undefined];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
