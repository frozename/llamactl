import { expect, test } from "bun:test";

import { dashboardPolling } from "../../src/console/views/dashboard-settings";

test("the dashboard can pause all observations and resume at the selected cadence", () => {
  expect(dashboardPolling({ paused: true, seconds: 5 }, 15)).toEqual({
    enabled: false,
    refetchInterval: false,
    retry: false,
  });
  expect(dashboardPolling({ paused: false, seconds: 5 })).toMatchObject({
    enabled: true,
    refetchInterval: 5000,
  });
  expect(dashboardPolling({ paused: false, seconds: 5 }, 15).refetchInterval).toBe(15000);
  expect(dashboardPolling({ paused: false, seconds: 30 }, 15).refetchInterval).toBe(30000);
});
