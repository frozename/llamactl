import type { DependencyList } from "react";

import { beforeEach, describe, expect, mock, test } from "bun:test";

const ReactActual = await import("react");
const UiActual = await import("../src/ui/index");

let hookHarnessActive = false;

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

function resetHookState(): void {
  states.length = 0;
  refs.length = 0;
  effectDeps.length = 0;
  resetHookCursors();
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

function useEffectMock(effect: () => void, deps?: DependencyList): void {
  if (!hookHarnessActive) {
    ReactActual.useEffect(effect, deps);
    return;
  }
  const i = effectCursor++;
  const nextDeps = deps ? [...deps] : [];
  if (!depsChanged(effectDeps[i], nextDeps)) return;
  effectDeps[i] = nextDeps;
  effect();
}

function useMemoMock<T>(factory: () => T, deps?: DependencyList): T {
  if (!hookHarnessActive) return ReactActual.useMemo(factory, deps);
  void deps;
  return factory();
}

function useCallbackMock<T extends (...args: never[]) => unknown>(
  callback: T,
  deps?: DependencyList,
): T {
  if (!hookHarnessActive) return ReactActual.useCallback(callback, deps);
  void deps;
  return callback;
}

function useDebugValueMock(value: unknown, formatter?: (value: unknown) => unknown): void {
  if (!hookHarnessActive) {
    ReactActual.useDebugValue(value, formatter);
  }
}

function useSyncExternalStoreMock<T>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
): T {
  if (!hookHarnessActive) {
    return ReactActual.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  }
  void subscribe;
  return getSnapshot();
}

void mock.module("react", () => ({
  ...ReactActual,
  default: {
    ...ReactActual.default,
    useEffect: useEffectMock,
    useCallback: useCallbackMock,
    useDebugValue: useDebugValueMock,
    useMemo: useMemoMock,
    useRef: useRefMock,
    useState: useStateMock,
    useSyncExternalStore: useSyncExternalStoreMock,
  },
  useEffect: useEffectMock,
  useCallback: useCallbackMock,
  useDebugValue: useDebugValueMock,
  useMemo: useMemoMock,
  useRef: useRefMock,
  useState: useStateMock,
  useSyncExternalStore: useSyncExternalStoreMock,
}));

interface SubscriptionRecord {
  input: {
    node: string;
    request: {
      model: string;
      messages: { role: string; content: string }[];
    };
    conversationId?: string;
  };
  options: {
    enabled?: boolean;
    onData?: (event: unknown) => void;
    onError?: (error: { message: string }) => void;
  };
}

const chatStreamSubscriptions: SubscriptionRecord[] = [];

interface NodeListQueryResult {
  data: {
    nodes: { name: string; effectiveKind?: string }[];
  };
  isLoading: false;
}

interface NodeModelsQueryResult {
  data: {
    models: { id: string }[];
  };
  isLoading: false;
}

interface RagSearchResult {
  results: {
    document: { id: string; content: string };
    score: number;
  }[];
}

interface TrpcUtilsMock {
  ragSearch: {
    fetch: () => Promise<RagSearchResult>;
  };
}

void mock.module("@/lib/trpc", () => ({
  trpc: {
    chatStream: {
      useSubscription: (
        input: SubscriptionRecord["input"],
        options: SubscriptionRecord["options"],
      ): Record<string, never> => {
        chatStreamSubscriptions.push({ input, options });
        return {};
      },
    },
    nodeList: {
      useQuery: (): NodeListQueryResult => ({
        data: {
          nodes: [{ name: "node-a" }, { name: "node-b" }, { name: "rag-a", effectiveKind: "rag" }],
        },
        isLoading: false,
      }),
    },
    nodeModels: {
      useQuery: (input: { name: string }): NodeModelsQueryResult => ({
        data: { models: [{ id: `${input.name}-model` }] },
        isLoading: false,
      }),
    },
    useUtils: (): TrpcUtilsMock => ({
      ragSearch: {
        fetch: (): Promise<RagSearchResult> =>
          Promise.resolve({
            results: [
              {
                document: { id: "doc-1", content: "retrieved context" },
                score: 0.9,
              },
            ],
          }),
      },
    }),
  },
}));

void mock.module("@/hooks/useActiveWorkload", () => ({
  useActiveWorkload: (): { workload: undefined } => ({ workload: undefined }),
}));

void mock.module("@/stores/tab-store", () => ({
  useTabStore: {
    getState: (): { open: () => undefined } => ({
      open: (): undefined => undefined,
    }),
  },
}));

void mock.module("@/ui", () => UiActual);

interface TestElement {
  type: unknown;
  props?: Record<string, unknown>;
}

