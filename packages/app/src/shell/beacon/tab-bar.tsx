import { Pin, X } from "lucide-react";
import * as React from "react";

import { type TabEntry, useTabStore } from "@/stores/tab-store";

import { type MenuState, useTabMenu } from "./use-tab-menu";

/**
 * Persistent tab strip.
 */
export function TabBar(): React.JSX.Element {
  const tabs = useTabStore((s) => s.tabs);
  const activeKey = useTabStore((s) => s.activeKey);
  const setActive = useTabStore((s) => s.setActive);
  const close = useTabStore((s) => s.close);
  const pin = useTabStore((s) => s.pin);
  const unpin = useTabStore((s) => s.unpin);
  const closeOthers = useTabStore((s) => s.closeOthers);
  const closeAll = useTabStore((s) => s.closeAll);

  const [menu, setMenu] = useTabMenu();
  const tabRefs = React.useRef<Map<string, HTMLDivElement>>(new Map());

  const focusTab = (key: string): void => {
    requestAnimationFrame(() => {
      tabRefs.current.get(key)?.focus();
    });
  };

  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        alignItems: "stretch",
        background: "var(--color-surface-1)",
        borderBottom: "1px solid var(--color-border-subtle)",
        overflowX: "auto",
        minHeight: 38,
      }}
    >
      {tabs.map((tab, idx) => (
        <TabItem
          key={tab.tabKey}
          tab={tab}
          idx={idx}
          total={tabs.length}
          active={tab.tabKey === activeKey}
          setActive={setActive}
          close={close}
          unpin={unpin}
          setMenu={setMenu}
          tabRefs={tabRefs}
          focusTab={focusTab}
          tabs={tabs}
        />
      ))}
      {menu && (
        <TabContextMenu
          menu={menu}
          setMenu={setMenu}
          pin={pin}
          unpin={unpin}
          close={close}
          closeOthers={closeOthers}
          closeAll={closeAll}
        />
      )}
    </div>
  );
}

function TabItem({
  tab,
  idx,
  total,
  active,
  setActive,
  close,
  unpin,
  setMenu,
  tabRefs,
  focusTab,
  tabs,
}: {
  tab: TabEntry;
  idx: number;
  total: number;
  active: boolean;
  setActive: (k: string) => void;
  close: (k: string) => void;
  unpin: (k: string) => void;
  setMenu: (v: MenuState) => void;
  tabRefs: React.RefObject<Map<string, HTMLDivElement>>;
  focusTab: (k: string) => void;
  tabs: TabEntry[];
}): React.JSX.Element {
  return (
    <div
      ref={(el) => {
        if (el) tabRefs.current.set(tab.tabKey, el);
        else tabRefs.current.delete(tab.tabKey);
      }}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={() => {
        setActive(tab.tabKey);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) close(tab.tabKey);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, tab });
      }}
      onKeyDown={(e) => {
        handleTabKeyDown(e, { tab, tabs, idx, total, setActive, focusTab });
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 14px",
        fontSize: 12,
        color: active ? "var(--color-text)" : "var(--color-text-tertiary)",
        background: active ? "var(--color-surface-0)" : "transparent",
        cursor: "pointer",
        borderRight: "1px solid var(--color-border-subtle)",
        position: "relative",
        whiteSpace: "nowrap",
        transition: "background 160ms, color 160ms",
      }}
    >
      {active && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            height: 1.5,
            background: "var(--color-brand)",
          }}
        />
      )}
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: active ? "var(--color-brand)" : "var(--color-text-ghost)",
        }}
      />
      <span>{tab.title}</span>
      <TabCloseButton tab={tab} close={close} unpin={unpin} />
    </div>
  );
}

function handleTabKeyDown(
  e: React.KeyboardEvent<HTMLDivElement>,
  opts: {
    tab: TabEntry;
    tabs: TabEntry[];
    idx: number;
    total: number;
    setActive: (k: string) => void;
    focusTab: (k: string) => void;
  },
): void {
  const { tab, tabs, idx, total, setActive, focusTab } = opts;
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(idx + dir + total) % total];
    if (next) {
      setActive(next.tabKey);
      focusTab(next.tabKey);
    }
  } else if (e.key === "Home") {
    e.preventDefault();
    const first = tabs[0];
    if (first) {
      setActive(first.tabKey);
      focusTab(first.tabKey);
    }
  } else if (e.key === "End") {
    e.preventDefault();
    const last = tabs[total - 1];
    if (last) {
      setActive(last.tabKey);
      focusTab(last.tabKey);
    }
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    setActive(tab.tabKey);
  }
}

function TabCloseButton({
  tab,
  close,
  unpin,
}: {
  tab: TabEntry;
  close: (k: string) => void;
  unpin: (k: string) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (tab.pinned) unpin(tab.tabKey);
        else close(tab.tabKey);
      }}
      style={{
        all: "unset",
        width: 16,
        height: 16,
        display: "grid",
        placeItems: "center",
        borderRadius: 4,
        cursor: "pointer",
        marginLeft: 4,
        color: "inherit",
      }}
      title={tab.pinned ? "Unpin" : "Close"}
    >
      {tab.pinned ? (
        <Pin size={11} strokeWidth={2} fill="currentColor" />
      ) : (
        <X size={12} strokeWidth={2} />
      )}
    </button>
  );
}

function TabContextMenu({
  menu,
  setMenu,
  pin,
  unpin,
  close,
  closeOthers,
  closeAll,
}: {
  menu: NonNullable<MenuState>;
  setMenu: (v: MenuState) => void;
  pin: (k: string) => void;
  unpin: (k: string) => void;
  close: (k: string) => void;
  closeOthers: (k: string) => void;
  closeAll: (v: boolean) => void;
}): React.JSX.Element {
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
      }}
      style={{
        position: "fixed",
        left: menu.x,
        top: menu.y,
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--r-md)",
        padding: 4,
        boxShadow: "var(--shadow-md)",
        fontSize: 12,
        zIndex: 2000,
        minWidth: 180,
      }}
    >
      <MenuItem
        label={menu.tab.pinned ? "Unpin" : "Pin"}
        onPick={() => {
          if (menu.tab.pinned) unpin(menu.tab.tabKey);
          else pin(menu.tab.tabKey);
          setMenu(null);
        }}
      />
      <MenuItem
        label="Close"
        onPick={() => {
          close(menu.tab.tabKey);
          setMenu(null);
        }}
      />
      <MenuItem
        label="Close others"
        onPick={() => {
          closeOthers(menu.tab.tabKey);
          setMenu(null);
        }}
      />
      <MenuItem
        label="Close all"
        onPick={() => {
          closeAll(true);
          setMenu(null);
        }}
      />
    </div>
  );
}

function MenuItem({ label, onPick }: { label: string; onPick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onPick}
      style={{
        all: "unset",
        display: "block",
        width: "100%",
        padding: "6px 10px",
        cursor: "pointer",
        color: "var(--color-text)",
        borderRadius: 4,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--color-surface-3)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {label}
    </button>
  );
}
