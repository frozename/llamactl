import { app, BrowserWindow, ipcMain } from 'electron';
import { createIPCHandler } from 'electron-trpc/main';
import { join } from 'node:path';
import { buildDispatcherRouter } from './trpc/dispatcher.js';

// `__dirname` is set by Rollup's CJS wrapper, so we don't need the
// ESM-style `fileURLToPath(import.meta.url)` dance here.
declare const __dirname: string;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: '#0b0f14',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // The dispatcher wraps the base router so its getErrorShape type
  // erasure flows through; electron-trpc's AnyRouter constraint is
  // satisfied structurally at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createIPCHandler({ router: buildDispatcherRouter() as any, windows: [win] });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Keep import reachable for tree-shaking.
void ipcMain;
