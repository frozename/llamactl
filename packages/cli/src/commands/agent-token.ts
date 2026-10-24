/**
 * #218 — named operator bearer tokens. Each named token authenticates
 * the agent's authed API routes exactly as the primary bearer does and
 * can be revoked on its own; agent.yaml stores only the SHA-256 of each
 * token, and the running agent re-reads the block per request, so add
 * and revoke apply without a restart. The token itself is shown once,
 * by `add`, and never stored or logged anywhere else.
 */
import { agentConfig as agentConfigMod, auth } from "@llamactl/remote";
import { join } from "node:path";

import { chmodSync, existsSync, writeFileSync } from "../safe-fs.js";

export const TOKEN_USAGE = `Usage: llamactl agent token <subcommand> [flags]

Subcommands:
  add <name> [--out=<file>] [--json] [--dir=<path>]
      Mint a new named bearer token and record its hash in agent.yaml.
      The name matches [a-z0-9][a-z0-9._-]{0,62}. The token is printed
      once, on stdout, and is never shown again; with --out it is
      written to that file (mode 0600) instead of printed.
  list [--json] [--dir=<path>]
      List the recorded tokens as name<TAB>createdAt. Hashes and tokens
      are never listed.
  revoke <name> [--dir=<path>]
      Drop the named token. The next request with it is refused.

With --json, one JSON record (or array) goes to stdout and every note
goes to stderr. Tokens authenticate the agent's API routes immediately;
no restart is needed.
`;

function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h" || arg === "help";
}

function splitFlag(arg: string): [string, string | undefined] {
  const i = arg.indexOf("=");
  return i === -1 ? [arg, undefined] : [arg.slice(0, i), arg.slice(i + 1)];
}

interface TokenFlags {
  dir: string;
  out?: string;
  json: boolean;
}

function parseTokenFlags(args: string[]): TokenFlags | { error: string } {
  const flags: TokenFlags = { dir: agentConfigMod.defaultAgentDir(), json: false };
  for (const arg of args) {
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    const [k, v] = splitFlag(arg);
    if (v === undefined) return { error: `flag must be --key=value: ${arg}` };
    switch (k) {
      case "--dir":
        flags.dir = v;
        break;
      case "--out":
        flags.out = v;
        break;
      default:
        return { error: `unknown flag ${k}` };
    }
  }
  return flags;
}

function fail(msg: string): 1 {
  process.stderr.write(`agent token: ${msg}\n`);
  return 1;
}

/** The recorded block, or null when absent. Fails on a malformed block. */
function readEntries(
  configPath: string,
  config: agentConfigMod.AgentConfig,
): agentConfigMod.AgentBearerTokens | null | 1 {
  if (config.bearerTokens === undefined) return null;
  const parsed = agentConfigMod.AgentBearerTokensSchema.safeParse(config.bearerTokens);
  if (!parsed.success) {
    return fail(`${configPath} has an invalid bearerTokens block; fix it first`);
  }
  return parsed.data;
}

interface TokenState {
  configPath: string;
  config: agentConfigMod.AgentConfig;
  entries: agentConfigMod.AgentBearerTokens | null;
}

function loadTokenState(flags: TokenFlags): TokenState | 1 {
  const configPath = join(flags.dir, "agent.yaml");
  if (!existsSync(configPath)) {
    return fail(`${configPath} not found. Run 'llamactl agent init' first.`);
  }
  const config = agentConfigMod.loadAgentConfig(configPath);
  const entries = readEntries(configPath, config);
  if (entries === 1) return 1;
  return { configPath, config, entries };
}

