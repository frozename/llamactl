import type { NodeMemSnapshot } from "./types.js";

const PAGE_FIELDS: Record<
  string,
  "free_mb" | "active_mb" | "inactive_mb" | "wired_mb" | "compressor_mb"
> = {
  "Pages free": "free_mb",
  "Pages active": "active_mb",
  "Pages inactive": "inactive_mb",
  "Pages wired down": "wired_mb",
  "Pages occupied by compressor": "compressor_mb",
};

export function parseVmStatOutput(raw: string): NodeMemSnapshot {
  const pageSizeMatch = /page size of (\d+) bytes/.exec(raw);
  const pageSizeText = pageSizeMatch?.[1];
  const pageSize = pageSizeText ? parseInt(pageSizeText, 10) : 4096;
  const toMb = (pages: number): number => (pages * pageSize) / 1024 / 1024;

  const snap: NodeMemSnapshot = {
    free_mb: 0,
    active_mb: 0,
    inactive_mb: 0,
    wired_mb: 0,
    compressor_mb: 0,
    swap_in: 0,
    swap_out: 0,
  };

  let matchedFields = 0;
  for (const line of raw.split("\n")) {
    const pageMatch = /^(.+?):\s+([\d.]+)\./.exec(line);
    if (!pageMatch) continue;
    const [, rawLabel, rawCount] = pageMatch;
    if (rawLabel === undefined || rawCount === undefined) continue;
    const label = rawLabel.trim();
    const count = parseFloat(rawCount);

    const field = PAGE_FIELDS[label];
    if (field) {
      snap[field] = toMb(count);
      matchedFields++;
      continue;
    }
    if (label === "Swapins") {
      snap.swap_in = count;
      matchedFields++;
    } else if (label === "Swapouts") {
      snap.swap_out = count;
      matchedFields++;
    }
  }

  if (matchedFields === 0) {
    snap.available = false;
  }

  return snap;
}

export async function probeNodeMem(opts?: {
  exec?: (cmd: string) => Promise<string>;
}): Promise<NodeMemSnapshot> {
  const exec =
    opts?.exec ??
    ((_cmd: string): Promise<string> => {
      const proc = Bun.spawnSync(["vm_stat"]);
      if (proc.exitCode !== 0) return Promise.resolve("");
      return Promise.resolve(new TextDecoder().decode(proc.stdout));
    });
  return parseVmStatOutput(await exec("vm_stat"));
}
