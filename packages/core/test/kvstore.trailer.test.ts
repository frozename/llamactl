import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EXT_FLAG_SESSION_TITLE,
  EXT_FLAG_TOOL_MAP,
  type KvTrailer,
  readTrailer,
  writeTrailer,
} from "../src/kvstore/index.js";
import { openKvStorage } from "../src/kvstore/storage.js";

function makeTempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "llamactl-kvstore-trailer-"));
  return {
    root,
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("writeTrailer/readTrailer round-trip", () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, "slots", "wl-a", "abc.kvslot");
    const trailer: KvTrailer = {
      extFlags: EXT_FLAG_TOOL_MAP | EXT_FLAG_SESSION_TITLE,
      toolMap: {
        toolu_1:
          '{"id":"toolu_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":\\"abc\\"}"}}',
      },
      sessionTitle: "hello world",
    };
    const wrote = writeTrailer(slotFile, trailer);
    expect(wrote).toEqual({ ok: true });
    expect(readTrailer(slotFile)).toEqual(trailer);
  } finally {
    t.cleanup();
  }
});

test("readTrailer returns null for missing trailer file", () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, "slots", "wl-a", "missing.kvslot");
    expect(readTrailer(slotFile)).toBeNull();
  } finally {
    t.cleanup();
  }
});

test("atomic write leaves previous trailer intact when rename fails", () => {
  const t = makeTempRoot();
  let restoreRename = (): undefined => undefined;
  try {
    const slotFile = join(t.root, "slots", "wl-a", "stable.kvslot");
    const baseline: KvTrailer = {
      extFlags: EXT_FLAG_SESSION_TITLE,
      sessionTitle: "baseline",
    };
    expect(writeTrailer(slotFile, baseline)).toEqual({ ok: true });
    const renameSpy = spyOn(fs, "renameSync").mockImplementation(() => {
      const err = new Error("rename blocked");
      throw err;
    });
    restoreRename = (): undefined => {
      renameSpy.mockRestore();
    };

    const replace: KvTrailer = {
      extFlags: EXT_FLAG_TOOL_MAP,
      toolMap: { toolu_2: '{"id":"toolu_2"}' },
    };
    const wrote = writeTrailer(slotFile, replace);
    expect(wrote.ok).toBe(false);
    if (!wrote.ok) expect(wrote.reason).toBe("other");

    expect(readTrailer(slotFile)).toEqual(baseline);
  } finally {
    restoreRename();
    t.cleanup();
  }
});

test("writeTrailer returns enospc and increments storage write-fail counter", () => {
  const t = makeTempRoot();
  const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(() => {
    const err = new Error("disk full") as Error & { code?: string };
    err.code = "ENOSPC";
    throw err;
  });
  try {
    const storage = openKvStorage(t.root);
    const slotFile = join(t.root, "slots", "wl-a", "diskfull.kvslot");
    const trailer: KvTrailer = { extFlags: EXT_FLAG_SESSION_TITLE, sessionTitle: "x" };
    const wrote = writeTrailer(slotFile, trailer, storage);
    expect(wrote.ok).toBe(false);
    if (!wrote.ok) expect(wrote.reason).toBe("enospc");
    expect(storage.registry_write_fail_total).toBe(1);
    storage.close();
  } finally {
    writeSpy.mockRestore();
    t.cleanup();
  }
});

test("readTrailer returns null (not throws) for corrupt/truncated trailer", () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, "slots", "wl-a", "corrupt.kvslot");
    const trailerFile = `${slotFile}.trailer.json`;
    fs.mkdirSync(join(t.root, "slots", "wl-a"), { recursive: true });
    fs.writeFileSync(trailerFile, "{not json");
    expect(readTrailer(slotFile)).toBeNull();
  } finally {
    t.cleanup();
  }
});

test("readTrailer returns null when extFlags is missing or not a number", () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, "slots", "wl-a", "badflags.kvslot");
    const trailerFile = `${slotFile}.trailer.json`;
    fs.mkdirSync(join(t.root, "slots", "wl-a"), { recursive: true });
    fs.writeFileSync(trailerFile, JSON.stringify({ sessionTitle: "x" }));
    expect(readTrailer(slotFile)).toBeNull();
    fs.writeFileSync(trailerFile, JSON.stringify({ extFlags: "1" }));
    expect(readTrailer(slotFile)).toBeNull();
  } finally {
    t.cleanup();
  }
});

test("readTrailer returns null when toolMap has a non-string value", () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, "slots", "wl-a", "badmap.kvslot");
    const trailerFile = `${slotFile}.trailer.json`;
    fs.mkdirSync(join(t.root, "slots", "wl-a"), { recursive: true });
    fs.writeFileSync(trailerFile, JSON.stringify({ extFlags: 1, toolMap: { toolu_1: 42 } }));
    expect(readTrailer(slotFile)).toBeNull();
  } finally {
    t.cleanup();
  }
});

test("ext flag bit operations are additive and independent", () => {
  const combined = EXT_FLAG_TOOL_MAP | EXT_FLAG_SESSION_TITLE;
  expect((combined & EXT_FLAG_TOOL_MAP) !== 0).toBe(true);
  expect((combined & EXT_FLAG_SESSION_TITLE) !== 0).toBe(true);
});
