import type { Config } from "@llamactl/core/config/schema";

import { defaultConfigPath, loadConfig, mutateConfig } from "@llamactl/core/config/kubeconfig";

import { getGlobals } from "../dispatcher.js";
import { existsSync, readFileSync } from "../safe-fs.js";

const USAGE = `Usage: llamactl ctx <subcommand>

Subcommands:
  current             Print the current-context name.
  use <name>          Set the current-context.
  get                 Print the full kubeconfig YAML.
  nodes               List nodes in the current context (alias for 'node ls').
`;

function mutateConfigLocked(path: string, fn: (cfg: Config) => Config): Config {
  return mutateConfig(path, fn);
}

export async function runCtx(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "current":
      return runCurrent(rest);
    case "use":
      return runUse(rest);
    case "get":
      return runGet(rest);
    case "nodes":
      return await (await import("./node.js")).runNode(["ls", ...rest]);
    case undefined:
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown ctx subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}

function runCurrent(args: string[]): number {
  if (args.length > 0) {
    process.stderr.write(`ctx current: unexpected argument ${String(args[0])}\n`);
    return 1;
  }
  const cfgPath = getGlobals().configPath ?? defaultConfigPath();
  const cfg = loadConfig(cfgPath);
  process.stdout.write(`${cfg.currentContext}\n`);
  return 0;
}

function runUse(args: string[]): number {
  const [name, ...rest] = args;
  if (!name || name.startsWith("-")) {
    process.stderr.write("ctx use: missing <name>\n");
    return 1;
  }
  if (rest.length > 0) {
    process.stderr.write(`ctx use: unexpected argument ${String(rest[0])}\n`);
    return 1;
  }
  const cfgPath = getGlobals().configPath ?? defaultConfigPath();
  try {
    mutateConfigLocked(cfgPath, (cfg: Config) => {
      const found = cfg.contexts.find((c) => c.name === name);
      if (!found) {
        throw new Error(`ctx use: no context named '${name}'`);
      }
      return { ...cfg, currentContext: name };
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  process.stdout.write(`switched to context '${name}'\n`);
  return 0;
}

function runGet(args: string[]): number {
  if (args.length > 0) {
    process.stderr.write(`ctx get: unexpected argument ${String(args[0])}\n`);
    return 1;
  }
  const cfgPath = getGlobals().configPath ?? defaultConfigPath();
  if (!existsSync(cfgPath)) {
    // Load will produce a fresh default; surface that but don't write
    // — `get` is a read-only view.
    const fresh = loadConfig(cfgPath);
    process.stdout.write(`# no config at ${cfgPath}; showing defaults\n`);
    process.stdout.write(`${JSON.stringify(fresh, null, 2)}\n`);
    return 0;
  }
  const raw = readFileSync(cfgPath, "utf8");
  process.stdout.write(raw.endsWith("\n") ? raw : `${raw}\n`);
  return 0;
}
