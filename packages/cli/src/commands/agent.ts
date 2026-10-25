import { agentConfig as agentConfigMod, auth, startAgentServer, tls } from "@llamactl/remote";
import { hostname } from "node:os";
import { join } from "node:path";

import { access } from "../safe-fs-promises.js";
import {
  chmodSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "../safe-fs.js";
import { collectAgentStatus, formatAgentStatus } from "./agent-status.js";
import { runHeal } from "./heal.js";

const USAGE = `Usage: llamactl agent <subcommand>

Subcommands:
  init [--dir=<path>] [--host=<host>] [--port=<n>] [--name=<node>] [--bind=<host>] [--san=<host,...>] [--no-loopback-san] [--force] [--json]
      Generate a TLS cert + bearer token, write agent.yaml.
      Default output is a human-readable summary + a 'llamactl node add'
      bootstrap line. With --json emits a single-line JSON record
      (configPath, nodeName, bindHost, port, fingerprint, blob) so the
      install-agent.sh flow can capture stdout and shell-extract the
      bootstrap blob without jq.
  rotate-token [--dir=<path>] [--host=<host>] [--json]
      Rotate the bearer token without touching the TLS cert/key. Reads
      agent.yaml, generates a fresh token, updates tokenHash, and emits
      a bootstrap blob containing the new token plus the unchanged cert
      + fingerprint. Use this when the kubeconfig token drifts from
      agent.yaml's tokenHash but the cert pin is still valid — much
      cheaper than a full 'agent init'. Restart the agent after rotating
      so it loads the new tokenHash. The default --host is 127.0.0.1;
      override when the operator's kubeconfig records a different
      advertised endpoint.
  set-token (--hash=<sha256-hex> | --token-file=<path>) [--dir=<path>]
      Adopt an externally issued token (e.g. a central's cluster token)
      as agent.yaml's tokenHash, keeping the TLS cert/key. Writes the
      previous agent.yaml to agent.yaml.bak first. Restart the agent
      after setting it so it loads the new tokenHash.
   rotate-cert [--dir=<path>] [--host=<host>] [--san=<host,...>] [--token-file=<path>] [--json]
       Rotate the TLS cert/key without touching the bearer token. Reads
       agent.yaml, generates a fresh cert with the requested SANs (e.g.
       to add a LAN IP) and updates only the pinned fingerprint. Pass
       --token-file=<path> holding the current plaintext token to also
       emit a bootstrap blob; without it the control plane still pins
       the old cert. Restart the agent afterwards so it loads the new
       cert.
   serve [--dir=<path>] [--bind=<host>] [--host=<host>] [--port=<n>] [--no-auth]
        [--dial-central=<wss-url>] [--central-bearer=<token>] [--tunnel-node-name=<name>]
        [--tunnel-central=true] [--tunnel-bearer=<token>] [--tunnel-journal=<path>]
        [--fleet-journal=<path>]
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
      --fleet-journal overrides the JSONL fleet journal that
      GET /v1/fleet/snapshot serves (default
      DEV_STORAGE/fleet-supervisor/journal.jsonl, falling back to
      ~/.llamactl/fleet-supervisor/journal.jsonl when DEV_STORAGE is
      unset). Point it at the journal the fleet-supervisor writes so
      the agent serves fresh snapshots, not a DEV_STORAGE-dependent
      default.
  status [--dir=<path>] [--host=<host>] [--json]
      Report the agent config, whether /healthz answers, a loopback-only
      bind, and cert expiry + SAN coverage of the advertised host.
  heal [flags]
      Run the self-healing loop (observe + journal + plan/execute).
      See 'llamactl agent heal --help' for full flag set. Also
      available as the top-level alias 'llamactl heal'.
  install-launchd [--scope=user|system] [--binary=<path> | --from-release=<tag> | --from-source]
                  [--install-path=<path>] [--dir=<path>] [--log-dir=<path>]
                  [--env=KEY=VAL]... [--label=<label>] [--repo=<owner/repo>]
                  [--dry-run] [--force]
      macOS only. Resolve an agent binary (existing path, GitHub release,
      or local bun build --compile), render a launchd plist, write it to
      ~/Library/LaunchAgents (user) or /Library/LaunchDaemons (system),
      and load it via launchctl. --dry-run prints the plist + launchctl
      plan without touching disk.
  install-systemd [--scope=user|system] [--binary=<path> | --from-release=<tag> | --from-source]
                  [--install-path=<path>] [--dir=<path>] [--bind=<host>] [--port=<n>]
                  [--log-dir=<path>] [--env=KEY=VAL]... [--env-file=<path>]...
                  [--repo=<owner/repo>] [--dry-run] [--force]
      Linux only. Resolve an agent binary (existing path, GitHub release,
      or local bun build --compile), render a systemd unit, write it to
      ~/.config/systemd/user (user) or /etc/systemd/system (system), and
      enable + restart it via systemctl. --dry-run prints the unit +
      systemctl plan without touching disk.
  token <subcommand>
      Manage named operator bearer tokens (add / list / revoke). Each
      named token authenticates the agent's authed API routes exactly
      as the primary bearer does, and can be revoked on its own; the
      agent re-reads them per request, so add and revoke apply without
      a restart. See 'llamactl agent token --help'.
  rpc-doctor [--node=<name>] [--json]
      Verify $LLAMA_CPP_BIN/rpc-server is available for tensor-parallel
      workloads. Checks the local node by default; pass --node=<name>
      to dispatch through the rpcServerDoctor tRPC procedure on a
      remote node. --json emits the raw result for tooling. Exit 0 on
      ok, 1 otherwise.
  cli <subcommand>
      CLI subscription backends (claude-pro, codex-plus, etc.). See
      'llamactl agent cli --help' for subcommands. Today: \`doctor\`
      probes every declared binding and reports health; exit 2 when
      any binding is unhealthy (CI quality-gate semantics).

All state lives under $LLAMACTL_AGENT_DIR or $DEV_STORAGE or ~/.llamactl.
`;

const DIR_FLAG_HELP = `  --dir=<path>     Agent state dir holding agent.yaml, cert and key
                   (default: $LLAMACTL_AGENT_DIR, else $DEV_STORAGE, else ~/.llamactl)`;

const INIT_USAGE = `Usage: llamactl agent init [flags]

Generate a TLS cert + bearer token and write agent.yaml.

Flags:
${DIR_FLAG_HELP}
  --host=<host>    Hostname/IP this node advertises externally (default: 127.0.0.1)
  --port=<n>       Port the agent listens on (default: 7843)
  --name=<node>    Node name recorded in agent.yaml (default: this machine's hostname)
  --bind=<host>    Address the agent binds to (default: 127.0.0.1; pass 0.0.0.0 to accept remote connections)
  --san=<host,...> Certificate SANs; repeatable, comma lists ok
                   (--host is always included; default: the --host and --bind values).
                   127.0.0.1, ::1 and localhost are also added when
                   --bind is a wildcard or loopback address.
  --no-loopback-san  Do not add the loopback SANs on a wildcard bind
  --force          Re-init over an existing agent.yaml: move agent.yaml,
                   agent.crt and agent.key into
                   <dir>/agent-backup-<timestamp>-XXXXXX/ first
                   (mints a new cert and token)
  --json           Emit a single-line JSON record instead of the human summary
  -h, --help       Show this help
`;

const ROTATE_TOKEN_USAGE = `Usage: llamactl agent rotate-token [flags]

Rotate the bearer token in agent.yaml, keeping the TLS cert/key.
Restart the agent afterwards so it loads the new tokenHash.

Flags:
${DIR_FLAG_HELP}
  --host=<host>    Host recorded in the emitted bootstrap URL (default: 127.0.0.1)
  --json           Emit a single-line JSON record instead of the human summary
  -h, --help       Show this help
`;

const SET_TOKEN_USAGE = `Usage: llamactl agent set-token (--hash=<sha256-hex> | --token-file=<path>) [flags]

Adopt an externally issued token as agent.yaml's tokenHash, keeping the
TLS cert/key. The previous agent.yaml is written to agent.yaml.bak.
Restart the agent afterwards so it loads the new tokenHash.

Flags (exactly one of --hash or --token-file is required):
${DIR_FLAG_HELP}
  --hash=<hex>       SHA-256 hex of the new bearer token
  --token-file=<path>  File holding the new bearer token; hashed locally,
                     never printed
  -h, --help         Show this help
`;

const ROTATE_CERT_USAGE = `Usage: llamactl agent rotate-cert [flags]

Rotate the TLS cert/key in agent.yaml, keeping the bearer token.
Restart the agent afterwards so it loads the new cert.

Flags:
${DIR_FLAG_HELP}
  --host=<host>    Cert CN and host in the emitted bootstrap URL (default: 127.0.0.1)
  --san=<host,...> Certificate SANs; repeatable (default: the --host and bindHost)
  --token-file=<path>
                   File holding the current plaintext token. Verified
                   against tokenHash before any write; when it matches,
                   a bootstrap blob is emitted.
  --json           Emit a single-line JSON record instead of the human summary
  -h, --help       Show this help
`;

const SERVE_USAGE = `Usage: llamactl agent serve [flags]

Run the node agent (blocks until SIGINT/SIGTERM).

Flags:
${DIR_FLAG_HELP}
  --bind=<host>    Address to bind (alias: --host; default: bindHost from agent.yaml)
  --port=<n>       Port to listen on (default: port from agent.yaml)
  --no-auth        Disable bearer auth; only allowed on a loopback bind
  --dial-central=<wss-url>    Dial a central's /tunnel endpoint
  --central-bearer=<token>    Tunnel bearer for --dial-central
                              (or set LLAMACTL_TUNNEL_BEARER)
  --tunnel-node-name=<name>   Identity in the tunnel hello frame
                              (default: nodeName from agent.yaml)
  --tunnel-central=true       Mount /tunnel and /tunnel-relay so NAT'd nodes can dial in
  --tunnel-bearer=<token>     Bearer for --tunnel-central
                              (or set LLAMACTL_TUNNEL_CENTRAL_BEARER)
  --tunnel-journal=<path>     Tunnel audit JSONL (default: ~/.llamactl/tunnel/journal.jsonl,
                              or LLAMACTL_TUNNEL_JOURNAL)
  --fleet-journal=<path>      Fleet journal served at GET /v1/fleet/snapshot
                              (default: DEV_STORAGE/fleet-supervisor/journal.jsonl,
                              else ~/.llamactl/fleet-supervisor/journal.jsonl)
  -h, --help       Show this help
`;

const STATUS_USAGE = `Usage: llamactl agent status [flags]

Report the agent config, whether /healthz answers, a loopback-only
bind, and cert expiry + SAN coverage of the advertised host.

Flags:
${DIR_FLAG_HELP}
  --host=<host>    Host remote clients dial, to check cert SAN coverage
  --json           Emit a single-line JSON record instead of the human summary
  -h, --help       Show this help
`;

function isHelpFlag(arg: string): boolean {
  return arg === "-h" || arg === "--help";
}

// #210: a non-loopback advertised host on a loopback bind is unreachable remotely.
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  const stripped = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (stripped === "localhost" || stripped === "::1" || stripped === "::ffff:127.0.0.1") {
    return true;
  }
  return stripped.startsWith("127.") && /^[\d.]+$/.test(stripped);
}

