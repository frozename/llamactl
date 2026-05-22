export interface WorkloadTarget {
  name: string;
  endpoint: string;
  kind: 'ModelHost' | 'ModelRun';
}

export interface WorkloadProbeOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  priorConsecutiveErrors?: number;
}

export interface WorkloadProbeResult {
  reachable: boolean;
  healthLatencyMs: number;
  models: string[];
  consecutiveErrors: number;
}

export async function probeWorkload(
  target: WorkloadTarget,
  opts: WorkloadProbeOptions = {},
): Promise<WorkloadProbeResult> {
  const { fetch: fetchFn = globalThis.fetch, timeoutMs = 5000, priorConsecutiveErrors = 0 } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const healthRes = await fetchFn(`${target.endpoint}/health`, { signal: controller.signal });
    clearTimeout(timer);
    const latency = Date.now() - start;

    if (!healthRes.ok) {
      return { reachable: false, healthLatencyMs: latency, models: [], consecutiveErrors: priorConsecutiveErrors + 1 };
    }

    let models: string[] = [];
    try {
      const modelsRes = await fetchFn(`${target.endpoint}/v1/models`);
      if (modelsRes.ok) {
        const body = await modelsRes.json() as { data: Array<{ id: string }> };
        models = body.data.map((m) => m.id);
      }
    } catch {
      // models fetch failure does not make the endpoint unreachable
    }

    return { reachable: true, healthLatencyMs: latency, models, consecutiveErrors: 0 };
  } catch {
    clearTimeout(timer);
    return { reachable: false, healthLatencyMs: Date.now() - start, models: [], consecutiveErrors: priorConsecutiveErrors + 1 };
  }
}
