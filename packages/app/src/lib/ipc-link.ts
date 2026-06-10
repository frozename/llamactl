import type { TRPCLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";

import { TRPCClientError } from "@trpc/client";
import { observable } from "@trpc/server/observable";

interface ElectronTRPCBridge {
  sendMessage: (msg: unknown) => void;
  onMessage: (cb: (msg: unknown) => void) => void;
}

function getBridge(): ElectronTRPCBridge {
  const bridge = (
    globalThis as typeof globalThis & {
      electronTRPC?: ElectronTRPCBridge;
    }
  ).electronTRPC;
  if (!bridge) {
    throw new Error(
      "electronTRPC global not found — ensure exposeElectronTRPC() ran in the preload.",
    );
  }
  return bridge;
}

type Pending = {
  next: (envelope: unknown) => void;
  error: (err: unknown) => void;
  complete: () => void;
  type: "query" | "mutation" | "subscription";
};

class IPCClient {
  private bridge = getBridge();
  private pending = new Map<number | string, Pending>();

  constructor() {
    this.bridge.onMessage((msg) => {
      this.handleResponse(msg);
    });
  }

  private handleResponse(msg: unknown): void {
    const envelope = msg as { id?: number | string; result?: { type?: string } } | null;
    const entry = envelope?.id !== undefined ? this.pending.get(envelope.id) : undefined;
    if (!entry) return;
    entry.next(msg);
    if (envelope?.result?.type === "stopped") {
      entry.complete();
    }
  }

  request(
    op: {
      id: number | string;
      type: "query" | "mutation" | "subscription";
      path: string;
      input: unknown;
      context?: unknown;
    },
    cb: Pending,
  ): () => void {
    this.pending.set(op.id, { ...cb, type: op.type });
    this.bridge.sendMessage({ method: "request", operation: op });
    return () => {
      const entry = this.pending.get(op.id);
      this.pending.delete(op.id);
      entry?.complete();
      if (op.type === "subscription") {
        this.bridge.sendMessage({ id: op.id, method: "subscription.stop" });
      }
    };
  }
}

function transformResponse(
  envelope: unknown,
): { ok: false; error: object & Record<"error", unknown> } | { ok: true; result: unknown } {
  if (typeof envelope === "object" && envelope !== null && "error" in envelope) {
    return { ok: false as const, error: envelope };
  }
  const result = envelope as { result: unknown };
  return { ok: true as const, result: result.result };
}

export function ipcLink<TRouter extends AnyRouter>(): TRPCLink<TRouter> {
  return () => {
    const client = new IPCClient();
    return ({ op }) => {
      return observable((obs) => {
        const teardown = client.request(op, {
          type: op.type,
          next(envelope) {
            const res = transformResponse(envelope);
            if (!res.ok) {
              obs.error(TRPCClientError.from(res.error));
              return;
            }
            obs.next({ result: res.result } as Parameters<typeof obs.next>[0]);
            if (op.type !== "subscription") {
              teardown();
              obs.complete();
            }
          },
          error(err) {
            obs.error(TRPCClientError.from(err as Error));
            teardown();
          },
          complete() {
            obs.complete();
          },
        });
        return () => {
          teardown();
        };
      });
    };
  };
}
