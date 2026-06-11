import { useEffect } from "react";

import type { TabEntry } from "@/stores/tab-store";

export function useTabShortcuts(
  tabs: TabEntry[],
  activeKey: string | null,
  close: (k: string) => void,
  reopen: () => void,
  setActive: (k: string) => void,
): void {
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (k === "w" && !e.shiftKey && activeKey) {
        e.preventDefault();
        close(activeKey);
        return;
      }
      if (k === "t" && e.shiftKey) {
        e.preventDefault();
        reopen();
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= 9) {
        const target = tabs[n - 1];
        if (target) {
          e.preventDefault();
          setActive(target.tabKey);
        }
      }
    };
    window.addEventListener("keydown", h);
    return (): void => {
      window.removeEventListener("keydown", h);
    };
  }, [tabs, activeKey, close, reopen, setActive]);
}
