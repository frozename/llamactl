// Electron-main stand-in for the `bun` builtin (see ./bun-sqlite.ts for
// the full story). The only API the bundled graph reaches is `spawn`
// (eval's bench server, behind code paths the Electron process never
// calls). Named imports of anything else from 'bun' fail the build
// loudly — add the missing throwing stub here if that ever happens.
export function spawn(): never {
  throw new Error(
    "Bun.spawn is unavailable in the Electron process; " +
      "Bun-only code paths must run in the Bun daemon",
  );
}

export type Subprocess = never;
