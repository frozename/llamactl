// Invalid-session store for the web console (#410 P4). A 401
// `invalid_session` anywhere in the transport marks the store once; the
// shell renders INVALID_SESSION_MESSAGE while it is set. Deliberately no
// persistence: the session boundary is the server process, and a reload
// after a real restart re-authenticates anyway.

import { useSyncExternalStore } from "react";

export const INVALID_SESSION_MESSAGE = "Console restarted or session expired — reload";

export interface SessionStore {
  isInvalid: () => boolean;
  markInvalid: () => void;
  reset: () => void;
  subscribe: (listener: () => void) => () => void;
}

export function createSessionStore(): SessionStore {
  let invalid = false;
  const listeners = new Set<() => void>();
  return {
    isInvalid: () => invalid,
    markInvalid(): void {
      if (invalid) return;
      invalid = true;
      for (const listener of listeners) listener();
    },
    reset(): void {
      invalid = false;
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const consoleSessionStore: SessionStore = createSessionStore();

export function useInvalidSession(): boolean {
  return useSyncExternalStore(
    consoleSessionStore.subscribe,
    consoleSessionStore.isInvalid,
    consoleSessionStore.isInvalid,
  );
}
