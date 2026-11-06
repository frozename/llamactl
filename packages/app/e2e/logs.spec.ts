// packages/app/e2e/logs.spec.ts — #410 P5b part 2b.
// The tab-node logs tail on agent-1: the masked boot line over a live
// serverLogs subscription, control-driven emitLog streaming, the Follow
// auto-scroll contract, a wire-level masking proof for a second in-page
// subscription (the auto guard skips text/event-stream bodies, so it can
// neither leak nor prove there), unmount teardown via nav, the
// stopped-workload gate with zero stream calls, and the single
// documented reconnect gap.

import type { ControlClient } from "./harness/fixtures/test";

import { E2E_SENTINEL_VALUES, E2E_SENTINELS } from "./harness/fixtures/seed";
import { expect, test } from "./harness/fixtures/test";

const BOOT_MARKER = "e2e boot";
const WIRE_MARKER = "wire-marker";
const LOGS_ROUTE = "/logs/wB?node=agent-1";
const SSE_URL = `/api/n/agent-1/trpc/serverLogs?input=${encodeURIComponent(
  JSON.stringify({ follow: true, lines: 50, workload: "wB" }),
)}`;

function inputWorkloadIs(input: unknown, name: string): boolean {
  return (
    typeof input === "object" && input !== null && "workload" in input && input.workload === name
  );
}

async function waitForStream(control: ControlClient, open: boolean): Promise<void> {
  const settled = async (): Promise<boolean> =>
    (await control.streams("agent-1")).some((entry) => entry.workload === "wB");
  await expect.poll(settled, { timeout: open ? 5_000 : 2_000 }).toBe(open);
}

async function waitForOpenStreams(control: ControlClient, count: number): Promise<void> {
  const settled = async (): Promise<boolean> =>
    (await control.streams("agent-1")).filter((entry) => entry.open && entry.workload === "wB")
      .length >= count;
  await expect.poll(settled, { timeout: 5_000 }).toBe(true);
}

test("the masked boot line streams and a control-emitted line follows it", async ({
  control,
  page,
}) => {
  await page.goto(LOGS_ROUTE);
  const boot = page.getByTestId("console-logs-line").filter({ hasText: BOOT_MARKER });
  await expect(boot).toContainText("--api-key [redacted]");
  await expect(boot).not.toContainText(E2E_SENTINELS.bearer);
  await expect(page.getByTestId("console-logs-conn")).toHaveAttribute("data-state", "streaming", {
    timeout: 5_000,
  });
  await waitForStream(control, true);
  await control.emitLog("agent-1", "wB", "e2e-mark-1");
  await expect(
    page.getByTestId("console-logs-line").filter({ hasText: "e2e-mark-1" }),
  ).toBeVisible();
});

test("Follow pins the bottom while checked and stays parked when not", async ({
  control,
  page,
}) => {
  await page.goto(LOGS_ROUTE);
  await waitForStream(control, true);
  const follow = page.getByRole("checkbox", { name: "Follow" });
  await expect(follow).toBeChecked();
  const buffer = page.getByTestId("console-logs-line").first().locator("..");
  for (let index = 0; index < 60; index += 1) {
    await control.emitLog("agent-1", "wB", `e2e-fill-${String(index)}`);
  }
  await expect
    .poll(
      async () =>
        await buffer.evaluate(
          (el) =>
            el.scrollHeight > el.clientHeight &&
            el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
        ),
      { timeout: 5_000 },
    )
    .toBe(true);
  await follow.click();
  await buffer.evaluate((el) => {
    el.scrollTop = 0;
  });
  await control.emitLog("agent-1", "wB", "e2e-while-parked");
  await expect(
    page.getByTestId("console-logs-line").filter({ hasText: "e2e-while-parked" }),
  ).toBeVisible();
  expect(await buffer.evaluate((el) => el.scrollTop)).toBe(0);
});

