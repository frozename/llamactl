const SLOT_REQUEST_TIMEOUT_MS = 10_000;

export interface SlotClient {
  save(slotId: number, filename: string): Promise<SlotSaveResult>;
  restore(slotId: number, filename: string): Promise<SlotRestoreResult>;
  supportsSlots(): Promise<boolean>;
}

export type SlotSaveResult =
  | { ok: true; tokensSaved: number }
  | { ok: false; reason: 'http_error' | 'network' | 'invalid_response'; status?: number; error: Error };

export type SlotRestoreResult =
  | { ok: true; tokensRestored: number }
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

  constructor(baseUrl: string) {
    this.baseUrl = new URL(baseUrl);
  }

  async save(slotId: number, filename: string): Promise<SlotSaveResult> {
    const result = await this.postSlotAction(slotId, 'save', filename);
    if (!result.ok) return { ok: false, reason: 'network', error: result.error };
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
    if (!result.ok) return { ok: false, reason: 'network', error: result.error };
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
    return { ok: true, tokensRestored };
  }

  supportsSlots(): Promise<boolean> {
    if (!this.supportsSlotsProbe) {
      this.supportsSlotsProbe = this.probeSupportsSlots();
    }
    return this.supportsSlotsProbe;
  }

  private async postSlotAction(
    slotId: number,
    action: 'save' | 'restore',
    filename: string,
  ): Promise<FetchResult> {
    const url = new URL(`/slots/${slotId}`, this.baseUrl);
    url.searchParams.set('action', action);
    url.searchParams.set('filename', filename);
    return this.fetchWithTimeout(url, 'POST');
  }

  private async probeSupportsSlots(): Promise<boolean> {
    const url = new URL('/props', this.baseUrl);
    const result = await this.fetchWithTimeout(url, 'GET');
    if (!result.ok || !result.response.ok) return false;
    const parsed = await this.parseJsonBody(result.response);
    return parsed.ok && typeof parsed.value === 'object' && parsed.value !== null;
  }

  private async fetchWithTimeout(url: URL, method: 'GET' | 'POST'): Promise<FetchResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SLOT_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { method, signal: controller.signal });
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

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' ? error : 'Unknown error');
}