function tokenAdd(name: string | undefined, args: string[]): number {
  const flags = parseTokenFlags(args);
  if ("error" in flags) return fail(flags.error);
  if (name === undefined || name.length === 0) return fail("add requires a token name");
  if (!agentConfigMod.BEARER_TOKEN_NAME.test(name)) {
    return fail(
      `invalid token name ${name}: use 1-63 characters from a-z, 0-9, '.', '_', '-', starting with a-z or 0-9`,
    );
  }
  const state = loadTokenState(flags);
  if (state === 1) return 1;
  if (state.entries?.some((e) => e.name === name)) {
    return fail(`a token named ${name} already exists; revoke it first`);
  }

  const minted = auth.generateToken();
  const entry: agentConfigMod.AgentBearerToken = {
    name,
    tokenHash: minted.hash,
    createdAt: new Date().toISOString(),
  };
  agentConfigMod.saveAgentConfig(
    { ...state.config, bearerTokens: [...(state.entries ?? []), entry] },
    state.configPath,
  );

  if (flags.out !== undefined) {
    try {
      writeFileSync(flags.out, `${minted.token}\n`, { mode: 0o600 });
      chmodSync(flags.out, 0o600);
    } catch (err) {
      return fail(`recorded ${name} but failed to write ${flags.out}: ${(err as Error).message}`);
    }
  }

  reportAdd(flags, state.configPath, name, minted.token, entry.createdAt);
  return 0;
}

function reportAdd(
  flags: TokenFlags,
  configPath: string,
  name: string,
  token: string,
  createdAt: string,
): void {
  if (flags.json) {
    const record =
      flags.out === undefined ? { name, token, createdAt } : { name, out: flags.out, createdAt };
    process.stdout.write(`${JSON.stringify(record)}\n`);
    return;
  }
  process.stderr.write(
    `recorded ${name} in ${configPath}\nthe running agent accepts it on the next request\n`,
  );
  if (flags.out === undefined) process.stdout.write(`${token}\n`);
}

function tokenList(args: string[]): number {
  const flags = parseTokenFlags(args);
  if ("error" in flags) return fail(flags.error);
  const state = loadTokenState(flags);
  if (state === 1) return 1;

  if (flags.json) {
    const listed = (state.entries ?? []).map((e) => ({ name: e.name, createdAt: e.createdAt }));
    process.stdout.write(`${JSON.stringify(listed)}\n`);
    return 0;
  }
  if (state.entries === null || state.entries.length === 0) {
    process.stderr.write(`no named bearer tokens in ${state.configPath}\n`);
    return 0;
  }
  for (const e of state.entries) process.stdout.write(`${e.name}\t${e.createdAt}\n`);
  return 0;
}

function tokenRevoke(name: string | undefined, args: string[]): number {
  const flags = parseTokenFlags(args);
  if ("error" in flags) return fail(flags.error);
  if (name === undefined || name.length === 0) return fail("revoke requires a token name");
  const state = loadTokenState(flags);
  if (state === 1) return 1;
  if (!state.entries?.some((e) => e.name === name)) {
    return fail(`no token named ${name} in ${state.configPath}`);
  }

  const remaining = state.entries.filter((e) => e.name !== name);
  const updated: agentConfigMod.AgentConfig = { ...state.config };
  if (remaining.length > 0) updated.bearerTokens = remaining;
  else Reflect.deleteProperty(updated, "bearerTokens");
  agentConfigMod.saveAgentConfig(updated, state.configPath);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ revoked: name, remaining: remaining.length })}\n`);
  } else {
    process.stderr.write(
      `revoked ${name} from ${state.configPath}\nthe running agent refuses it on the next request\n`,
    );
  }
  return 0;
}

export async function runAgentToken(args: string[]): Promise<number> {
  if (args.length === 0 || args.some(isHelpFlag)) {
    process.stdout.write(TOKEN_USAGE);
    return 0;
  }
  const [sub = "", ...rest] = args;
  const positional = rest.filter((a) => !a.startsWith("-"));
  const flagArgs = rest.filter((a) => a.startsWith("-"));
  if (positional.length > (sub === "list" ? 0 : 1)) {
    return fail(`unexpected argument ${String(positional[1])}; see 'llamactl agent token --help'`);
  }
  switch (sub) {
    case "add":
      return await Promise.resolve(tokenAdd(positional[0], flagArgs));
    case "list":
      return await Promise.resolve(tokenList(flagArgs));
    case "revoke":
      return await Promise.resolve(tokenRevoke(positional[0], flagArgs));
    default:
      return fail(`unknown subcommand ${sub}. See 'llamactl agent token --help'.`);
  }
}
