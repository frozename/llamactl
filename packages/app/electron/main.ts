import { env as envMod } from "@llamactl/core";
import { app, BrowserWindow, ipcMain } from "electron";
import { createIPCHandler } from "electron-trpc/main";
import { join } from "node:path";

import { buildDispatcherRouter } from "./trpc/dispatcher.js";

type IPCHandlerOptions = Parameters<typeof createIPCHandler>[0];

// `__dirname` is set by Rollup's CJS wrapper, so we don't need the
// ESM-style `fileURLToPath(import.meta.url)` dance here.
declare const __dirname: string;

/**
 * Seed `process.env` from `env.resolveEnv()` at startup so every
 * tRPC procedure that reads `process.env.DEV_STORAGE` / `HF_HOME` /
 * etc. agrees with the resolver's cascade — including hermetic
 * `LLAMACTL_TEST_PROFILE` audits that reroot every AI-model path.
 * Without this, modules like the cost-guardian journal hint, healer
 * journal, and LM Studio probe fall back to `homedir()` and leak
 * the operator's real paths into the hermetic window.
 *
 * Priority stays: individual env var the caller set > test-profile
 * default > production fallback (`resolveEnv` itself respects that).
 * We skip undefined values so a missing key never stringifies to
 * "undefined" in `process.env`. Existing shell-level overrides are
 * preserved because `resolveEnv` reads them as the highest priority
 * when composing its result.
 */
function seedEnvFromResolver(): void {
  const resolved = envMod.resolveEnv();
  for (const [key, value] of Object.entries(resolved)) {
    if (value === undefined) continue;
    process.env[key] = String(value);
  }
  envMod.ensureDirs(resolved);
}

seedEnvFromResolver();

/**
 * Returns true when `frameUrl` is from the same trusted origin as
 * `trustedUrl`. In dev mode the trusted URL is the Vite dev-server
 * origin (http://localhost:NNNN); in prod it is "file://" — any
 * file: renderer URL is accepted. Both `will-navigate` and the IPC
 * createContext guard use this function.
 *
 * Exported for unit testing without a live Electron environment.
 */
export function isTrustedRendererOrigin(frameUrl: string, trustedUrl: string): boolean {
  if (!frameUrl) return false;
  try {
    const frame = new URL(frameUrl);
    const trusted = new URL(trustedUrl);
    if (trusted.protocol === "file:") {
      return frame.protocol === "file:";
    }
    return frame.origin === trusted.origin;
  } catch {
    return false;
  }
}

/**
 * Builds the createContext guard for createIPCHandler. Throws when the
 * sender frame's URL is not from the trusted renderer origin, so IPC
 * invocations from injected or navigated-away frames are rejected before
 * any procedure runs.
 *
 * Exported for unit testing without a live Electron environment.
 */
export function makeIpcCreateContext(
  trustedUrl: string,
): (opts: { event: { senderFrame?: { url: string } | null } }) => object {
  return (opts) => {
    const frameUrl = opts.event.senderFrame?.url ?? "";
    if (!isTrustedRendererOrigin(frameUrl, trustedUrl)) {
      throw new Error("IPC from untrusted origin rejected");
    }
    return {};
  };
}

function createWindow(): BrowserWindow {
  // Test harnesses (scripts/audit.sh) pin an explicit window size so
  // screenshots have identical geometry everywhere: CI runners' virtual
  // display is smaller than the 1280×800 default and macOS silently
  // clamps the window to the visible area, which fails every pixel
  // baseline on dimensions alone.
  const sizeOverride = /^(\d+)x(\d+)$/.exec(process.env["LLAMACTL_WINDOW_SIZE"] ?? "");
  const win = new BrowserWindow({
    width: sizeOverride ? Number(sizeOverride[1]) : 1280,
    height: sizeOverride ? Number(sizeOverride[2]) : 800,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: "#0b0f14",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const router = buildDispatcherRouter() as unknown as IPCHandlerOptions["router"];

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  // In prod the renderer loads from file://, so any file: frame is trusted.
  const trustedUrl = devUrl ?? "file://";

  createIPCHandler({
    router,
    windows: [win],
    createContext: makeIpcCreateContext(trustedUrl) as IPCHandlerOptions["createContext"],
  });

  // Prevent the renderer from navigating to untrusted URLs. This fires
  // for script- or user-initiated in-page navigations; it does NOT fire
  // for programmatic loadURL / loadFile calls from the main process.
  win.webContents.on("will-navigate", (e, url) => {
    if (!isTrustedRendererOrigin(url, trustedUrl)) {
      e.preventDefault();
    }
  });

  // Deny all new-window opens; external links must go through
  // shell.openExternal in a dedicated handler if needed.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  if (devUrl) {
    void win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}

void app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Keep import reachable for tree-shaking.
void ipcMain;
