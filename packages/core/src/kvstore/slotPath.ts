import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const SLOT_SAVE_PATH_AUTO = 'auto';

export function canonicalSlotDir(runtimeDir: string, workload: string): string {
  if (workload.includes('/') || workload.includes('..')) {
    throw new Error(`invalid workload name '${workload}'`);
  }
  return join(runtimeDir, 'kvstore', 'slots', workload);
}

export function resolveSlotSavePathArgs(
  extraArgs: readonly string[],
  runtimeDir: string,
  workload: string,
): { args: string[]; slotSavePath: string | null } {
  const args = [...extraArgs];
  const slotDir = canonicalSlotDir(runtimeDir, workload);
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === '--slot-save-path') {
      const value = args[i + 1];
      if (value === undefined) return { args, slotSavePath: null };
      if (value === SLOT_SAVE_PATH_AUTO) {
        args[i + 1] = slotDir;
        return { args, slotSavePath: slotDir };
      }
      return { args, slotSavePath: value.startsWith('/') ? value : null };
    }
    if (!token.startsWith('--slot-save-path=')) continue;
    const value = token.slice('--slot-save-path='.length);
    if (value === SLOT_SAVE_PATH_AUTO) {
      args[i] = `--slot-save-path=${slotDir}`;
      return { args, slotSavePath: slotDir };
    }
    return { args, slotSavePath: value.startsWith('/') ? value : null };
  }
  return { args, slotSavePath: null };
}

export function parseAbsoluteSlotSavePath(extraArgs: readonly string[]): string | null {
  for (let i = 0; i < extraArgs.length; i += 1) {
    const token = extraArgs[i]!;
    if (token === '--slot-save-path') {
      const value = extraArgs[i + 1];
      return typeof value === 'string' && value.startsWith('/') ? value : null;
    }
    if (token.startsWith('--slot-save-path=')) {
      const value = token.slice('--slot-save-path='.length);
      return value.startsWith('/') ? value : null;
    }
  }
  return null;
}

export function parseSlotSavePathFromCommand(cmdline: string): string | null {
  const match = cmdline.match(/(?:^|\s)--slot-save-path(?:=|\s+)(\S+)/);
  if (!match) return null;
  const value = match[1]!;
  return value.startsWith('/') ? value : null;
}

export function defaultReadProcessCommand(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return out.trim() || null;
  } catch {
    return null;
  }
}
