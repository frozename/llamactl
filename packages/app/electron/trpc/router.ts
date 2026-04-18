// The renderer imports the base AppRouter via electron-trpc for
// React-Query-driven hooks (query, mutation, subscription). The
// UI-only procedures (`uiSetActiveNode` / `uiGetActiveNode`) live on
// a separate typed client — see `src/lib/trpc.ts` — so we don't need
// to merge router types here, which would force tsc to chase deep
// `@llamactl/core` module paths and break composite declaration emit.
export { router, type AppRouter } from '@llamactl/remote';
export type { UIRouter } from './dispatcher';
