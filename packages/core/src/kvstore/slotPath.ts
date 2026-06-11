import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const SLOT_SAVE_PATH_AUTO = "auto";

export function canonicalSlotDir(runtimeDir: string, workload: string): string {
  if (workload.includes("/") || workload.includes("..")) {
    throw new Error(`invalid workload name '${workload}'`);
  }
  return join(runtimeDir, "kvstore", "slots", workload);
}

interface SlotSavePathResolution {
  args: string[];
  slotSavePath: string | null;
}

function absoluteOrNull(value: string): string | null {
  return value.startsWith("/") ? value : null;
}

/** Handle the two-token form: `--slot-save-path <value>`. */
function resolveSeparateSlotPathArg(
  args: string[],
  i: number,
  slotDir: string,
): SlotSavePathResolution {
  const value = args[i + 1];
  if (value === undefined) return { args, slotSavePath: null };
  if (value === SLOT_SAVE_PATH_AUTO) {
    args[i + 1] = slotDir;
    return { args, slotSavePath: slotDir };
  }
  return { args, slotSavePath: absoluteOrNull(value) };
}

/** Handle the inline form: `--slot-save-path=<value>`. */
function resolveInlineSlotPathArg(
  args: string[],
  i: number,
  token: string,
  slotDir: string,
): SlotSavePathResolution {
  const value = token.slice("--slot-save-path=".length);
  if (value === SLOT_SAVE_PATH_AUTO) {
    args[i] = `--slot-save-path=${slotDir}`;
    return { args, slotSavePath: slotDir };
  }
  return { args, slotSavePath: absoluteOrNull(value) };
}

export function resolveSlotSavePathArgs(
  extraArgs: readonly string[],
  runtimeDir: string,
  workload: string,
): SlotSavePathResolution {
  const args = [...extraArgs];
  const slotDir = canonicalSlotDir(runtimeDir, workload);
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) continue;
    if (token === "--slot-save-path") {
      return resolveSeparateSlotPathArg(args, i, slotDir);
    }
    if (token.startsWith("--slot-save-path=")) {
      return resolveInlineSlotPathArg(args, i, token, slotDir);
    }
  }
  return { args, slotSavePath: null };
}

export function parseAbsoluteSlotSavePath(extraArgs: readonly string[]): string | null {
  for (let i = 0; i < extraArgs.length; i += 1) {
    const token = extraArgs[i];
    if (token === undefined) continue;
    if (token === "--slot-save-path") {
      const value = extraArgs[i + 1];
      if (typeof value !== "string") return null;
      return absoluteOrNull(value);
    }
    if (token.startsWith("--slot-save-path=")) {
      return absoluteOrNull(token.slice("--slot-save-path=".length));
    }
  }
  return null;
}

export function parseSlotSavePathFromCommand(cmdline: string): string | null {
  const match = /(?:^|\s)--slot-save-path(?:=|\s+)(\S+)/.exec(cmdline);
  if (!match) return null;
  const value = match[1];
  if (value === undefined) return null;
  return value.startsWith("/") ? value : null;
}

export function defaultReadProcessCommand(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}
