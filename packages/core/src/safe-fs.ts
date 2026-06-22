// Audited filesystem boundary for @llamactl/core.
//
// All filesystem access in this package imports from here instead of "node:fs"
// directly, so there is a single, greppable place to audit or validate paths.
// `security/detect-non-literal-fs-filename` is an error everywhere else; it does
// not fire here because this module only re-exports (no fs calls) and consumers
// import from this module, not from "node:fs".
import * as nodeFs from "node:fs";

// `export * from "node:fs"` is mistransformed by `bun build --compile` (it emits an
// unbound `__reExport(exports, node_fs)` and the agent binary crashes at startup with
// "ReferenceError: node_fs is not defined"). Importing the namespace into a local
// binding and re-exporting it explicitly is compile-safe and preserves the public
// surface (the same named fs exports + the default export) for interpreted runs too.
export default nodeFs;

export type { WriteStream } from "node:fs";

export const {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  unwatchFile,
  utimesSync,
  watchFile,
  writeFileSync,
  writeSync,
} = nodeFs;
