import { EventEmitter } from "node:events";

import type { JournalEvent } from "./journal-schema.js";

const channels = new Map<string, EventEmitter>();
const openChannels = new Set<string>();
const globalEvents = new EventEmitter();

function ensure(sessionId: string): EventEmitter {
  let e = channels.get(sessionId);
  if (!e) {
    e = new EventEmitter();
    e.setMaxListeners(50);
    channels.set(sessionId, e);
  }
  return e;
}

export const sessionEventBus = {
  create(sessionId: string): void {
    ensure(sessionId);
    openChannels.add(sessionId);
  },
  hasChannel(sessionId: string): boolean {
    return openChannels.has(sessionId);
  },
  publish(sessionId: string, event: JournalEvent): void {
    if (!openChannels.has(sessionId)) return;
    const e = channels.get(sessionId);
    if (!e) return;
    e.emit("event", event);
    globalEvents.emit("event", sessionId, event);
  },
  subscribe(sessionId: string, listener: (event: JournalEvent) => void): () => void {
    const e = ensure(sessionId);
    e.on("event", listener);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      e.off("event", listener);
      // Watching a finished (or never-opened) session went through
      // `ensure`, so the map entry survived the unsubscribe forever.
      // Drop it once this is the emitter still in the map (a `close()`
      // may have replaced it, and a stale unsubscribe must not evict
      // the newer channel), the run is over (`openChannels` is what
      // marks a live run, and only `close()` releases it) and no other
      // subscriber is left on this emitter.
      if (
        channels.get(sessionId) === e &&
        !openChannels.has(sessionId) &&
        e.listenerCount("event") === 0
      ) {
        channels.delete(sessionId);
      }
    };
  },
  subscribeAll(listener: (sessionId: string, event: JournalEvent) => void): () => void {
    globalEvents.on("event", listener);
    return () => {
      globalEvents.off("event", listener);
    };
  },
  close(sessionId: string): void {
    openChannels.delete(sessionId);
    const e = channels.get(sessionId);
    if (!e) return;
    e.removeAllListeners();
    channels.delete(sessionId);
  },
  /**
   * Number of "event" listeners currently attached to a session's
   * channel (0 when the channel has never been created). Exposed so a
   * subscriber that parks on the bus can be checked for listener leaks:
   * after the subscriber disconnects, the count must return to its
   * pre-subscribe value. Returns the live emitter listener count, not a
   * cached one, so it never drifts from reality.
   */
  listenerCount(sessionId: string): number {
    return channels.get(sessionId)?.listenerCount("event") ?? 0;
  },
  /**
   * Number of session channels the bus is holding in memory. Exposed so
   * the #367 retention checks can assert that subscribing to a finished
   * or unknown session and unsubscribing leaves the map no larger than
   * it was. Read-only: it changes no state.
   */
  retainedChannelCount(): number {
    return channels.size;
  },
};
