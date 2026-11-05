// #410: transport-neutral tRPC React core shared by the Electron renderer
// (via lib/trpc) and the web console; must stay free of the IPC transport.

import type { AppRouter } from "@llamactl/remote";
import type { TRPCLink } from "@trpc/client";

import { createTRPCReact } from "@trpc/react-query";

export const trpc: ReturnType<typeof createTRPCReact<AppRouter>> = createTRPCReact<AppRouter>();

export function createAppClient(
  links: TRPCLink<AppRouter>[],
): ReturnType<typeof trpc.createClient> {
  return trpc.createClient({ links });
}
