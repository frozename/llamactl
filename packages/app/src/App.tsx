import type { AppRouter } from "@llamactl/remote";
import type { TRPCLink } from "@trpc/client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { useState } from "react";

import { createAppClient, trpc } from "@/lib/trpc";
import { BeaconLayout } from "@/shell/beacon/layout";
import { ThemeProvider } from "@/shell/theme-provider";

export function App({ links }: { links: TRPCLink<AppRouter>[] }): React.JSX.Element {
  const [trpcClient] = useState(() => createAppClient(links));
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <ThemeProvider>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <BeaconLayout />
        </QueryClientProvider>
      </trpc.Provider>
    </ThemeProvider>
  );
}