// #210: null means no warning; the returned line always ends in "\n".
export function initBindWarning(
  host: string,
  bindHost: string,
  bindExplicit: boolean,
): string | null {
  if (bindExplicit || isLoopbackHost(host) || !isLoopbackHost(bindHost)) return null;
  return (
    `warning: advertised host ${host} is not reachable from other machines: ` +
    `the agent binds ${bindHost}. Pass --bind=0.0.0.0 (or --bind=${host}) so ` +
    `'llamactl node add' on a remote control plane can connect.\n`
  );
}

export async function runAgent(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "init":
      return await runInit(rest);
    case "rotate-token":
      return await runRotateToken(rest);
    case "set-token":
      return runSetToken(rest);
    case "rotate-cert":
      return await runRotateCert(rest);
    case "serve":
      return await runServe(rest);
    case "status":
      return await runStatus(rest);
    case "heal":
      return await runHeal(rest);
    case "install-launchd": {
      const { runAgentInstallLaunchd } = await import("./agent-install/index.js");
      return await runAgentInstallLaunchd(rest);
    }
    case "install-systemd": {
      const { runAgentInstallSystemd } = await import("./agent-install/systemd.js");
      return await runAgentInstallSystemd(rest);
    }
    case "update": {
      const { runAgentUpdate } = await import("./agent-update.js");
      return await runAgentUpdate(rest);
    }
    case "rollback": {
      const { runAgentRollback } = await import("./agent-rollback.js");
      return await runAgentRollback(rest);
    }
    case "rpc-doctor": {
      const { runRpcDoctor } = await import("./agent-rpc-doctor.js");
      return await runRpcDoctor(rest);
    }
    case "token": {
      const { runAgentToken } = await import("./agent-token.js");
      return await runAgentToken(rest);
    }
    case "cli": {
      const { runAgentCli } = await import("./cli-doctor.js");
      return await runAgentCli(rest);
    }
    case undefined:
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown agent subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}

