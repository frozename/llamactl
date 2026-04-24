import * as React from 'react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { trpc, trpcClient } from '@/lib/trpc';
import { IDELayout } from '@/shell/ide-layout';
import { BeaconLayout } from '@/shell/beacon/layout';
import { ThemeProvider } from '@/shell/theme-provider';
import { useShellFlag } from '@/stores/shell-flag';

export function App(): React.JSX.Element {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Core reads are cheap and mostly cache-backed. Long stale
            // windows mean the shell doesn't refetch everything on
            // module switches, which would defeat the whole point of
            // an IDE-style layout.
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  const beaconShell = useShellFlag((s) => s.beaconShell);

  return (
    <ThemeProvider>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          {beaconShell ? <BeaconLayout /> : <IDELayout />}
        </QueryClientProvider>
      </trpc.Provider>
    </ThemeProvider>
  );
}
