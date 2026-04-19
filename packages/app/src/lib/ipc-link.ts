import { observable } from '@trpc/server/observable';
import type { TRPCLink } from '@trpc/client';
import { TRPCClientError } from '@trpc/client';
import type { AnyRouter } from '@trpc/server';

interface ElectronTRPCBridge {
  sendMessage: (msg: unknown) => void;
  onMessage: (cb: (msg: any) => void) => void;
}

function getBridge(): ElectronTRPCBridge {
  const bridge = (globalThis as any).electronTRPC as ElectronTRPCBridge | undefined;
  if (!bridge) {
    throw new Error(
      'electronTRPC global not found — ensure exposeElectronTRPC() ran in the preload.',
    );
  }
  return bridge;
}

type Pending = {
  next: (envelope: any) => void;
  error: (err: unknown) => void;
  complete: () => void;
  type: 'query' | 'mutation' | 'subscription';
};

class IPCClient {
  private bridge = getBridge();
  private pending = new Map<number | string, Pending>();

  constructor() {
    this.bridge.onMessage((msg) => this.handleResponse(msg));
  }

  private handleResponse(msg: any) {
    const entry = msg?.id != null ? this.pending.get(msg.id) : undefined;
    if (!entry) return;
    entry.next(msg);
    if ('result' in msg && msg.result?.type === 'stopped') {
      entry.complete();
    }
  }

  request(op: {
    id: number | string;
    type: 'query' | 'mutation' | 'subscription';
    path: string;
    input: unknown;
    context?: unknown;
  }, cb: Pending): () => void {
    this.pending.set(op.id, { ...cb, type: op.type });
    this.bridge.sendMessage({ method: 'request', operation: op });
    return () => {
      const entry = this.pending.get(op.id);
      this.pending.delete(op.id);
      entry?.complete();
      if (op.type === 'subscription') {
        this.bridge.sendMessage({ id: op.id, method: 'subscription.stop' });
      }
    };
  }
}

function transformResponse(envelope: any) {
  if ('error' in envelope) {
    return { ok: false as const, error: envelope };
  }
  return { ok: true as const, result: envelope.result };
}

export function ipcLink<TRouter extends AnyRouter>(): TRPCLink<TRouter> {
  return () => {
    const client = new IPCClient();
    return ({ op }) => {
      return observable((obs) => {
        const teardown = client.request(op as any, {
          type: op.type as any,
          next(envelope) {
            const res = transformResponse(envelope);
            if (!res.ok) {
              obs.error(TRPCClientError.from(res.error));
              return;
            }
            obs.next({ result: res.result });
            if (op.type !== 'subscription') {
              teardown();
              obs.complete();
            }
          },
          error(err) {
            obs.error(TRPCClientError.from(err as any));
            teardown();
          },
          complete() {
            obs.complete();
          },
        });
        return () => teardown();
      });
    };
  };
}
