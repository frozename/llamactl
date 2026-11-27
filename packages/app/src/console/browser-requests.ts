import type { CapturedRequest } from "@llamactl/remote";

import { useSyncExternalStore } from "react";

const MAX_REQUESTS = 20;
const MAX_BYTES = 64 * 1024;
const encoder = new TextEncoder();
export type BrowserRequest = CapturedRequest & { node: string };
let history: readonly BrowserRequest[] = [];
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

function bounded(value: unknown): { value: unknown; truncated: boolean } {
  if (encoder.encode(JSON.stringify(value ?? null)).byteLength <= MAX_BYTES)
    return { value, truncated: false };
  return { value: null, truncated: true };
}

export function saveBrowserRequest(record: BrowserRequest): void {
  const request = bounded(record.request);
  const response = bounded(record.response);
  history = [
    {
      ...record,
      request: request.value,
      response: response.value,
      truncated: request.truncated || response.truncated,
    },
    ...history.slice(0, MAX_REQUESTS - 1),
  ];
  for (const listener of listeners) listener();
}

function snapshot(): readonly BrowserRequest[] {
  return history;
}

export function useBrowserRequests(): readonly BrowserRequest[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
