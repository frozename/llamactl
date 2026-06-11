import { useEffect, useState } from "react";

import type { RailViewId } from "./rail-views";

const RAIL_KEY = "beacon.rail.view";

export function useRailState(): [RailViewId, (v: RailViewId) => void] {
  const [railView, setRailView] = useState<RailViewId>(() => {
    if (typeof localStorage === "undefined") return "explorer";
    const stored = localStorage.getItem(RAIL_KEY);
    return stored !== null ? (stored as RailViewId) : "explorer";
  });

  useEffect(() => {
    localStorage.setItem(RAIL_KEY, railView);
  }, [railView]);

  return [railView, setRailView];
}
