import { afterAll, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

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
      useMutation: mutation,
    },
    benchSchedulerStop: {
      useMutation: mutation,
    },
    benchSchedulerKick: {
      useMutation: mutation,
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
});
