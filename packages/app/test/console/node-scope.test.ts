// packages/app/test/console/node-scope.test.ts
// Issue #410, P3 RED 8 — pins the client-side tab-scoped node store.
// Resolution order: ?node= (dispatchable) → sessionStorage (dispatchable)
// → nodeList.defaultNode (dispatchable) → "local". Names must satisfy
// the same segment rule the server enforces; gateway, provider and RAG
// nodes are never dispatchable and never offered. The store is keyed
// per tab through an injected Storage — never localStorage.

import { CONSOLE_NODE_SEGMENT } from "@llamactl/remote";
import { afterEach, describe, expect, test } from "bun:test";

const NODE_SCOPE_SPEC = "../../src/console/node-scope.ts";

interface NodeEntry {
  name: string;
  endpoint?: string;
  effectiveKind?: string;
}

interface NodeListFixture {
  defaultNode: string;
  nodes: NodeEntry[];
}

interface StorageLike {
  readonly length: number;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
  key: (index: number) => string | null;
}

interface TabNodeRejection {
  from: "url" | "storage";
  reason: "invalid_name" | "not_dispatchable";
  value?: string;
}

interface TabNodeResolution {
  node: string;
  source: "url" | "storage" | "default" | "local";
  provisional?: boolean;
  rejected?: TabNodeRejection;
}

interface TabNodeStore {
  resolve: (nodeList: NodeListFixture | null) => TabNodeResolution;
  set: (name: string) => void;
}

interface NodeScopeModule {
  CONSOLE_NODE_NAME?: RegExp;
  TAB_NODE_STORAGE_KEY?: string;
  createTabNodeStore?: () => TabNodeStore;
  dispatchableNodes?: (nodeList: NodeListFixture) => NodeEntry[];
  isConsoleNodeName?: (name: string) => boolean;
  persistTabNode?: (storage: StorageLike, name: string) => void;
  resolveTabNode?: (opts: {
    search: string;
    storage: StorageLike;
    nodeList: NodeListFixture | null;
  }) => TabNodeResolution;
}

class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
}

class RecordingStorage extends MemoryStorage {
  accesses = 0;
  readonly setCalls: [string, string][] = [];

  override get length(): number {
    this.accesses += 1;
    return super.length;
  }

  override getItem(key: string): string | null {
    this.accesses += 1;
    return super.getItem(key);
  }

  override setItem(key: string, value: string): void {
    this.accesses += 1;
    this.setCalls.push([key, value]);
    super.setItem(key, value);
  }

  override removeItem(key: string): void {
    this.accesses += 1;
    super.removeItem(key);
  }

  override clear(): void {
    this.accesses += 1;
    super.clear();
  }

  override key(index: number): string | null {
    this.accesses += 1;
    return super.key(index);
  }
}

function makeNodeList(defaultNode = "remote1"): NodeListFixture {
  return {
    defaultNode,
    nodes: [
      { name: "local", endpoint: "inproc://local", effectiveKind: "agent" },
      { name: "remote1", endpoint: "https://127.0.0.1:19", effectiveKind: "agent" },
      { name: "gw1", effectiveKind: "gateway" },
      { name: "gw1.openai", effectiveKind: "provider" },
      { name: "ragdb", effectiveKind: "rag" },
    ],
  };
}

async function importNodeScope(): Promise<NodeScopeModule | null> {
  return (await import(NODE_SCOPE_SPEC).catch(() => null)) as NodeScopeModule | null;
}

const GLOBAL_KEYS = ["localStorage", "sessionStorage", "location"] as const;
const savedGlobalDescriptors = new Map<string, PropertyDescriptor | undefined>();

afterEach(() => {
  for (const key of GLOBAL_KEYS) {
    if (!savedGlobalDescriptors.has(key)) continue;
    const descriptor = savedGlobalDescriptors.get(key);
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
    savedGlobalDescriptors.delete(key);
  }
});

