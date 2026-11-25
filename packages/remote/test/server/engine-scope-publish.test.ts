// #806 phase 3 (T14): the agent publishes the engine-scope launcher only when
// the CLI opted in AND the platform is linux; restore puts the previous seam
// value back so tests and in-process applies never see a leaked launcher.

import { afterEach, expect, test } from "bun:test";

import {
  type EngineScopeLauncher,
  getEngineScopeLauncher,
  setEngineScopeLauncher,
} from "../../../core/src/engines/scope.js";
import { maybePublishEngineScope } from "../../src/server/serve.js";

afterEach(() => {
  setEngineScopeLauncher(null);
});

test("maybePublishEngineScope returns null without opt-in or off linux", () => {
  expect(maybePublishEngineScope({}, "linux")).toBeNull();
  expect(maybePublishEngineScope({ engineScope: true }, "darwin")).toBeNull();
  expect(maybePublishEngineScope({}, "darwin")).toBeNull();
});

test("maybePublishEngineScope publishes and restores the launcher seam", () => {
  const handle = maybePublishEngineScope({ engineScope: true }, "linux");
  if (handle === null) throw new Error("expected an engine-scope handle on linux");
  expect(getEngineScopeLauncher()).toBeNull();
  handle.publish();
  const published = getEngineScopeLauncher();
  expect(published).not.toBeNull();
  expect(typeof published?.resolve).toBe("function");
  handle.restore();
  expect(getEngineScopeLauncher()).toBeNull();
});

test("maybePublishEngineScope restore returns a previously installed launcher", () => {
  const sentinel: EngineScopeLauncher = {
    establishTimeoutMs: 1,
    unitSuffix: (): string => "0123456789ab",
    noteFailure: (): void => undefined,
    resolve: () => Promise.resolve({ ok: false, reason: "not-linux" }),
  };
  setEngineScopeLauncher(sentinel);
  const handle = maybePublishEngineScope({ engineScope: true }, "linux");
  if (handle === null) throw new Error("expected an engine-scope handle on linux");
  handle.publish();
  expect(getEngineScopeLauncher()).not.toBe(sentinel);
  handle.restore();
  expect(getEngineScopeLauncher()).toBe(sentinel);
});
