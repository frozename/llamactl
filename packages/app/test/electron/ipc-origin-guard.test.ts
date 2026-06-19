import { describe, expect, mock, test } from "bun:test";

// mock.module() must be called before the import of the module under test.
// Electron and electron-trpc/main are native Electron modules that can't
// load in Bun; replace them with minimal stubs so main.ts initialises.
void mock.module("electron", () => ({
  app: {
    // Never-resolving promise keeps createWindow() from running in tests.
    whenReady: (): Promise<void> => new Promise<void>(() => undefined),
    on: (): void => undefined,
    quit: (): void => undefined,
  },
  BrowserWindow: class {
    webContents = {
      on: (): void => undefined,
      setWindowOpenHandler: (): void => undefined,
      openDevTools: (): void => undefined,
    };
    loadURL(): Promise<void> {
      return Promise.resolve();
    }
    loadFile(): Promise<void> {
      return Promise.resolve();
    }
    static getAllWindows(): unknown[] {
      return [];
    }
  },
  ipcMain: {},
}));

void mock.module("electron-trpc/main", () => ({
  createIPCHandler: (): object => ({}),
}));

const { isTrustedRendererOrigin, makeIpcCreateContext } = await import(
  "../../electron/main.js"
);

describe("isTrustedRendererOrigin", () => {
  describe("dev mode (http origin)", () => {
    const trusted = "http://localhost:5173";

    test("accepts matching origin", () => {
      expect(isTrustedRendererOrigin("http://localhost:5173/", trusted)).toBe(true);
    });

    test("accepts matching origin with path", () => {
      expect(isTrustedRendererOrigin("http://localhost:5173/some/route", trusted)).toBe(true);
    });

    test("rejects different host", () => {
      expect(isTrustedRendererOrigin("http://evil.example/", trusted)).toBe(false);
    });

    test("rejects different port", () => {
      expect(isTrustedRendererOrigin("http://localhost:9999/", trusted)).toBe(false);
    });

    test("rejects https:// when trusted is http://", () => {
      expect(isTrustedRendererOrigin("https://localhost:5173/", trusted)).toBe(false);
    });
  });

  describe("prod mode (file: origin)", () => {
    const trusted = "file://";

    test("accepts file: URL", () => {
      expect(
        isTrustedRendererOrigin("file:///app/renderer/index.html", trusted),
      ).toBe(true);
    });

    test("rejects http: URL", () => {
      expect(isTrustedRendererOrigin("http://evil.example/", trusted)).toBe(false);
    });
  });

  describe("edge cases", () => {
    test("rejects empty frameUrl", () => {
      expect(isTrustedRendererOrigin("", "http://localhost:5173")).toBe(false);
    });

    test("rejects non-URL string", () => {
      expect(isTrustedRendererOrigin("not-a-url", "http://localhost:5173")).toBe(
        false,
      );
    });
  });
});

describe("makeIpcCreateContext", () => {
  describe("dev mode (http trusted URL)", () => {
    const trusted = "http://localhost:5173";

    test("returns context for trusted origin", () => {
      const ctx = makeIpcCreateContext(trusted);
      const result = ctx({ event: { senderFrame: { url: "http://localhost:5173/" } } });
      expect(result).toEqual({});
    });

    test("throws for untrusted origin — the IPC origin bug", () => {
      const ctx = makeIpcCreateContext(trusted);
      expect(() =>
        ctx({ event: { senderFrame: { url: "http://attacker.example/" } } }),
      ).toThrow("IPC from untrusted origin rejected");
    });

    test("throws when senderFrame is null", () => {
      const ctx = makeIpcCreateContext(trusted);
      expect(() => ctx({ event: { senderFrame: null } })).toThrow();
    });

    test("throws when senderFrame url is empty", () => {
      const ctx = makeIpcCreateContext(trusted);
      expect(() => ctx({ event: { senderFrame: { url: "" } } })).toThrow();
    });
  });

  describe("prod mode (file: trusted URL)", () => {
    test("accepts file: origin", () => {
      const ctx = makeIpcCreateContext("file://");
      const result = ctx({
        event: { senderFrame: { url: "file:///path/to/renderer/index.html" } },
      });
      expect(result).toEqual({});
    });

    test("throws for http: origin", () => {
      const ctx = makeIpcCreateContext("file://");
      expect(() =>
        ctx({ event: { senderFrame: { url: "http://attacker.example/" } } }),
      ).toThrow("IPC from untrusted origin rejected");
    });
  });
});
