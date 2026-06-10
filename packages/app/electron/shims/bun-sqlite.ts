// Electron-main stand-in for the `bun:sqlite` builtin.
//
// Bundled workspace code (core's kvstore/responsecache storage, pulled in
// via @llamactl/remote → openaiProxy) imports `bun:sqlite` at module
// scope but only constructs a Database inside factory functions that the
// Electron process never calls — sqlite-backed stores run in the Bun
// daemon. Externalizing the module instead (as 847990d did) makes Rollup
// emit an eager top-level `require("bun:sqlite")` in the CJS bundle,
// which Electron's Node main cannot resolve: the app throws during load,
// no window is created, and Playwright's electron_launch handshake hangs
// forever waiting for `DevTools listening`.
//
// Aliasing the import here keeps the bundle self-contained: loading the
// shim is harmless; actually constructing a Database throws loudly.
export class Database {
  readonly unavailable = true;

  constructor() {
    throw new Error(
      "bun:sqlite is unavailable in the Electron process; " +
        "sqlite-backed stores must run in the Bun daemon",
    );
  }
}

export default Database;