export interface InitFlags {
  dir: string;
  host: string; // the hostname/IP this node advertises externally
  port: number;
  nodeName: string;
  bindHost: string; // what Bun.serve binds to
  bindExplicit: boolean; // whether --bind was passed
  sans: string[]; // SANs baked into the cert
  loopbackSan: boolean; // add loopback SANs when the bind covers them
  json: boolean; // emit single-line JSON instead of human summary
  force: boolean; // --force: back up an existing agent.yaml/cert/key and re-init
}

// A wildcard or loopback bind still serves https://127.0.0.1, so certs
// minted for those binds must include loopback SANs or local clients
// that trust the cert fail verification (#217). Distinct from
// isLoopbackHost: a wildcard 0.0.0.0 or :: bind covers loopback but is
// not itself a loopback host.
function bindCoversLoopback(bindHost: string): boolean {
  if (
    bindHost === "0.0.0.0" ||
    bindHost === "::" ||
    bindHost === "::1" ||
    bindHost === "localhost" ||
    bindHost === "::ffff:127.0.0.1"
  ) {
    return true;
  }
  return bindHost.startsWith("127.");
}

const LOOPBACK_SANS = ["127.0.0.1", "::1", "localhost"];

function initCertSans(f: InitFlags, requestedSans: string[]): string[] {
  return f.loopbackSan && bindCoversLoopback(f.bindHost)
    ? dedupe([...requestedSans, ...LOOPBACK_SANS])
    : requestedSans;
}

function assignInitValueFlag(flags: InitFlags, k: string, v: string): string | null {
  switch (k) {
    case "--dir":
      flags.dir = v;
      break;
    case "--host":
      flags.host = v;
      break;
    case "--port": {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0 || n > 65535) {
        return `agent init: invalid --port: ${v}`;
      }
      flags.port = n;
      break;
    }
    case "--name":
      flags.nodeName = v;
      break;
    case "--bind":
      flags.bindHost = v;
      flags.bindExplicit = true;
      break;
    case "--san":
      flags.sans.push(
        ...v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      break;
    default:
      return `agent init: unknown flag ${k}`;
  }
  return null;
}

export function parseInitFlags(args: string[]): InitFlags | { error: string } {
  const flags: InitFlags = {
    dir: agentConfigMod.defaultAgentDir(),
    host: "127.0.0.1",
    port: 7843,
    nodeName: hostname() || "local",
    bindHost: "127.0.0.1",
    bindExplicit: false,
    sans: [],
    loopbackSan: true,
    json: false,
    force: false,
  };
  for (const arg of args) {
    // --json, --force and --no-loopback-san are flag-only switches; the
    // rest are --key=value.
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--force") {
      flags.force = true;
      continue;
    }
    if (arg === "--no-loopback-san") {
      flags.loopbackSan = false;
      continue;
    }
    const [k, v] = splitFlag(arg);
    if (v === undefined) return { error: `agent init: flag must be --key=value: ${arg}` };
    const err = assignInitValueFlag(flags, k, v);
    if (err !== null) return { error: err };
  }
  return flags;
}

export function resolveInitSans(f: Pick<InitFlags, "host" | "bindHost" | "sans">): string[] {
  // --host must always be in the cert: the bootstrap URL is https://<host>:<port>.
  return dedupe(f.sans.length > 0 ? [f.host, ...f.sans] : [f.host, f.bindHost]);
}

