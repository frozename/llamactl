import type { Root } from "react-dom/client";

import { afterAll, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { installDomShim } from "./console/dom-shim";

const UiActual = await import("../src/ui/index");

// Snapshot the real exports before registering the mocks. mock.module is
// process-global, so re-registering the snapshots in afterAll keeps later
// test files in this bun process on the real modules. Loading lib/trpc
// builds an IPC client at eval, which needs the preload bridge global.
const hadElectronTRPC = "electronTRPC" in globalThis;
const prevElectronTRPC = globalThis.electronTRPC;
globalThis.electronTRPC ??= {
  sendMessage: (): undefined => undefined,
  onMessage: (): undefined => undefined,
};
const TrpcActual = { ...(await import("../src/lib/trpc")) };
const UiSnapshot = { ...UiActual };

interface TestSchedule {
  id: string;
  node: string;
  rel: string;
  intervalSeconds: number;
  lastRunAt: string | null;
  lastError: string | null;
  enabled: boolean;
}

interface TestMutation {
  isPending: false;
  mutate: () => undefined;
}

interface CapturedMutationOptions {
  onError?: ((error: Error) => void) | undefined;
}

const capturedMutations = new Map<string, CapturedMutationOptions>();

function capturingMutation(name: string): (options?: CapturedMutationOptions) => TestMutation {
  return (options) => {
    if (options !== undefined) capturedMutations.set(name, options);
    return mutation();
  };
}

interface TestUtils {
  benchScheduleList: { invalidate: () => undefined };
  benchSchedulerStatus: { invalidate: () => undefined };
}

let schedules: TestSchedule[] = [];

function mutation(): TestMutation {
  return {
    isPending: false,
    mutate: (): undefined => undefined,
  };
}

void mock.module("@/lib/trpc", () => ({
  trpc: {
    useUtils: (): TestUtils => ({
      benchScheduleList: { invalidate: () => undefined },
      benchSchedulerStatus: { invalidate: () => undefined },
    }),
    benchScheduleList: {
      useQuery: (): { data: TestSchedule[] } => ({ data: schedules }),
    },
    benchSchedulerStatus: {
      useQuery: (): { data: { running: false; lastTickAt: null } } => ({
        data: { running: false, lastTickAt: null },
      }),
    },
    nodeList: {
      useQuery: (): { data: { nodes: { name: string }[] } } => ({
        data: { nodes: [{ name: "local" }] },
      }),
    },
    benchScheduleAdd: {
      useMutation: mutation,
    },
    benchScheduleRemove: {
      useMutation: mutation,
    },
    benchScheduleToggle: {
      useMutation: mutation,
    },
    benchSchedulerStart: {
      useMutation: capturingMutation("benchSchedulerStart"),
    },
    benchSchedulerStop: {
      useMutation: mutation,
    },
    benchSchedulerKick: {
      useMutation: capturingMutation("benchSchedulerKick"),
    },
  },
}));

void mock.module("@/ui", () => UiActual);

afterAll(() => {
  void mock.module("@/lib/trpc", () => TrpcActual);
  void mock.module("@/ui", () => UiSnapshot);
  if (hadElectronTRPC) globalThis.electronTRPC = prevElectronTRPC;
  else delete (globalThis as { electronTRPC?: unknown }).electronTRPC;
});

function schedule(intervalSeconds: number): TestSchedule {
  return {
    id: `schedule-${String(intervalSeconds)}`,
    node: "local",
    rel: "bench/cases.yaml",
    intervalSeconds,
    lastRunAt: null,
    lastError: null,
    enabled: true,
  };
}

async function renderSchedulerPanel(intervalSeconds: number): Promise<string> {
  schedules = [schedule(intervalSeconds)];
  const { SchedulerPanel } = await import("../src/modules/bench/scheduler-panel");

  return renderToStaticMarkup(<SchedulerPanel />);
}

describe("SchedulerPanel", () => {
  test("renders sub-hour intervals in minutes", async () => {
    const html = await renderSchedulerPanel(1800);

    expect(html).toContain("every 30 minutes");
    expect(html).not.toContain("every 1 hours");
  });

  test("renders whole-hour intervals in hours", async () => {
    const html = await renderSchedulerPanel(7200);

    expect(html).toContain("every 2 hours");
  });

  test("start and kick mutation errors surface in the panel", async () => {
    schedules = [];
    const shim = installDomShim();
    let root: Root | undefined;
    try {
      const { createRoot } = await import("react-dom/client");
      const container = shim.document.createElement("div");
      const mountedRoot = createRoot(container);
      root = mountedRoot;
      const { SchedulerPanel } = await import("../src/modules/bench/scheduler-panel");
      await act(() => {
        mountedRoot.render(<SchedulerPanel />);
        return Promise.resolve();
      });
      expect(container.textContent).not.toContain("run lock");

      for (const name of ["benchSchedulerStart", "benchSchedulerKick"] as const) {
        const onError = capturedMutations.get(name)?.onError;
        expect(onError).toBeFunction();
        await act(() => {
          onError!(new Error(`refused: ${name}`));
          return Promise.resolve();
        });
        expect(container.textContent).toContain(`refused: ${name}`);
      }
    } finally {
      if (root !== undefined) {
        const mountedRoot = root;
        await act(() => {
          mountedRoot.unmount();
          return Promise.resolve();
        });
      }
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 0);
      });
      shim.uninstall();
      capturedMutations.clear();
    }
  });
});
