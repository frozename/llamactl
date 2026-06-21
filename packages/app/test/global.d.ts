// Ambient global augmentation for the app test suite.
//
// Several tests stub the Electron preload bridge by assigning to
// `globalThis.electronTRPC` directly. Under strict typecheck
// (noPropertyAccessFromIndexSignature) `globalThis` has no index
// signature, so the bare property access errors. Declaring the optional
// global here gives every test file the property without per-call casts.
//
// The members are optional because tests stub partial bridges (e.g.
// `onMessage` only); the runtime consumer (`src/lib/ipc-link.ts`)
// null-checks before use.

declare global {
  var electronTRPC:
    | {
        sendMessage?: (msg: unknown) => void;
        onMessage?: (cb: (msg: unknown) => void) => void;
      }
    | undefined;
}

export {};