test("the masked projection holds on the wire, not just on screen", async ({ control, page }) => {
  await page.goto(LOGS_ROUTE);
  await waitForStream(control, true);
  // The auto sentinel guard skips text/event-stream responses, so
  // neither leak nor proof can flow through it here; this second
  // in-page subscription reads the raw SSE frames and scans them. It
  // must be open before the marker line is emitted: emitLog only
  // fans out to streams that are already registered, so an emit
  // ordered first would never reach this read.
  const wirePromise = page.evaluate(
    async (opts: { marker: string; url: string }): Promise<string> => {
      const res = await fetch(opts.url, { headers: { accept: "text/event-stream" } });
      const reader = res.body?.getReader();
      if (reader === undefined) {
        return "";
      }
      const decoder = new TextDecoder();
      let text = "";
      const deadline = Date.now() + 10_000;
      while (!text.includes(opts.marker) && Date.now() < deadline) {
        const frame = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => {
            setTimeout(
              () => {
                resolve(null);
              },
              Math.max(1, deadline - Date.now()),
            );
          }),
        ]);
        if (frame === null || frame.done) {
          break;
        }
        text += decoder.decode(frame.value, { stream: true });
      }
      await reader.cancel();
      return text;
    },
    { marker: WIRE_MARKER, url: SSE_URL },
  );
  await waitForOpenStreams(control, 2);
  await control.emitLog("agent-1", "wB", `--api-key ${E2E_SENTINELS.log} ${WIRE_MARKER}`);
  const masked = page.getByTestId("console-logs-line").filter({ hasText: WIRE_MARKER });
  await expect(masked).toContainText(`--api-key [redacted] ${WIRE_MARKER}`);
  await expect(masked).not.toContainText(E2E_SENTINELS.log);
  const wire = await wirePromise;
  expect(wire).toContain(BOOT_MARKER);
  expect(wire).toContain("[redacted]");
  expect(wire).toContain(`--api-key [redacted] ${WIRE_MARKER}`);
  // Case-insensitive on purpose: with the server-side flag masking
  // gone, redact.ts's BEARER rewrites split the boot sentinel into
  // "sentinel-Bearer [redacted]" instead of removing it, and a
  // case-sensitive scan would read that split leak as clean.
  const wireLower = wire.toLowerCase();
  for (const sentinel of E2E_SENTINEL_VALUES) {
    expect(wireLower).not.toContain(sentinel.toLowerCase());
  }
});

// Gap pinned for #410: handleInnerComplete in sse-lifecycle.ts treats a
// server-completed stream as terminal and never dispatches
// RECONNECT_SIGNAL, and logsConnState in logs-scope.ts (L131-134) has
// no reconnecting state to land in — the divider + re-tail below is the
// intended contract once reconnect lands. A wet spec cannot pin it
// without a src change: the fixture drop ends the generator cleanly,
// and a shaped error frame classifies as non-retryable.
test.fixme("a dropped stream reconnects into a fresh tail behind a divider", async ({
  control,
  page,
}) => {
  await page.goto(LOGS_ROUTE);
  await waitForStream(control, true);
  await control.dropStream("agent-1", "wB");
  await expect(page.getByTestId("console-logs-conn")).toHaveAttribute(
    "data-state",
    "reconnecting",
    { timeout: 2_000 },
  );
  await expect(page.getByTestId("console-logs-divider")).toBeVisible();
  await expect(page.getByTestId("console-logs-line").filter({ hasText: BOOT_MARKER })).toHaveCount(
    1,
  );
});

test("a dropped stream currently completes without reconnect noise", async ({ control, page }) => {
  await page.goto(LOGS_ROUTE);
  await waitForStream(control, true);
  await control.dropStream("agent-1", "wB");
  await waitForStream(control, false);
  await expect(page.getByTestId("console-logs-divider")).toHaveCount(0);
  await expect(page.getByTestId("console-logs-line").filter({ hasText: BOOT_MARKER })).toHaveCount(
    1,
  );
});

test("leaving the route tears the stream down", async ({ control, page }) => {
  await page.goto(LOGS_ROUTE);
  await waitForStream(control, true);
  await expect(page.getByTestId("console-logs-conn")).toHaveAttribute("data-state", "reconnecting", {
    timeout: 2_000,
  });
  await page.getByRole("navigation").getByRole("link", { name: "Workloads" }).click();
  await expect(page.getByTestId("console-view-workloads")).toBeVisible();
  await waitForStream(control, false);
});

test("a stopped workload gates the tail and calls serverLogs zero times", async ({
  control,
  page,
}) => {
  await page.goto("/logs/wB-stopped?node=agent-1");
  await expect(page.getByTestId("console-logs-offline")).toHaveText("Server offline");
  await expect
    .poll(
      async () =>
        (await control.calls("agent-1")).some(
          (call) => call.procedure === "serverStatus" && inputWorkloadIs(call.input, "wB-stopped"),
        ),
      { timeout: 5_000 },
    )
    .toBe(true);
  const logsCalls = (await control.calls("agent-1")).filter(
    (call) => call.procedure === "serverLogs",
  );
  expect(logsCalls).toEqual([]);
});
