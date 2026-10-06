import { EventSource } from "eventsource";

/**
 * eventsource@4.1.x dispatches events from an already-read chunk after `close()`;
 * tRPC <=11.19.0's SSE RETURN listener then calls `controller.close()` without a
 * guard and throws uncaught. Use a flag instead of `readyState === CLOSED`
 * because eventsource's failConnection sets CLOSED before dispatching the
 * `error` event tRPC needs, which would turn connection failures into silent
 * completion. Delete this class once eventsource >=5.1.2 is adopted.
 */
export class ClosedSafeEventSource extends EventSource {
  #closedByClient = false;

  override close(): void {
    this.#closedByClient = true;
    super.close();
  }

  override dispatchEvent(event: Event): boolean {
    if (this.#closedByClient) return false;
    return super.dispatchEvent(event);
  }
}
