import { createTRPCReact } from '@trpc/react-query';
import { createTRPCClient } from '@trpc/client';
import { ipcLink } from './ipc-link';
import type { AppRouter, UIRouter } from '../../electron/trpc/router';

export const trpc: ReturnType<typeof createTRPCReact<AppRouter>> =
  createTRPCReact<AppRouter>();

export const trpcClient: ReturnType<typeof trpc.createClient> = trpc.createClient({
  links: [ipcLink<AppRouter>()],
});

/**
 * Typed client for the two UI-only procedures (`uiSetActiveNode`,
 * `uiGetActiveNode`). We keep it outside the React-Query-wrapped
 * `trpc` because merging the base and UI router types runs into
 * composite-declaration portability errors in this workspace. The
 * UI procedures are called imperatively (no cache, no reactivity)
 * from the node selector, so a plain client is enough.
 */
export const trpcUIClient: ReturnType<typeof createTRPCClient<UIRouter>> =
  createTRPCClient<UIRouter>({
    links: [ipcLink<UIRouter>()],
  });
