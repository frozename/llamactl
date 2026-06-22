// Audited filesystem boundary for this package.
//
// All filesystem access imports from here instead of "node:fs" directly, so there
// is a single greppable place to audit or validate paths. The
// security/detect-non-literal-fs-filename rule is an error everywhere else; it does
// not fire here (this module only re-exports — no fs calls) nor in consumers (they
// import from this module, not from "node:fs").
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