describe("console tab node scope (#410 P3)", () => {
  test("exposes the tab-scoped storage key", async () => {
    const mod = await importNodeScope();
    expect(mod?.TAB_NODE_STORAGE_KEY).toBe("llamactl-console-node");
  });

  test("uses the same node-name rule as the server", async () => {
    const mod = await importNodeScope();
    expect(mod?.CONSOLE_NODE_NAME?.source).toBe(CONSOLE_NODE_SEGMENT.source);
  });

  test("two tabs keep independent nodes in separate storage instances", async () => {
    const mod = await importNodeScope();
    expect(mod?.persistTabNode).toBeFunction();
    expect(mod?.resolveTabNode).toBeFunction();
    const key = mod!.TAB_NODE_STORAGE_KEY!;
    const tabA = new MemoryStorage();
    const tabB = new MemoryStorage();
    const nodeList = makeNodeList();

    mod!.persistTabNode!(tabA, "remote1");
    mod!.persistTabNode!(tabB, "local");

    expect(mod!.resolveTabNode!({ search: "", storage: tabA, nodeList }).node).toBe("remote1");
    expect(mod!.resolveTabNode!({ search: "", storage: tabB, nodeList }).node).toBe("local");
    expect(tabA.getItem(key)).toBe("remote1");
    expect(tabB.getItem(key)).toBe("local");
  });

  test("?node= overrides the stored value", async () => {
    const mod = await importNodeScope();
    expect(mod?.resolveTabNode).toBeFunction();
    const storage = new MemoryStorage();
    storage.setItem("llamactl-console-node", "local");

    const resolved = mod!.resolveTabNode!({
      search: "?node=remote1",
      storage,
      nodeList: makeNodeList(),
    });

    expect(resolved).toMatchObject({ node: "remote1", source: "url" });
  });

  test("?node= values that fail the name rule are rejected and fall back", async () => {
    const mod = await importNodeScope();
    expect(mod?.resolveTabNode).toBeFunction();
    const stored = new MemoryStorage();
    stored.setItem("llamactl-console-node", "remote1");
    const nodeList = makeNodeList();

    for (const search of ["?node=a%2Fb", "?node=..%2Fx"]) {
      const withStored = mod!.resolveTabNode!({ search, storage: stored, nodeList });
      expect(withStored.rejected).toMatchObject({ from: "url", reason: "invalid_name" });
      expect(withStored).toMatchObject({ node: "remote1", source: "storage" });

      const empty = mod!.resolveTabNode!({ search, storage: new MemoryStorage(), nodeList });
      expect(empty.rejected).toMatchObject({ from: "url", reason: "invalid_name" });
      expect(empty).toMatchObject({ node: "remote1", source: "default" });
    }
  });

  test("gateway, provider and rag names are rejected as not dispatchable", async () => {
    const mod = await importNodeScope();
    expect(mod?.resolveTabNode).toBeFunction();
    const nodeList = makeNodeList();

    for (const name of ["gw1", "gw1.openai"]) {
      const resolved = mod!.resolveTabNode!({
        search: `?node=${name}`,
        storage: new MemoryStorage(),
        nodeList,
      });
      expect(resolved.rejected).toMatchObject({ from: "url", reason: "not_dispatchable" });
      expect(resolved).toMatchObject({ node: "remote1", source: "default" });
    }

    const stored = new MemoryStorage();
    stored.setItem("llamactl-console-node", "ragdb");
    const fromStorage = mod!.resolveTabNode!({ search: "", storage: stored, nodeList });
    expect(fromStorage.rejected).toMatchObject({ from: "storage", reason: "not_dispatchable" });
    expect(fromStorage).toMatchObject({ node: "remote1", source: "default" });
  });

  test("dispatchableNodes lists only agent-capable nodes", async () => {
    const mod = await importNodeScope();
    expect(mod?.dispatchableNodes).toBeFunction();

    expect(mod!.dispatchableNodes!(makeNodeList()).map((n) => n.name)).toEqual([
      "local",
      "remote1",
    ]);

    // Matches the server's P3.3b: an inproc://local endpoint stays
    // dispatchable regardless of the declared effectiveKind.
    const gatewayLocal: NodeListFixture = {
      defaultNode: "local",
      nodes: [{ name: "local", endpoint: "inproc://local", effectiveKind: "gateway" }],
    };
    expect(mod!.dispatchableNodes!(gatewayLocal).map((n) => n.name)).toEqual(["local"]);
  });

  test("defaults: dispatchable defaultNode wins, otherwise local; no list means local", async () => {
    const mod = await importNodeScope();
    expect(mod?.resolveTabNode).toBeFunction();
    const storage = new MemoryStorage();

    expect(
      mod!.resolveTabNode!({ search: "", storage, nodeList: makeNodeList("remote1") }),
    ).toMatchObject({ node: "remote1", source: "default" });
    expect(
      mod!.resolveTabNode!({ search: "", storage, nodeList: makeNodeList("gw1") }),
    ).toMatchObject({ node: "local", source: "local" });
    expect(mod!.resolveTabNode!({ search: "", storage, nodeList: null })).toMatchObject({
      node: "local",
      source: "local",
    });
  });

  test("before nodeList loads, name-valid candidates resolve as provisional", async () => {
    const mod = await importNodeScope();
    expect(mod?.resolveTabNode).toBeFunction();

    const fromUrl = mod!.resolveTabNode!({
      search: "?node=gw1",
      storage: new MemoryStorage(),
      nodeList: null,
    });
    expect(fromUrl).toMatchObject({ node: "gw1", source: "url", provisional: true });

    const stored = new MemoryStorage();
    stored.setItem("llamactl-console-node", "gw1");
    const fromStorage = mod!.resolveTabNode!({ search: "", storage: stored, nodeList: null });
    expect(fromStorage).toMatchObject({ node: "gw1", source: "storage", provisional: true });

    const checked = mod!.resolveTabNode!({
      search: "?node=gw1",
      storage: new MemoryStorage(),
      nodeList: makeNodeList(),
    });
    expect(checked.rejected).toMatchObject({ from: "url", reason: "not_dispatchable" });
    expect(checked.node).not.toBe("gw1");
  });

  test("persistTabNode refuses names outside the segment rule", async () => {
    const mod = await importNodeScope();
    expect(mod?.persistTabNode).toBeFunction();
    const storage = new MemoryStorage();

    expect(() => {
      mod!.persistTabNode!(storage, "a/b");
    }).toThrow();
    expect(storage.length).toBe(0);
  });

  test("createTabNodeStore reads globals but never touches localStorage", async () => {
    const mod = await importNodeScope();
    expect(mod?.createTabNodeStore).toBeFunction();

    const local = new RecordingStorage();
    const session = new RecordingStorage();
    for (const key of GLOBAL_KEYS) {
      savedGlobalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: session });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { search: "?node=remote1" },
    });

    const store = mod!.createTabNodeStore!();

    expect(store.resolve(makeNodeList()).node).toBe("remote1");
    store.set("local");

    expect(local.accesses).toBe(0);
    expect(session.setCalls).toEqual([["llamactl-console-node", "local"]]);
  });
});