// #209: move the files init rewrites into a fresh timestamped subdir of the agent dir.
export function backupAgentState(
  dir: string,
  now: Date = new Date(),
): { backupDir: string; moved: string[] } {
  const stamp = now.toISOString().replaceAll(/[:.]/g, "-");
  const backupDir = mkdtempSync(join(dir, `agent-backup-${stamp}-`));
  const moved: string[] = [];
  for (const name of ["agent.yaml", "agent.crt", "agent.key"]) {
    const src = join(dir, name);
    if (!existsSync(src)) continue;
    renameSync(src, join(backupDir, name));
    moved.push(name);
  }
  return { backupDir, moved };
}

async function runInit(args: string[]): Promise<number> {
  if (args.some(isHelpFlag)) {
    process.stdout.write(INIT_USAGE);
    return 0;
  }
  const parsed = parseInitFlags(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const f = parsed;
  mkdirSync(f.dir, { recursive: true });

  const configPath = join(f.dir, "agent.yaml");
  let backup: { backupDir: string; moved: string[] } | null = null;
  if (existsSync(configPath)) {
    if (!f.force) {
      process.stderr.write(
        `agent config already exists at ${configPath}. Pass --force to move it and the cert/key into a timestamped backup and re-init.\n`,
      );
      return 1;
    }
    try {
      backup = backupAgentState(f.dir);
    } catch (err) {
      process.stderr.write(`agent init --force: backup failed: ${(err as Error).message}\n`);
      return 1;
    }
  }

  const requestedSans = resolveInitSans(f);
  const sans = initCertSans(f, requestedSans);
  const cert = await tls.generateSelfSignedCert({
    dir: f.dir,
    commonName: f.host,
    hostnames: sans,
  });

  const token = auth.generateToken();
  const config: agentConfigMod.AgentConfig = {
    apiVersion: "llamactl/v1",
    kind: "AgentConfig",
    nodeName: f.nodeName,
    bindHost: f.bindHost,
    port: f.port,
    certPath: cert.certPath,
    keyPath: cert.keyPath,
    tokenHash: token.hash,
    fingerprint: cert.fingerprint,
  };
  agentConfigMod.saveAgentConfig(config, configPath);

  const bindWarn = initBindWarning(f.host, f.bindHost, f.bindExplicit);
  if (bindWarn !== null) process.stderr.write(bindWarn);

  if (backup !== null) {
    process.stderr.write(
      `agent init: backed up ${backup.moved.join(", ")} to ${backup.backupDir}. The token and cert fingerprint changed: restart the agent and re-add this node on the control plane with 'llamactl node add ${f.nodeName} --bootstrap <blob> --force'.\n`,
    );
  }

  const url = `https://${f.host}:${String(f.port)}`;
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
        `bind   ${f.bindHost}:${String(f.port)}`,
        `sans   ${sans.join(",")}`,
        `fp     ${cert.fingerprint}`,
      ].join("\n") + "\n",
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
      `bind   ${f.bindHost}:${String(f.port)}`,
      `sans   ${sans.join(",")}`,
      `fp     ${cert.fingerprint}`,
      ``,
      `On the control plane, run:`,
      ``,
      `  llamactl node add ${f.nodeName} --bootstrap ${bootstrap}${backup !== null ? " --force" : ""}`,
      ``,
    ].join("\n"),
  );
  return 0;
}

interface RotateTokenFlags {
  dir: string;
  host: string;
  json: boolean;
}

function parseRotateTokenFlags(args: string[]): RotateTokenFlags | { error: string } {
  const flags: RotateTokenFlags = {
    dir: agentConfigMod.defaultAgentDir(),
    host: "127.0.0.1",
    json: false,
  };
  for (const arg of args) {
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    const [k, v] = splitFlag(arg);
    if (v === undefined) return { error: `agent rotate-token: flag must be --key=value: ${arg}` };
    switch (k) {
      case "--dir":
        flags.dir = v;
        break;
      case "--host":
        flags.host = v;
        break;
      default:
        return { error: `agent rotate-token: unknown flag ${k}` };
    }
  }
  return flags;
}

