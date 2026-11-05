// Plain-web renderer build (no Electron main/preload): the same module
// graph the Electron renderer ships, used by the #410 console gate to
// prove the console shells (e.g. actions/stop-server.tsx) still compile
// through vite with the `@/` alias. Mirrors the renderer section of
// electron.vite.config.ts; keep the two in sync when the renderer
// config changes.

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve("src"),
  resolve: {
    alias: { "@": resolve("src") },
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve("out/web"),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve("src/index.html") },
    },
  },
});
