import { rpcServer as rpcServerMod } from '@llamactl/core';
import {
  config as kubecfg,
  createNodeClient as defaultCreateNodeClient,
} from '@llamactl/remote';
import type { Config } from '@llamactl/remote';

/**
 * `llamactl agent rpc-doctor` — preflight check for tensor-parallel
 * workloads. Runs `checkRpcServerAvailable()` locally (default) or
 * dispatches through the `rpcServerDoctor` tRPC procedure on a named
 * remote node with `--node <name>`. Exit 0 on ok, 1 on any failure.
 * Human output to stdout (ok) / stderr (fail); `--json` emits the raw
 * `RpcServerDoctorResult` on stdout for tooling.
 */

export const RPC_DOCTOR_USAGE = `Usage: llamactl agent rpc-doctor [flags]

Verify that rpc-server is available for tensor-parallel workloads.
Without flags, checks \$LLAMA_CPP_BIN/rpc-server on the local node.
With --node <name>, dispatches to that node's rpcServerDoctor
procedure through the current kubeconfig context.

Flags:
  --node=<name>   run the check on a remote node via the dispatcher
  --json          emit the RpcServerDoctorResult as JSON on stdout

Exit code: 0 when rpc-server is ready; 1 otherwise.
`;

/**
 * The shape of a `rpcServerDoctor` tRPC call — narrowed so tests can
 * stub just `.rpcServerDoctor.query` without standing up a full
 * tRPC client. Matches the router's procedure signature exactly.
 */
export interface RpcDoctorRemoteClient {
  rpcServerDoctor: {
    query(
      input?: Record<string, never>,
    ): Promise<rpcServerMod.RpcServerDoctorResult>;
  };
}

/**
 * Dependency-injection surface — mirrors the `install-launchd`
 * handler's pattern. Tests override `checkLocal` and
 * `createNodeClient` to exercise both paths without hitting fs or
 * the network.
 */
export interface RpcDoctorDeps {
  /** Invoked when --node is absent. Default wraps checkRpcServerAvailable. */
  checkLocal: (env?: NodeJS.ProcessEnv) => rpcServerMod.RpcServerDoctorResult;
  /** Invoked when --node is present. Default builds a real NodeClient. */
  createNodeClient: (
    cfg: Config,
    opts: { nodeName: string },
  ) => RpcDoctorRemoteClient;
  loadConfig: (path: string) => Config;
  defaultConfigPath: () => string;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  env: NodeJS.ProcessEnv;
}

export function defaultRpcDoctorDeps(): RpcDoctorDeps {
  return {
    checkLocal: (env) => rpcServerMod.checkRpcServerAvailable(env),
    createNodeClient: (cfg, opts) =>
      defaultCreateNodeClient(cfg, {
        nodeName: opts.nodeName,
      }) as unknown as RpcDoctorRemoteClient,
    loadConfig: kubecfg.loadConfig,
    defaultConfigPath: kubecfg.defaultConfigPath,
    stdout: (chunk: string): void => {
      process.stdout.write(chunk);
    },
    stderr: (chunk: string): void => {
      process.stderr.write(chunk);
    },
    env: process.env,
  };
}

export interface RpcDoctorFlags {
  node?: string;
  json: boolean;
}

export function parseRpcDoctorFlags(
  argv: string[],
): RpcDoctorFlags | { error: string } {
  const flags: RpcDoctorFlags = { json: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      return { error: '__help' };
    }
    if (arg === '--json') {
      flags.json = true;
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq < 0) {
      return { error: `agent rpc-doctor: flag must be --key=value: ${arg}` };
    }
    const k = arg.slice(0, eq);
    const v = arg.slice(eq + 1);
    switch (k) {
      case '--node':
        if (v.length === 0) {
          return { error: 'agent rpc-doctor: --node requires a value' };
        }
        flags.node = v;
        break;
      case '--json':
        // --json=true / --json=false also supported for parity with
        // other subcommands, though bare --json is the common form.
        flags.json = v !== 'false';
        break;
      default:
        return { error: `agent rpc-doctor: unknown flag ${k}` };
    }
  }
  return flags;
}

export async function runRpcDoctor(
  argv: string[],
  depsOverride?: Partial<RpcDoctorDeps>,
): Promise<number> {
  const deps: RpcDoctorDeps = {
    ...defaultRpcDoctorDeps(),
    ...depsOverride,
  };
  const parsed = parseRpcDoctorFlags(argv);
  if ('error' in parsed) {
    if (parsed.error === '__help') {
      deps.stdout(RPC_DOCTOR_USAGE);
      return 0;
    }
    deps.stderr(`${parsed.error}\n`);
    return 1;
  }

  let result: rpcServerMod.RpcServerDoctorResult;
  if (parsed.node) {
    try {
      const cfg = deps.loadConfig(deps.defaultConfigPath());
      const client = deps.createNodeClient(cfg, { nodeName: parsed.node });
      result = await client.rpcServerDoctor.query({});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.stderr(`rpc-doctor: remote call to ${parsed.node} failed: ${msg}\n`);
      return 1;
    }
  } else {
    result = deps.checkLocal(deps.env);
  }

  if (parsed.json) {
    deps.stdout(`${JSON.stringify(result)}\n`);
  } else if (result.ok) {
    deps.stdout(
      `ok\n` +
        `  path: ${result.path ?? '(none)'}\n` +
        `  LLAMA_CPP_BIN: ${result.llamaCppBin ?? '(none)'}\n`,
    );
  } else {
    deps.stderr(
      `rpc-server not available\n` +
        `  reason: ${result.reason ?? '(unknown)'}\n` +
        `  hint: ${result.hint ?? '(no hint)'}\n`,
    );
  }
  return result.ok ? 0 : 1;
}