/**
 * Rotate the bearer token without touching the TLS cert/key. Cheap
 * recovery path when the kubeconfig token has drifted from agent.yaml's
 * tokenHash but the cert pin is still valid.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
export async function runRotateToken(args: string[]): Promise<number> {
  if (args.some(isHelpFlag)) {
    process.stdout.write(ROTATE_TOKEN_USAGE);
    return 0;
  }
  const parsed = parseRotateTokenFlags(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const f = parsed;
  const configPath = join(f.dir, "agent.yaml");
  if (!existsSync(configPath)) {
    process.stderr.write(
      `agent rotate-token: ${configPath} not found. Run 'llamactl agent init' first.\n`,
    );
    return 1;
  }

  const existing = agentConfigMod.loadAgentConfig(configPath);
  let certPem: string;
  try {
    certPem = readFileSync(existing.certPath, "utf8");
  } catch (err) {
    process.stderr.write(
      `agent rotate-token: failed to read cert at ${existing.certPath}: ${(err as Error).message}\n`,
    );
    return 1;
  }

  const token = auth.generateToken();
  const updated: agentConfigMod.AgentConfig = {
    ...existing,
    tokenHash: token.hash,
  };
  agentConfigMod.saveAgentConfig(updated, configPath);

  const url = `https://${f.host}:${String(existing.port)}`;
  const bootstrap = agentConfigMod.encodeBootstrap({
    url,
    fingerprint: existing.fingerprint,
    token: token.token,
    certificate: certPem,
  });

  if (f.json) {
    process.stderr.write(
      [
        `rotated tokenHash in ${configPath}`,
        `cert   ${existing.certPath} (unchanged)`,
        `fp     ${existing.fingerprint} (unchanged)`,
        `bind   ${existing.bindHost}:${String(existing.port)}`,
      ].join("\n") + "\n",
    );
    const record = {
      configPath,
      nodeName: existing.nodeName,
      bindHost: existing.bindHost,
      port: existing.port,
      fingerprint: existing.fingerprint,
      blob: bootstrap,
    };
    process.stdout.write(`${JSON.stringify(record)}\n`);
    return 0;
  }

  process.stdout.write(
    [
      `rotated tokenHash in ${configPath}`,
      `cert   ${existing.certPath} (unchanged)`,
      `fp     ${existing.fingerprint} (unchanged)`,
      `bind   ${existing.bindHost}:${String(existing.port)}`,
      ``,
      `Restart the agent so it loads the new tokenHash, then update the kubeconfig:`,
      ``,
      `  pkill -f 'agent serve' && llamactl agent serve &`,
      `  llamactl node add ${String(existing.nodeName)} --bootstrap ${bootstrap} --force`,
      ``,
    ].join("\n"),
  );
  return 0;
}

interface SetTokenFlags {
  dir: string;
  hash?: string;
  tokenFile?: string;
}

function parseSetTokenFlags(args: string[]): SetTokenFlags | { error: string } {
  const flags: SetTokenFlags = { dir: agentConfigMod.defaultAgentDir() };
  for (const arg of args) {
    const [k, v] = splitFlag(arg);
    if (v === undefined) return { error: `agent set-token: flag must be --key=value: ${arg}` };
    switch (k) {
      case "--dir":
        flags.dir = v;
        break;
      case "--hash":
        flags.hash = v;
        break;
      case "--token-file":
        flags.tokenFile = v;
        break;
      default:
        return { error: `agent set-token: unknown flag ${k}` };
    }
  }
  return flags;
}

/** Turn --hash / --token-file into the tokenHash, never echoing the token. */
function resolveSetTokenHash(f: SetTokenFlags): string | { error: string } {
  if (f.hash !== undefined) {
    const hash = f.hash.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) return { error: "--hash must be 64 hex characters" };
    return hash.toLowerCase();
  }
  const tokenFile = String(f.tokenFile);
  let token: string;
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch (err) {
    return { error: `failed to read ${tokenFile}: ${(err as Error).message}` };
  }
  if (token === "") return { error: `token file is empty: ${tokenFile}` };
  return auth.hashToken(token);
}

/**
 * Put the previous agent.yaml bytes at `bak` via an exclusively created
 * 0600 tmp in the same dir + a rename, so a symlink planted at `bak` is
 * replaced rather than written through, and the secrets it copies are
 * never readable under the umask between creation and chmod.
 */
