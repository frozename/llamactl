import type { GuardianDecision } from './state.js';

/**
 * First real action on the cost-guardian foundation. Posts the
 * decision JSON to the configured webhook URL whenever the tick
 * decides anything other than noop. Success + failure are both
 * captured as journal action entries (caller responsible for
 * actually journaling).
 *
 * The fetcher is injectable so tests can assert the payload shape
 * and retry behaviour without hitting the network. Defaults to
 * globalThis.fetch — the Bun native fetch handles timeouts via
 * AbortSignal.timeout().
 */

export interface WebhookFetcher {
  (
    url: string,
    init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal },
  ): Promise<{ ok: boolean; status: number; text?: () => Promise<string> }>;
}

export interface PostGuardianWebhookOptions {
  url: string;
  decision: GuardianDecision;
  /** Defaults to globalThis.fetch. */
  fetcher?: WebhookFetcher;
  /** Total timeout across network + server. Default 5 s. */
  timeoutMs?: number;
}

export type WebhookOutcome =
  | { ok: true; status: number }
  | { ok: false; status: number; error: string };

function defaultFetcher(
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal },
): ReturnType<WebhookFetcher> {
  const fetchInit: RequestInit = {
    method: init.method,
    headers: init.headers,
    body: init.body,
    ...(init.signal ? { signal: init.signal } : {}),
  };
  return fetch(url, fetchInit).then((res) => ({
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
  }));
}

export async function postGuardianWebhook(
  opts: PostGuardianWebhookOptions,
): Promise<WebhookOutcome> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(opts.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'llamactl-cost-guardian/0.1',
      },
      body: JSON.stringify(opts.decision),
      signal: controller.signal,
    });
    if (res.ok) {
      return { ok: true, status: res.status };
    }
    let errBody = '';
    try {
      errBody = (await res.text?.()) ?? '';
    } catch {
      // best-effort
    }
    return {
      ok: false,
      status: res.status,
      error: errBody.slice(0, 300) || `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: (err as Error).message || 'webhook fetcher threw',
    };
  } finally {
    clearTimeout(timer);
  }
}
