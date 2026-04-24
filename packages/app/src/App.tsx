import * as React from 'react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { trpc, trpcClient } from '@/lib/trpc';
import { BeaconLayout } from '@/shell/beacon/layout';
import { ThemeProvider } from '@/shell/theme-provider';

export function App(): React.JSX.Element {
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
