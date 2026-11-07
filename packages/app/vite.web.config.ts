// Web console renderer build: the only UI runtime since #410 P7-A.
// Bundles the console shell from src/index.web.html into out/web,
// served by `llamactl console` on loopback.

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
