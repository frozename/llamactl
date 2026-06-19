import type { DependencyList } from "react";

import { describe, expect, mock, test } from "bun:test";

import type { CompositeShape } from "../src/modules/composites/types";

const ReactActual = await import("react");
const ReactQueryActual = await import("@tanstack/react-query");
const UiActual = await import("../src/ui/index");

globalThis.electronTRPC ??= {
  sendMessage: (): undefined => undefined,
  onMessage: (): undefined => undefined,
};

const TrpcActual = await import("../src/lib/trpc");

let hookHarnessActive = false;

interface TestElement {
  type: unknown;
  props?: {
    children?: unknown;
    value?: string;
    onChange?: (event: { target: { value: string } }) => void;
  };
}

let stateCursor = 0;
let refCursor = 0;
let effectCursor = 0;
const states: unknown[] = [];
const refs: { current: unknown }[] = [];
const effectDeps: unknown[][] = [];

function resetHookCursors(): void {
  stateCursor = 0;
  refCursor = 0;
  effectCursor = 0;
}

function useStateMock<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
  if (!hookHarnessActive) return ReactActual.useState(initial);
  const i = stateCursor++;
  if (!(i in states)) states[i] = typeof initial === "function" ? (initial as () => T)() : initial;
  return [
    states[i] as T,
    (next): void => {
      states[i] = typeof next === "function" ? (next as (prev: T) => T)(states[i] as T) : next;
    },
  ];
}

function useRefMock<T>(initial: T): { current: T } {
  if (!hookHarnessActive) return ReactActual.useRef(initial);
  const i = refCursor++;
  if (!(i in refs)) refs[i] = { current: initial };
  return refs[i] as { current: T };
}

function depsChanged(prev: unknown[] | undefined, next: unknown[]): boolean {
  if (!prev) return true;
  if (prev.length !== next.length) return true;
  return next.some((dep, i) => dep !== prev[i]);
}

function useEffectMock(effect: () => void, deps: unknown[]): void {
  if (!hookHarnessActive) {
    ReactActual.useEffect(effect, deps);
    return;
  }
  const i = effectCursor++;
  if (!depsChanged(effectDeps[i], deps)) return;
  effectDeps[i] = deps;
  effect();
}

function useMemoMock<T>(factory: () => T, deps?: DependencyList): T {
  if (!hookHarnessActive) return ReactActual.useMemo(factory, deps);
  return factory();
}

void mock.module("react", () => ({
  ...ReactActual,
  default: {
    ...ReactActual.default,
    useEffect: useEffectMock,
    useMemo: useMemoMock,
    useRef: useRefMock,
    useState: useStateMock,
  },
  useEffect: useEffectMock,
  useMemo: useMemoMock,
  useRef: useRefMock,
  useState: useStateMock,
}));

function useQueryClientMock(): unknown {
  if (hookHarnessActive) {
    return {
      invalidateQueries: (): undefined => undefined,
    };
  }
  return ReactQueryActual.useQueryClient();
}

void mock.module("@tanstack/react-query", () => ({
  ...ReactQueryActual,
  useQueryClient: useQueryClientMock,
}));

void mock.module("@/ui", () => UiActual);

let existingData: CompositeShape | undefined;

function compositeApplyUseMutationMock(): {
  isPending: false;
  mutateAsync: () => Promise<{ dryRun: true }>;
} {
  return {
    isPending: false,
    mutateAsync: () => Promise.resolve({ dryRun: true }),
  };
}

function compositeGetUseQueryMock(): { data: CompositeShape | undefined } {
  return { data: existingData };
}

function trpcUseUtilsMock(): { compositeList: { invalidate: () => undefined } } {
  return {
    compositeList: {
      invalidate: (): undefined => undefined,
    },
  };
}

const trpcHarnessOverrides: Record<PropertyKey, unknown> = {
  compositeApply: {
    useMutation: compositeApplyUseMutationMock,
  },
  compositeGet: {
    useQuery: compositeGetUseQueryMock,
  },
  useUtils: trpcUseUtilsMock,
};

const trpcProxy = new Proxy(TrpcActual.trpc, {
  get(target, prop, receiver): unknown {
    if (hookHarnessActive && prop in trpcHarnessOverrides) {
      return trpcHarnessOverrides[prop];
    }
    return Reflect.get(target, prop, receiver) as unknown;
  },
});

void mock.module("@/lib/trpc", () => ({
  ...TrpcActual,
  trpc: trpcProxy,
}));

function manifest(name: string, labels?: Record<string, string>): CompositeShape {
  return {
    apiVersion: "llamactl/v1",
    kind: "Composite",
    metadata: labels ? { name, labels } : { name },
    spec: {
      services: [],
      workloads: [],
      ragNodes: [],
      gateways: [],
      dependencies: [],
      onFailure: "rollback",
    },
  };
}

function findTextarea(node: unknown): TestElement {
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as TestElement | null | undefined;
    if (!current || typeof current !== "object") continue;
    if (current.type === "textarea") return current;
    const children = current.props?.children;
    if (Array.isArray(children)) {
      for (const child of children as unknown[]) stack.push(child);
    } else if (children) {
      stack.push(children);
    }
  }
  throw new Error("textarea not found");
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
}

describe("ApplyTab edit seeding", () => {
  test("does not overwrite in-progress yaml edits after an edit-mode refetch", async () => {
    const { ApplyTab } = await import("../src/modules/composites/apply-tab");

    hookHarnessActive = true;
    states.length = 0;
    refs.length = 0;
    effectDeps.length = 0;

    try {
      existingData = manifest("from-initial-load");
      resetHookCursors();
      ApplyTab({
        selectedName: "from-initial-load",
        onSelect: () => undefined,
        onApplied: () => undefined,
      });
      await flushMicrotasks();

      resetHookCursors();
      let textarea = findTextarea(
        ApplyTab({
          selectedName: "from-initial-load",
          onSelect: () => undefined,
          onApplied: () => undefined,
        }),
      );
      expect(textarea.props?.value).toContain("name: from-initial-load");

      const editedYaml = "apiVersion: llamactl/v1\nkind: Composite\nmetadata:\n  name: edited";
      textarea.props?.onChange?.({ target: { value: editedYaml } });

      resetHookCursors();
      textarea = findTextarea(
        ApplyTab({
          selectedName: "from-initial-load",
          onSelect: () => undefined,
          onApplied: () => undefined,
        }),
      );
      expect(textarea.props?.value).toBe(editedYaml);

      existingData = manifest("from-initial-load", { source: "background-refetch" });
      resetHookCursors();
      ApplyTab({
        selectedName: "from-initial-load",
        onSelect: () => undefined,
        onApplied: () => undefined,
      });
      await flushMicrotasks();

      resetHookCursors();
      textarea = findTextarea(
        ApplyTab({
          selectedName: "from-initial-load",
          onSelect: () => undefined,
          onApplied: () => undefined,
        }),
      );
      expect(textarea.props?.value).toBe(editedYaml);
    } finally {
      hookHarnessActive = false;
    }
  });
});