type TestFunctionComponent = (props: Record<string, unknown>) => unknown;

function renderFunctionTree(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(renderFunctionTree);
  if (!node || typeof node !== "object") return node;

  const element = node as TestElement;
  if (typeof element.type === "function") {
    const component = element.type as TestFunctionComponent;
    return renderFunctionTree(component(element.props ?? {}));
  }

  const children = element.props?.["children"];
  return {
    ...element,
    props: {
      ...element.props,
      children: Array.isArray(children)
        ? children.map(renderFunctionTree)
        : children
          ? renderFunctionTree(children)
          : children,
    },
  };
}

function pushChildren(stack: unknown[], children: unknown): void {
  if (Array.isArray(children)) {
    for (const child of children) stack.push(child);
  } else if (children) {
    stack.push(children);
  }
}

function findElements(node: unknown, predicate: (element: TestElement) => boolean): TestElement[] {
  const matches: TestElement[] = [];
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const child of current) stack.push(child);
      continue;
    }
    if (!current || typeof current !== "object") continue;
    const element = current as TestElement;
    if (predicate(element)) matches.push(element);
    pushChildren(stack, element.props?.["children"]);
  }
  return matches;
}

const { useChatStore } = await import("../src/modules/chat/store");
const { useChat } = await import("../src/modules/chat/use-chat");
const { ChatActiveView } = await import("../src/modules/chat/components");

function resetChatStore(): void {
  useChatStore.setState({ conversations: {}, activeId: null });
}

function renderUseChat(): ReturnType<typeof useChat> {
  chatStreamSubscriptions.length = 0;
  resetHookCursors();
  return useChat();
}

describe("chat stream ownership", () => {
  beforeEach(() => {
    hookHarnessActive = true;
    resetHookState();
    resetChatStore();
    chatStreamSubscriptions.length = 0;
  });

  test("routes stream chunks to the conversation that started the stream after active chat changes", async () => {
    const store = useChatStore.getState();
    const conversationA = store.create({ node: "node-a", model: "node-a-model" });

    const chat = renderUseChat();
    await chat.send("hello");

    const conversationB = useChatStore.getState().create({ node: "node-b", model: "node-b-model" });
    expect(useChatStore.getState().activeId).toBe(conversationB);

    renderUseChat();

    const streamA = chatStreamSubscriptions.find((subscription) => subscription.options.enabled);
    expect(streamA?.input.node).toBe("node-a");

    streamA?.options.onData?.({
      type: "chunk",
      chunk: { choices: [{ delta: { content: "owned by A" } }] },
    });

    const conversations = useChatStore.getState().conversations;
    expect(conversations[conversationA]?.messages.at(-1)?.content).toBe("owned by A");
    expect(conversations[conversationB]?.messages).toEqual([]);
  });

  test("appends each chunk to the latest content without reading from a stale render snapshot", async () => {
    const convId = useChatStore.getState().create({ node: "node-a", model: "node-a-model" });

    const chat = renderUseChat();
    await chat.send("hello");
    // Re-render so streamInputA state flows into the subscription (enabled: true)
    renderUseChat();

    const streamSub = chatStreamSubscriptions.find((s) => s.options.enabled);

    // Two chunks before any re-render — the render snapshot captured in onData still
    // has content="" so a stale read-modify-write computes "" + " world" = " world".
    streamSub?.options.onData?.({
      type: "chunk",
      chunk: { choices: [{ delta: { content: "Hello" } }] },
    });
    streamSub?.options.onData?.({
      type: "chunk",
      chunk: { choices: [{ delta: { content: " world" } }] },
    });

    const content = useChatStore.getState().conversations[convId]?.messages.at(-1)?.content;
    expect(content).toBe("Hello world");
  });

  test("disables node and model selectors while a chat stream is busy", () => {
    const store = useChatStore.getState();
    const conversationId = store.create({ node: "node-a", model: "node-a-model" });
    const active = useChatStore.getState().conversations[conversationId];
    if (!active) throw new Error("missing active conversation");

    resetHookCursors();
    const rendered = renderFunctionTree(
      ChatActiveView({
        active,
        busyA: true,
        busyB: false,
        models: ["node-a-model"],
        modelsB: [],
        nodes: [{ name: "node-a" }, { name: "node-b" }],
        send: () => Promise.resolve(),
        store,
      }),
    );

    const selects = findElements(rendered, (element) => element.type === "select");
    const nodeAndModelSelects = selects.filter((select) =>
      ["node-a", "node-a-model"].includes(String(select.props?.["value"])),
    );

    expect(nodeAndModelSelects).toHaveLength(2);
    expect(nodeAndModelSelects.every((select) => select.props?.["disabled"] === true)).toBe(true);
  });
});
