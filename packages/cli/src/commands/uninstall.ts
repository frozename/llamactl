import { uninstall } from "@llamactl/core";

import { getGlobals, getNodeClient, isLocalDispatch } from "../dispatcher.js";

const USAGE = `Usage: llamactl uninstall <rel> [--force]

Removes a pulled model file plus its mmproj sibling when no other
GGUF remains in the repo directory, prunes matching rows from the
bench profile / history / vision files, and clears the custom-catalog
entry. Non-candidate scopes and promotion overrides require --force.
`;

function acceptUninstallPositional(rel: string, arg: string): { rel: string } | { exit: number } {
  if (arg.startsWith("-")) {
    process.stderr.write(`Unknown flag: ${arg}\n`);
    return { exit: 1 };
  }
  if (rel) {
    process.stderr.write(`Unexpected extra argument: ${arg}\n`);
    return { exit: 1 };
  }
  return { rel: arg };
}

function parseUninstallArgs(args: string[]): { rel: string; force: boolean } | { exit: number } {
  let rel = "";
  let force = false;
  for (const arg of args) {
    switch (arg) {
      case "-f":
      case "--force":
        force = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        return { exit: 0 };
      default: {
        const accepted = acceptUninstallPositional(rel, arg);
        if ("exit" in accepted) return accepted;
        rel = accepted.rel;
        break;
      }
    }
  }

  if (!rel) {
    process.stdout.write(USAGE);
    return { exit: 1 };
  }
  return { rel, force };
}

async function fetchUninstallReport(
  rel: string,
  force: boolean,
): Promise<ReturnType<typeof uninstall.uninstall> | null> {
  if (isLocalDispatch()) {
    return uninstall.uninstall({ rel, force });
  }
  try {
    return await getNodeClient().uninstall.mutate({ rel, force });
  } catch (err) {
    process.stderr.write(
      `uninstall: remote call to '${getGlobals().nodeName ?? ""}' failed: ${(err as Error).message}\n`,
    );
    return null;
  }
}

export async function runUninstall(args: string[]): Promise<number> {
  const parsed = parseUninstallArgs(args);
  if ("exit" in parsed) return parsed.exit;

  const report = await fetchUninstallReport(parsed.rel, parsed.force);
  if (!report) return 1;
  if (report.error) {
    process.stderr.write(`${report.error}\n`);
    return report.code;
  }
  for (const line of report.actions) {
    process.stdout.write(`${line}\n`);
  }
  return report.code;
}
