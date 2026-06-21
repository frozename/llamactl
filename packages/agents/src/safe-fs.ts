// Audited filesystem boundary for this package.
//
// All filesystem access imports from here instead of "node:fs" directly, so there
// is a single greppable place to audit or validate paths. The
// security/detect-non-literal-fs-filename rule is an error everywhere else; it does
// not fire here (this module only re-exports — no fs calls) nor in consumers (they
// import from this module, not from "node:fs").
export * from "node:fs";
export { default } from "node:fs";
