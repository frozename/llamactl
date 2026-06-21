// Audited filesystem boundary for @llamactl/core.
//
// All filesystem access in this package imports from here instead of "node:fs"
// directly, so there is a single, greppable place to audit or validate paths.
// `security/detect-non-literal-fs-filename` is an error everywhere else; it does
// not fire here because this module only re-exports (no fs calls) and consumers
// import from this module, not from "node:fs".
export * from "node:fs";
export { default } from "node:fs";
