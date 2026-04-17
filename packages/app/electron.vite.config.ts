import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Bundle everything except `electron` itself into the main/preload
// outputs. The historical default here is `externalizeDepsPlugin` (keep
// deps as runtime CJS require()s), but Electron's ESM loader (v20 Node)
// refuses to preparse certain deps and crashes on start. Bundling means
// main/preload become self-contained ESM modules with no CJS interop
// surprises, at the cost of ~200kB extra bytes on disk.
// `@llamactl/app` inherits the workspace root's `"type": "module"`, which
// would normally treat the bundled `.js` output as ESM. Electron's
// main-process Node 20.18 ESM loader chokes on several CJS→ESM interop
// edges, so we emit the main + preload bundles as CommonJS (.cjs) which
// gives us decades of stable Electron packaging behaviour.
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve('electron/main.ts') },
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: 'chunks/[name]-[hash].cjs',
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve('electron/preload.ts') },
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: 'chunks/[name]-[hash].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve('src'),
    resolve: {
      alias: { '@': resolve('src') },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/index.html') },
      },
    },
    server: {
      port: 5173,
    },
  },
});