function writeBackup(bak: string, raw: Buffer): void {
  const tmp = `${bak}.tmp-${String(process.pid)}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, raw, { mode: 0o600, flag: "wx" });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // best-effort
    }
    renameSync(tmp, bak);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // the rename may have consumed it
    }
    throw err;
  }
}

/**
 * Adopt an externally issued token (e.g. a central's cluster token) as
 * agent.yaml's tokenHash instead of hand-editing the file. The token
 * itself is never printed, only its hash lands on disk.
 */
export function runSetToken(args: string[]): number {
  if (args.some(isHelpFlag)) {
    process.stdout.write(SET_TOKEN_USAGE);
    return 0;
  }
  const parsed = parseSetTokenFlags(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const f = parsed;
  if ((f.hash === undefined) === (f.tokenFile === undefined)) {
    process.stderr.write("agent set-token: exactly one of --hash or --token-file is required\n");
    return 1;
  }
  const resolved = resolveSetTokenHash(f);
  if (typeof resolved === "object") {
    process.stderr.write(`agent set-token: ${resolved.error}\n`);
    return 1;
  }
  const tokenHash = resolved;

  const configPath = join(f.dir, "agent.yaml");
  if (!existsSync(configPath)) {
    process.stderr.write(
      `agent set-token: ${configPath} not found. Run 'llamactl agent init' first.\n`,
    );
    return 1;
  }
  const raw = readFileSync(configPath);
  let existing: agentConfigMod.AgentConfig;
  try {
    existing = agentConfigMod.loadAgentConfig(configPath);
  } catch (err) {
    process.stderr.write(`agent set-token: ${(err as Error).message}\n`);
    return 1;
  }

  if (existing.tokenHash === tokenHash) {
    process.stdout.write(`tokenHash in ${configPath} is already this value; nothing changed\n`);
    return 0;
  }

  const bak = `${configPath}.bak`;
  writeBackup(bak, raw);
  agentConfigMod.saveAgentConfig({ ...existing, tokenHash }, configPath);

  process.stdout.write(
    [
      `set tokenHash in ${configPath}`,
      `backup ${bak}`,
      ``,
      `Clients still holding the previous token now get 401.`,
      ``,
      `Restart the agent so it loads the new tokenHash:`,
      ``,
      `  pkill -f 'agent serve' && llamactl agent serve &`,
      ``,
    ].join("\n"),
  );
  return 0;
}

interface RotateCertFlags {
  dir: string;
  host: string;
  sans: string[];
  tokenFile?: string;
  json: boolean;
}

function parseRotateCertFlags(args: string[]): RotateCertFlags | { error: string } {
  const flags: RotateCertFlags = {
    dir: agentConfigMod.defaultAgentDir(),
    host: "127.0.0.1",
    sans: [],
    json: false,
  };
  for (const arg of args) {
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    const [k, v] = splitFlag(arg);
    if (v === undefined) return { error: `agent rotate-cert: flag must be --key=value: ${arg}` };
    switch (k) {
      case "--dir":
        flags.dir = v;
        break;
      case "--host":
        flags.host = v;
        break;
      case "--san":
        flags.sans.push(
          ...v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
        break;
      case "--token-file":
        flags.tokenFile = v;
        break;
      default:
        return { error: `agent rotate-cert: unknown flag ${k}` };
    }
  }
  return flags;
}

/**
 * Read and verify --token-file against agent.yaml's tokenHash. A blob
 * needs the plaintext token (agent.yaml stores only the hash), and the
 * check runs before any write so a wrong token touches nothing.
 * Returns null when no --token-file was given.
 */
function readRotateCertToken(
  tokenFile: string | undefined,
  tokenHash: string,
  configPath: string,
): string | null | 1 {
  if (tokenFile === undefined) return null;
  let token: string;
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch (err) {
    process.stderr.write(
      `agent rotate-cert: failed to read --token-file ${tokenFile}: ${(err as Error).message}\n`,
    );
    return 1;
  }
  if (token === "") {
    process.stderr.write(`agent rotate-cert: token file ${tokenFile} is empty.\n`);
    return 1;
  }
  if (!auth.bearerHashMatches(token, tokenHash)) {
    process.stderr.write(
      `agent rotate-cert: token from ${tokenFile} does not match tokenHash in ${configPath}. Nothing written.\n`,
    );
    return 1;
  }
  return token;
}

/**
 * Rotate the TLS cert/key without touching the bearer token. Cheap
 * counterpart to rotate-token: use it when the cert needs new SANs
 * (e.g. a LAN IP) but the kubeconfig token is still valid.
 */
export async function runRotateCert(args: string[]): Promise<number> {
  if (args.some(isHelpFlag)) {
    process.stdout.write(ROTATE_CERT_USAGE);
    return 0;
  }
  const parsed = parseRotateCertFlags(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const f = parsed;
  const configPath = join(f.dir, "agent.yaml");
  if (!existsSync(configPath)) {
    process.stderr.write(
      `agent rotate-cert: ${configPath} not found. Run 'llamactl agent init' first.\n`,
    );
    return 1;
  }

  const existing = agentConfigMod.loadAgentConfig(configPath);
  const token = readRotateCertToken(f.tokenFile, existing.tokenHash, configPath);
  if (token === 1) return 1;

  const sans = f.sans.length > 0 ? dedupe(f.sans) : dedupe([f.host, existing.bindHost]);

  // generateSelfSignedCert writes agent.key/agent.crt directly into its
  // dir, so stage first and rename into place only after success.
  const staging = mkdtempSync(join(f.dir, ".rotate-cert-"));
  try {
    const cert = await tls.generateSelfSignedCert({
      dir: staging,
      commonName: f.host,
      hostnames: sans,
    });
    renameSync(cert.keyPath, existing.keyPath);
    renameSync(cert.certPath, existing.certPath);
    agentConfigMod.saveAgentConfig({ ...existing, fingerprint: cert.fingerprint }, configPath);

    const blob =
      token === null
        ? null
        : agentConfigMod.encodeBootstrap({
            url: `https://${f.host}:${String(existing.port)}`,
            fingerprint: cert.fingerprint,
            token,
            certificate: cert.certPem,
          });

    if (f.json) {
      process.stderr.write(
        [
          `rotated cert in ${configPath}`,
          `key    ${existing.keyPath}`,
          `was    ${existing.fingerprint}`,
          `now    ${cert.fingerprint}`,
          `sans   ${sans.join(",")}`,
          `tokenHash unchanged`,
        ].join("\n") + "\n",
      );
      const record = {
        configPath,
        nodeName: existing.nodeName,
        bindHost: existing.bindHost,
        port: existing.port,
        fingerprint: cert.fingerprint,
        previousFingerprint: existing.fingerprint,
        sans,
        blob,
      };
      process.stdout.write(`${JSON.stringify(record)}\n`);
      return 0;
    }

    const lines = [
      `rotated cert in ${configPath}`,
      `cert   ${existing.certPath}`,
      `was    ${existing.fingerprint}`,
      `now    ${cert.fingerprint}`,
      `sans   ${sans.join(",")}`,
      `tokenHash unchanged`,
      ``,
      `Restart the agent so it loads the new cert (the cert is read only at startup).`,
      ``,
    ];
    if (blob !== null) {
      lines.push(
        `On the control plane, re-pin the new cert with:`,
        ``,
        `  llamactl node add ${String(existing.nodeName)} --bootstrap ${blob} --force`,
        ``,
      );
    } else {
      lines.push(
        `The control plane still pins the old cert. To emit a bootstrap blob,`,
        `re-run with --token-file=<file holding the current token>, or run`,
        `'llamactl agent rotate-token' to get a fresh blob.`,
        ``,
      );
    }
    process.stdout.write(lines.join("\n"));
    return 0;
  } catch (err) {
    process.stderr.write(`agent rotate-cert: ${(err as Error).message}\n`);
    return 1;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export interface ServeFlags {
  dir: string;
  bindHost?: string;
  port?: number;
  noAuth?: boolean;
  dialCentral?: string;
  centralBearer?: string;
  tunnelNodeName?: string;
  tunnelCentral?: boolean;
  tunnelBearer?: string;
  tunnelJournal?: string;
  fleetJournal?: string;
}

export function parseServeFlags(args: string[]): ServeFlags | { error: string } {
  const flags: ServeFlags = { dir: agentConfigMod.defaultAgentDir() };
  for (const arg of args) {
    if (arg === "--no-auth") {
      flags.noAuth = true;
      continue;
    }
    const [k, v] = splitFlag(arg);
    if (v === undefined) return { error: `agent serve: flag must be --key=value: ${arg}` };
    switch (k) {
      case "--dir":
        flags.dir = v;
        break;
      case "--bind":
        flags.bindHost = v;
        break;
      case "--host":
        flags.bindHost = v;
        break;
      case "--port": {
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n)) return { error: `agent serve: invalid --port: ${v}` };
        flags.port = n;
        break;
      }
      case "--dial-central":
        flags.dialCentral = v;
        break;
      case "--central-bearer":
        flags.centralBearer = v;
        break;
      case "--tunnel-node-name":
        flags.tunnelNodeName = v;
        break;
      case "--tunnel-central":
        flags.tunnelCentral = v === "true";
        break;
      case "--tunnel-bearer":
        flags.tunnelBearer = v;
        break;
      case "--tunnel-journal":
        flags.tunnelJournal = v;
        break;
      case "--fleet-journal":
        flags.fleetJournal = v;
        break;
      default:
        return { error: `agent serve: unknown flag ${k}` };
    }
  }
  return flags;
}

