import * as React from "react";
import { useState } from "react";

export function useCompositeParam(): [string | null, (name: string | null) => void] {
  const [value, setValue] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const p = new URLSearchParams(window.location.search);
    return p.get("composite");
  });
  const setParam = React.useCallback((name: string | null): void => {
    setValue(name);
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    if (name) p.set("composite", name);
    else p.delete("composite");
    const next = `${window.location.pathname}${p.toString() ? `?${p.toString()}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", next);
  }, []);
  return [value, setParam];
}
