export const refreshPeriods = [5, 15, 30] as const;
export const requestLimits = [10, 25, 50] as const;
export const chartMetrics = ["decode", "prefill", "latency"] as const;

export interface DashboardSettings {
  paused: boolean;
  seconds: number;
  limit: number;
  chart: (typeof chartMetrics)[number];
  node: string;
}

export function dashboardPolling(
  settings: Pick<DashboardSettings, "paused" | "seconds">,
  minSeconds = 0,
): { enabled: boolean; refetchInterval: number | false; retry: false } {
  return {
    enabled: !settings.paused,
    refetchInterval: settings.paused ? false : Math.max(minSeconds, settings.seconds) * 1000,
    retry: false,
  };
}