interface ServeWiring {
  dialUrl: string | undefined;
  dialBearer: string | undefined;
  tunnelCentralOn: boolean;
  tunnelCentralBearer: string | undefined;
}

// --dial-central / --central-bearer must travel together. The
// bearer can also come from LLAMACTL_TUNNEL_BEARER so the CLI line
// doesn't need to embed secrets. Either both are present (and we
// wire tunnelDial below) or neither is.
function checkDialFlags(
  parsed: ServeFlags,
  dialUrl: string | undefined,
  dialBearer: string | undefined,
): string | null {
  if (dialUrl || parsed.centralBearer) {
    if (!dialUrl || !dialBearer) {
      return "--dial-central and --central-bearer must be provided together (or set LLAMACTL_TUNNEL_BEARER for the bearer)\n";
    }
  }
  return null;
}

function checkNoAuthBind(parsed: ServeFlags): string | null {
  if (!parsed.noAuth) return null;
  const bindHost = parsed.bindHost ?? "127.0.0.1";
  if (bindHost !== "127.0.0.1" && bindHost !== "localhost") {
    return `agent serve: --no-auth is restricted to 127.0.0.1 or localhost binds; got ${bindHost}\n`;
  }
  return null;
}

// --tunnel-central=true mounts /tunnel (WS) + /tunnel-relay on this
// agent so NAT'd dialing nodes can reach its tRPC router. The bearer
// is a distinct credential from tokenHash and from LLAMACTL_TUNNEL_BEARER
// (that env is the dial-side secret). Bearer-without-central is a
// warning, not a failure — the bearer is harmless when unused.
function checkTunnelCentral(
  parsed: ServeFlags,
  tunnelCentralOn: boolean,
  tunnelCentralBearer: string | undefined,
): string | null {
  if (tunnelCentralOn) {
    if (!tunnelCentralBearer) {
      return "--tunnel-central=true requires --tunnel-bearer (or set LLAMACTL_TUNNEL_CENTRAL_BEARER)\n";
    }
    return null;
  }
  if (parsed.tunnelBearer) {
    process.stderr.write("warning: --tunnel-bearer set without --tunnel-central=true; ignoring\n");
  }
  return null;
}

function validateServeWiring(parsed: ServeFlags): ServeWiring | { error: string } {
  const dialUrl = parsed.dialCentral;
  const dialBearer = parsed.centralBearer ?? process.env["LLAMACTL_TUNNEL_BEARER"];
  const dialErr = checkDialFlags(parsed, dialUrl, dialBearer);
  if (dialErr) return { error: dialErr };

  const noAuthErr = checkNoAuthBind(parsed);
  if (noAuthErr) return { error: noAuthErr };

  const tunnelCentralOn = parsed.tunnelCentral === true;
  const tunnelCentralBearer = parsed.tunnelBearer ?? process.env["LLAMACTL_TUNNEL_CENTRAL_BEARER"];
  const tunnelErr = checkTunnelCentral(parsed, tunnelCentralOn, tunnelCentralBearer);
  if (tunnelErr) return { error: tunnelErr };

  return { dialUrl, dialBearer, tunnelCentralOn, tunnelCentralBearer };
}

