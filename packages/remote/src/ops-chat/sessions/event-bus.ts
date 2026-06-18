import { EventEmitter } from "node:events";

import type { JournalEvent } from "./journal-schema.js";

const channels = new Map<string, EventEmitter>();
const openChannels = new Set<string>();

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
  },
  subscribe(sessionId: string, listener: (event: JournalEvent) => void): () => void {
    const e = ensure(sessionId);
    e.on("event", listener);
    return () => {
      e.off("event", listener);
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
};
