// #410: transport-neutral tRPC React core for the web console; the
// caller injects the link set (HTTP/SSE in the browser).

import type { AppRouter } from "@llamactl/remote";
import type { TRPCLink } from "@trpc/client";

import { createTRPCReact } from "@trpc/react-query";

export const trpc: ReturnType<typeof createTRPCReact<AppRouter>> = createTRPCReact<AppRouter>();

export function createAppClient(
  links: TRPCLink<AppRouter>[],
): ReturnType<typeof trpc.createClient> {
  return trpc.createClient({ links });
}