export function buildServeOptions(
  parsed: ServeFlags,
  cfg: ReturnType<typeof agentConfigMod.loadAgentConfig>,
  wiring: ServeWiring,
  dialNodeName: string,
): Parameters<typeof startAgentServer>[0] {
  const { dialUrl, dialBearer, tunnelCentralOn, tunnelCentralBearer } = wiring;
  const serverOptions = {
    bindHost: parsed.bindHost ?? cfg.bindHost,
    port: parsed.port ?? cfg.port,
    tokenHash: cfg.tokenHash,
    // Named operator bearer tokens (#218), re-read on every request, so
    // 'agent token add' / 'revoke' apply without a restart.
    bearerTokens: agentConfigMod.bearerTokensReader(join(parsed.dir, "agent.yaml")),
    tls: { certPath: cfg.certPath, keyPath: cfg.keyPath },
    // Publish cluster peers' fleet snapshots so peer models route through this
    // proxy with prefix-cache. No-op when listPeers() is empty (single-node).
    peerSnapshotPoll: true,
    // Undefined → journal.ts resolves the default path (honors
    // $LLAMACTL_TUNNEL_JOURNAL and $DEV_STORAGE).
    ...(parsed.tunnelJournal ? { tunnelJournalPath: parsed.tunnelJournal } : {}),
    // Undefined → the fleet-snapshot route resolves
    // defaultFleetJournalPath() (honors $DEV_STORAGE). Set this so the
    // agent serves the SAME journal the supervisor writes.
    ...(parsed.fleetJournal ? { fleetJournalPath: parsed.fleetJournal } : {}),
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
            // P4.1: agent.yaml's relay-only credentials, re-read per relay request.
            workerRpcRelay: agentConfigMod.workerRpcRelayReader(join(parsed.dir, "agent.yaml")),
            // onNodeConnect/onNodeDisconnect land in Slice D (journal).
          },
        }
      : {}),
    // InferenceRpcV1 (P4.1): agent.yaml's workerRpc block, re-read on every
    // RPC call. Absent or listing no version, nothing is advertised.
    ...(cfg.nodeName !== undefined
      ? {
          workerRpc: {
            workerId: cfg.nodeName,
            settings: agentConfigMod.workerRpcSettingsReader(join(parsed.dir, "agent.yaml")),
          },
        }
      : {}),
  } as Parameters<typeof startAgentServer>[0];
  if (parsed.noAuth !== undefined) {
    (serverOptions as Parameters<typeof startAgentServer>[0] & { noAuth?: boolean }).noAuth =
      parsed.noAuth;
  }
  return serverOptions;
}

/** Report a recognized startup failure to stderr; false → rethrow. */
function reportServeStartFailure(
  err: unknown,
  parsed: ServeFlags,
  cfg: ReturnType<typeof agentConfigMod.loadAgentConfig>,
): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (
    (message.includes("EADDRINUSE") || (message.includes("port") && message.includes("in use"))) &&
    typeof parsed.port === "number"
  ) {
    process.stderr.write(
      `agent: port ${String(parsed.port)} already in use, exiting (launchd will retry)\n`,
    );
    return true;
  }
  if (
    (message.includes("EPERM") || message.includes("ENOENT")) &&
    (message.includes(cfg.certPath) || message.includes(cfg.keyPath))
  ) {
    const path = message.includes(cfg.certPath) ? cfg.certPath : cfg.keyPath;
    process.stderr.write(`agent: cannot read cert path ${path}, exiting (launchd will retry)\n`);
    return true;
  }
  return false;
}

async function runServe(args: string[]): Promise<number> {
  if (args.some(isHelpFlag)) {
    process.stdout.write(SERVE_USAGE);
    return 0;
  }
  const parsed = parseServeFlags(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const wiring = validateServeWiring(parsed);
  if ("error" in wiring) {
    process.stderr.write(wiring.error);
    return 1;
  }

  const cfgPath = join(parsed.dir, "agent.yaml");
  await waitForReadable(cfgPath, 30_000);
  const cfg = agentConfigMod.loadAgentConfig(cfgPath);
  await waitForReadable(cfg.certPath, 30_000);
  await waitForReadable(cfg.keyPath, 30_000);
  const dialNodeName = parsed.tunnelNodeName ?? cfg.nodeName ?? "agent";

  let running;
  try {
    running = startAgentServer(buildServeOptions(parsed, cfg, wiring, dialNodeName));
  } catch (err) {
    if (reportServeStartFailure(err, parsed, cfg)) return 1;
    throw err;
  }

  process.stdout.write(
    `agent listening on ${running.url}\n` +
      `  node: ${cfg.nodeName ?? "(unset)"}\n` +
      `  fp:   ${running.fingerprint ?? "(none)"}\n` +
      `press Ctrl-C to stop\n`,
  );

  await new Promise<void>((resolve) => {
    const handle = (): void => {
      resolve();
    };
    process.once("SIGINT", handle);
    process.once("SIGTERM", handle);
  });
  // running.stop() keeps the tunnel client (when present) up while the
  // HTTP server stops gracefully, and stops it before the forced stop —
  // see startAgentServer's stop().
  await running.stop();
  return 0;
}

async function runStatus(args: string[]): Promise<number> {
  if (args.some(isHelpFlag)) {
    process.stdout.write(STATUS_USAGE);
    return 0;
  }
  const parsed = parseStatusFlags(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const cfgPath = join(parsed.dir, "agent.yaml");
  if (!existsSync(cfgPath)) {
    process.stderr.write(`no agent config at ${cfgPath}\n`);
    return 1;
  }
  const cfg = agentConfigMod.loadAgentConfig(cfgPath);
  const report = await collectAgentStatus({
    configPath: cfgPath,
    cfg,
    ...(parsed.host !== undefined ? { advertisedHost: parsed.host } : {}),
  });
  if (parsed.json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else process.stdout.write(formatAgentStatus(report));
  return 0;
}

interface StatusFlags {
  dir: string;
  host?: string; // the host remote clients dial, for SAN coverage
  json: boolean;
}

function parseStatusFlags(args: string[]): StatusFlags | { error: string } {
  const flags: StatusFlags = { dir: agentConfigMod.defaultAgentDir(), json: false };
  for (const arg of args) {
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    const [k, v] = splitFlag(arg);
    if (v === undefined) return { error: `agent status: flag must be --key=value: ${arg}` };
    switch (k) {
      case "--dir":
        flags.dir = v;
        break;
      case "--host":
        flags.host = v;
        break;
      default:
        return { error: `agent status: unknown flag ${k}` };
    }
  }
  return flags;
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  if (eq < 0) return [arg, undefined];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

async function waitForReadable(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await access(path, fsConstants.R_OK);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- Preserve existing CLI/test semantics while clearing strict lint debt.
  throw lastErr ?? new Error(`timed out waiting for ${path}`);
}

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
