const SLOT_REQUEST_TIMEOUT_MS = 10_000;
const SUPPORTS_REQUEST_HANDLE_TTL_MS = 60_000;

export interface SlotClient {
  save(slotId: number, filename: string): Promise<SlotSaveResult>;
  restore(slotId: number, filename: string): Promise<SlotRestoreResult>;
  supportsSlots(): Promise<boolean>;
  supportsRequestHandle(): Promise<boolean>;
}

export type SlotSaveResult =
  | { ok: true; tokensSaved: number }
  | { ok: false; reason: 'http_error' | 'network' | 'invalid_response'; status?: number; error: Error };

export type SlotRestoreResult =
  | { ok: true; tokensRestored: number; restore_epoch: string | null }
  | {
    ok: false;
    reason: 'http_error' | 'network' | 'invalid_response' | 'not_found';
    status?: number;
    error: Error;
  };

type FetchResult =
  | { ok: true; response: Response }
  | { ok: false; error: Error };

export class UpstreamSlotClient implements SlotClient {
  private readonly baseUrl: URL;
  private supportsSlotsProbe: Promise<boolean> | null = null;
  private _supportsRequestHandleCache: { value: boolean; expiresAt: number } | null = null;
  private readonly supportsRequestHandleTtlMs: number;

  constructor(baseUrl: string, opts?: { fetch?: typeof fetch; supportsRequestHandleTtlMs?: number }) {
    this.baseUrl = new URL(baseUrl);
    this.supportsRequestHandleTtlMs = opts?.supportsRequestHandleTtlMs ?? SUPPORTS_REQUEST_HANDLE_TTL_MS;
  }

  async save(slotId: number, filename: string): Promise<SlotSaveResult> {
    const result = await this.postSlotAction(slotId, 'save', filename);
    if (!result.ok) {
      this.invalidateCapabilityCache();
      return { ok: false, reason: 'network', error: result.error };
    }
    if (!result.response.ok) {
      return {
        ok: false,
        reason: 'http_error',
        status: result.response.status,
        error: new Error(`slot save failed with HTTP ${result.response.status}`),
      };
    }
    const body = await this.parseJsonBody(result.response);
    if (!body.ok) return { ok: false, reason: 'invalid_response', error: body.error };
    const tokensSaved = readNumberField(body.value, 'n_saved');
    if (tokensSaved === null) {
      return {
        ok: false,
        reason: 'invalid_response',
        error: new Error('slot save response missing numeric n_saved'),
      };
    }
    return { ok: true, tokensSaved };
  }

  async restore(slotId: number, filename: string): Promise<SlotRestoreResult> {
    const result = await this.postSlotAction(slotId, 'restore', filename);
    if (!result.ok) {
      this.invalidateCapabilityCache();
      return { ok: false, reason: 'network', error: result.error };
    }
    if (!result.response.ok) {
      if (result.response.status === 404) {
        return {
          ok: false,
          reason: 'not_found',
          status: 404,
          error: new Error('slot restore target not found'),
        };
      }
      return {
        ok: false,
        reason: 'http_error',
        status: result.response.status,
        error: new Error(`slot restore failed with HTTP ${result.response.status}`),
      };
    }
    const body = await this.parseJsonBody(result.response);
    if (!body.ok) return { ok: false, reason: 'invalid_response', error: body.error };
    const tokensRestored = readNumberField(body.value, 'n_restored') ?? readNumberField(body.value, 'n_saved');
    if (tokensRestored === null) {
      return {
        ok: false,
        reason: 'invalid_response',
        error: new Error('slot restore response missing numeric n_restored'),
      };
    }
    return { ok: true, tokensRestored, restore_epoch: readStringField(body.value, 'restore_epoch') };
  }

  supportsSlots(): Promise<boolean> {
    if (!this.supportsSlotsProbe) {
      this.supportsSlotsProbe = this.probeSupportsSlots();
    }
    return this.supportsSlotsProbe;
  }

  supportsRequestHandle(): Promise<boolean> {
    const cache = this._supportsRequestHandleCache;
    if (cache && cache.value === true && Date.now() < cache.expiresAt) {
      return Promise.resolve(cache.value);
    }
    return this.probeSupportsRequestHandle();
  }

  invalidateCapabilityCache(): void {
    this._supportsRequestHandleCache = null;
  }

  private async postSlotAction(
    slotId: number,
    action: 'save' | 'restore',
    filename: string,
  ): Promise<FetchResult> {
    const url = new URL(`/slots/${slotId}`, this.baseUrl);
    url.searchParams.set('action', action);
    return this.fetchWithTimeout(url, 'POST', JSON.stringify({ filename }));
  }

  private async probeSupportsSlots(): Promise<boolean> {
    const parsed = await this.fetchProps();
    return parsed.ok && typeof parsed.value === 'object' && parsed.value !== null;
  }

  private async probeSupportsRequestHandle(): Promise<boolean> {
    const parsed = await this.fetchProps();
    const value = parsed.ok && hasRequestHandleCapability(parsed.value);
    this._supportsRequestHandleCache = {
      value,
      expiresAt: Date.now() + this.supportsRequestHandleTtlMs,
    };
    return value;
  }

  private async fetchProps(): Promise<{ ok: true; value: unknown } | { ok: false }> {
    const url = new URL('/props', this.baseUrl);
    const result = await this.fetchWithTimeout(url, 'GET');
    if (!result.ok || !result.response.ok) return { ok: false };
    const parsed = await this.parseJsonBody(result.response);
    if (!parsed.ok) return { ok: false };
    return { ok: true, value: parsed.value };
  }

  private async fetchWithTimeout(url: URL, method: 'GET' | 'POST', body?: string): Promise<FetchResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SLOT_REQUEST_TIMEOUT_MS);
    try {
      const init: RequestInit = { method, signal: controller.signal };
      if (body !== undefined) {
        init.body = body;
        init.headers = { 'content-type': 'application/json' };
      }
      const response = await fetch(url, init);
      return { ok: true, response };
    } catch (error: unknown) {
      return { ok: false, error: toError(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parseJsonBody(
    response: Response,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: Error }> {
    try {
      return { ok: true, value: await response.json() };
    } catch (error: unknown) {
      return { ok: false, error: toError(error) };
    }
  }
}

function readNumberField(value: unknown, key: string): number | null {
  if (!value || typeof value !== 'object') return null;
  const field = (value as Record<string, unknown>)[key];
  if (typeof field !== 'number' || !Number.isFinite(field)) return null;
  return field;
}

function readStringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : null;
}

function hasRequestHandleCapability(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const slots = (value as Record<string, unknown>).slots;
  if (!slots || typeof slots !== 'object') return false;
  const version = (slots as Record<string, unknown>).api_version;
  if (typeof version !== 'number' || !Number.isFinite(version) || version < 2) return false;
  return (slots as Record<string, unknown>).supports_request_handle === true;
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' ? error : 'Unknown error');
}
