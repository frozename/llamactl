// Console-only web renderer build (no Electron main/preload): bundles
// the #410 console shell from src/index.web.html into out/web, served
// by the agent's console gate. The Electron renderer keeps its own
// section in electron.vite.config.ts; the shared renderer options
// (react + tailwind + `@/` alias) must stay in sync between the two.

import type { Plugin } from "vite";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const renameWebEntry: Plugin = {
  name: "llamactl-rename-web-entry",
  enforce: "post",
  generateBundle(_options, bundle) {
    const entry = bundle["index.web.html"];
    if (entry === undefined) {
      return;
    }
    delete bundle["index.web.html"];
    entry.fileName = "index.html";
    bundle["index.html"] = entry;
  },
};

export default defineConfig({
  root: resolve("src"),
  resolve: {
    alias: { "@": resolve("src") },
  },
  plugins: [react(), tailwindcss(), renameWebEntry],
  build: {
    outDir: resolve("out/web"),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve("src/index.web.html") },
    },
  },
});
