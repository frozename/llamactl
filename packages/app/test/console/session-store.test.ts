// packages/app/test/console/session-store.test.ts
// Issue #410, P4 RED — pins the console invalid-session store. A 401
// `invalid_session` anywhere in the transport marks the store once;
// the shell renders INVALID_SESSION_MESSAGE while it is set. The
// module does not exist at the base commit, so every case fails by
// assertion through the import-catch pattern — never by import error.

import { afterEach, describe, expect, test } from "bun:test";

const STORE_SPEC = "../../src/console/session-store.ts";

interface SessionStore {
  isInvalid: () => boolean;
  markInvalid: () => void;
  reset: () => void;
  subscribe: (listener: () => void) => () => void;
}

interface SessionStoreModule {
  createSessionStore?: () => SessionStore;
  consoleSessionStore?: SessionStore;
  INVALID_SESSION_MESSAGE?: string;
}

async function importStore(): Promise<SessionStoreModule | null> {
  return (await import(STORE_SPEC).catch(() => null)) as SessionStoreModule | null;
}

afterEach(async () => {
  const mod = await importStore();
  mod?.consoleSessionStore?.reset();
});

describe("session store (#410 P4)", () => {
  test("createSessionStore() starts valid", async () => {
    const mod = await importStore();
    expect(mod?.createSessionStore).toBeFunction();

    const store = mod!.createSessionStore!();
    expect(store.isInvalid()).toBe(false);
  });

  test("markInvalid() flags the store and notifies each subscriber exactly once, even when called twice", async () => {
    const mod = await importStore();
    expect(mod?.createSessionStore).toBeFunction();

    const store = mod!.createSessionStore!();
    const callsA: number[] = [];
    const callsB: number[] = [];
    store.subscribe(() => callsA.push(1));
    store.subscribe(() => callsB.push(1));

    store.markInvalid();
    store.markInvalid();

    expect(store.isInvalid()).toBe(true);
    expect(callsA).toHaveLength(1);
    expect(callsB).toHaveLength(1);
  });

  test("the unsubscribe returned by subscribe() stops notifications", async () => {
    const mod = await importStore();
    expect(mod?.createSessionStore).toBeFunction();

    const store = mod!.createSessionStore!();
    const calls: number[] = [];
    const unsubscribe = store.subscribe(() => calls.push(1));

    store.markInvalid();
    unsubscribe();
    store.reset();
    store.markInvalid();

    expect(calls).toHaveLength(1);
  });

  test("reset() makes the store valid again", async () => {
    const mod = await importStore();
    expect(mod?.createSessionStore).toBeFunction();

    const store = mod!.createSessionStore!();
    store.markInvalid();
    expect(store.isInvalid()).toBe(true);

    store.reset();
    expect(store.isInvalid()).toBe(false);
  });

  test("exports the banner copy", async () => {
    const mod = await importStore();
    expect(mod?.INVALID_SESSION_MESSAGE).toBe("Console restarted or session expired — reload");
  });

  test("exports a consoleSessionStore singleton", async () => {
    const mod = await importStore();
    const store = mod?.consoleSessionStore;
    expect(store?.isInvalid).toBeFunction();
    expect(store?.markInvalid).toBeFunction();
    expect(store?.reset).toBeFunction();
    expect(store?.subscribe).toBeFunction();
    store?.reset();
  });
});
