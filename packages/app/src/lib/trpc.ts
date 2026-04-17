import { createTRPCReact } from '@trpc/react-query';
import { ipcLink } from 'electron-trpc/renderer';
import type { AppRouter } from '../../electron/trpc/router';

export const trpc: ReturnType<typeof createTRPCReact<AppRouter>> =
  createTRPCReact<AppRouter>();

export const trpcClient: ReturnType<typeof trpc.createClient> = trpc.createClient({
  links: [ipcLink()],
});
