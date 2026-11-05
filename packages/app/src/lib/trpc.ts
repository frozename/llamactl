import { createTRPCClient } from "@trpc/client";

import type { UIRouter } from "../../electron/trpc/router";

import { ipcLink } from "./transport/ipc";

export { createAppClient, trpc } from "./trpc-core";

/**
 * Typed client for the two UI-only procedures (`uiSetActiveNode`,
 * `uiGetActiveNode`). We keep it outside the React-Query-wrapped
 * `trpc` because merging the base and UI router types runs into
 * composite-declaration portability errors in this workspace. The
 * UI procedures are called imperatively (no cache, no reactivity)
 * from the node selector, so a plain client is enough.
 *
 * Interim (#410 P1): stays IPC-bound and module-scoped. The P1
 * follow-up replaces this with getUIClient()/ui-client.electron.ts
 * and removes both the ipc import and the electron type import from
 * this file.
 */
export const trpcUIClient: ReturnType<typeof createTRPCClient<UIRouter>> =
  createTRPCClient<UIRouter>({
    links: [ipcLink<UIRouter>()],
  });
