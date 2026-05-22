import type { NodeMemSnapshot } from './types.js';

const PAGE_FIELDS: Record<string, keyof NodeMemSnapshot> = {
  'Pages free':                    'free_mb',
  'Pages active':                  'active_mb',
  'Pages inactive':                'inactive_mb',
  'Pages wired down':              'wired_mb',
  'Pages occupied by compressor':  'compressor_mb',
};

export function parseVmStatOutput(raw: string): NodeMemSnapshot {
  const pageSizeMatch = raw.match(/page size of (\d+) bytes/);
  const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1]!, 10) : 4096;
  const toMb = (pages: number) => (pages * pageSize) / 1024 / 1024;

  const snap: NodeMemSnapshot = {
    free_mb: 0, active_mb: 0, inactive_mb: 0,
    wired_mb: 0, compressor_mb: 0, swap_in: 0, swap_out: 0,
  };

  for (const line of raw.split('\n')) {
    const pageMatch = line.match(/^(.+?):\s+([\d.]+)\./);
    if (!pageMatch) continue;
    const label = pageMatch[1]!.trim();
    const count = parseFloat(pageMatch[2]!);

    const field = PAGE_FIELDS[label];
    if (field) {
      snap[field] = toMb(count);
      continue;
    }
    if (label === 'Swapins')  snap.swap_in  = count;
    if (label === 'Swapouts') snap.swap_out = count;
  }

  return snap;
}

export async function probeNodeMem(
  opts?: { exec?: (cmd: string) => Promise<string> },
): Promise<NodeMemSnapshot> {
  const exec = opts?.exec ?? (async (_cmd: string) => {
    const proc = Bun.spawnSync(['vm_stat']);
    return new TextDecoder().decode(proc.stdout);
  });
  return parseVmStatOutput(await exec('vm_stat'));
}
