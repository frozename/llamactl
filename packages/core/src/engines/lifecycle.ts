const POLL_MS = 100;
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

export async function gracefulShutdown(pid: number, graceMs = 10_000): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    const remaining = deadline - Date.now();
    await sleep(Math.min(POLL_MS, Math.max(0, remaining)));
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

async function fetchModelIds(
  endpoint: { host: string; port: number },
  timeoutMs: number,
): Promise<string[]> {
  const response = await fetch(`http://${formatHostForUrl(endpoint.host)}:${endpoint.port}/v1/models`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    return [];
  }
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((model) => model.id ?? '').filter(Boolean);
}

export async function pollUntilModelIds(
  endpoint: { host: string; port: number },
  timeoutMs: number,
): Promise<{ ready: boolean; modelIds: string[] }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const remaining = deadline - Date.now();
      const modelIds = await fetchModelIds(endpoint, Math.min(1000, Math.max(1, remaining)));
      if (modelIds.length > 0) {
        return { ready: true, modelIds };
      }
    } catch {}
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await sleep(Math.min(250, remaining));
  }
  return { ready: false, modelIds: [] };
}
