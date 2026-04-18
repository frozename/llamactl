import { exposeElectronTRPC } from 'electron-trpc/preload';

process.once('loaded', () => {
  exposeElectronTRPC();
});
