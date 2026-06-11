import { useEffect, useState } from "react";

import type { TabEntry } from "@/stores/tab-store";

export type MenuState = { x: number; y: number; tab: TabEntry } | null;

export function useTabMenu(): [MenuState, (v: MenuState) => void] {
  const [menu, setMenu] = useState<MenuState>(null);

  useEffect(() => {
    if (!menu) return;
    const dismiss = (): void => {
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", dismiss);
    window.addEventListener("keydown", onKey);
    return (): void => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return [menu, setMenu];
}
