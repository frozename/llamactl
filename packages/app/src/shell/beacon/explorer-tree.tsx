import * as React from "react";

import { useExplorerCollapse } from "@/stores/explorer-collapse-store";
import { useTabStore } from "@/stores/tab-store";
import { StatusDot, TreeItem } from "@/ui";

import type { DynamicInstance, ExplorerGroup, ExplorerLeaf } from "./registry-view";

import { useExplorerTreeData } from "./use-explorer-tree-data";

/**
 * Renders the Workspace tree. Static leaves open a module tab; dynamic
 * leaves expand to show live instances.
 */
export function ExplorerTree(): React.JSX.Element {
  const { tree } = useExplorerTreeData();
  const collapsed = useExplorerCollapse((s) => s.collapsed);
  const toggleCollapse = useExplorerCollapse((s) => s.toggle);
  const activeTabKey = useTabStore((s) => s.activeKey);
  const open = useTabStore((s) => s.open);

  const openLeaf = React.useCallback(
    (leaf: ExplorerLeaf): void => {
      open({
        tabKey: `module:${leaf.id}`,
        title: leaf.title,
        kind: "module",
        openedAt: Date.now(),
      });
    },
    [open],
  );

  const openInstance = React.useCallback(
    (leaf: ExplorerLeaf, inst: DynamicInstance): void => {
      const kind = leaf.id === "workloads" ? "workload" : leaf.id === "nodes" ? "node" : "module";
      open({
        tabKey: `${kind}:${inst.id}`,
        title: inst.title,
        kind,
        instanceId: inst.id,
        openedAt: Date.now(),
      });
    },
    [open],
  );

  return (
    <div role="tree" style={{ overflowY: "auto", flex: 1 }}>
      {tree.map((group) => (
        <ExplorerGroupItem
          key={group.id}
          group={group}
          collapsed={collapsed}
          toggleCollapse={toggleCollapse}
          activeTabKey={activeTabKey}
          openLeaf={openLeaf}
          openInstance={openInstance}
        />
      ))}
    </div>
  );
}

function ExplorerGroupItem({
  group,
  collapsed,
  toggleCollapse,
  activeTabKey,
  openLeaf,
  openInstance,
}: {
  group: ExplorerGroup;
  collapsed: Record<string, boolean>;
  toggleCollapse: (id: string) => void;
  activeTabKey: string | null;
  openLeaf: (leaf: ExplorerLeaf) => void;
  openInstance: (leaf: ExplorerLeaf, inst: DynamicInstance) => void;
}): React.JSX.Element {
  const isCollapsed = collapsed[group.id] === true;
  return (
    <div>
      <button
        type="button"
        data-testid={`explorer-group-${group.id}`}
        onClick={() => {
          toggleCollapse(group.id);
        }}
        style={{
          all: "unset",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "10px 18px 4px",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--color-text-tertiary)",
          cursor: "pointer",
          width: "100%",
        }}
      >
        <span
          style={{
            transition: "transform 160ms",
            transform: isCollapsed ? "rotate(-90deg)" : "none",
          }}
        >
          ▾
        </span>
        {group.label}
      </button>
      {!isCollapsed &&
        group.leaves.map((leaf) => (
          <ExplorerLeafItem
            key={leaf.id}
            group={group}
            leaf={leaf}
            collapsed={collapsed}
            toggleCollapse={toggleCollapse}
            activeTabKey={activeTabKey}
            openLeaf={openLeaf}
            openInstance={openInstance}
          />
        ))}
    </div>
  );
}

function ExplorerLeafItem({
  group,
  leaf,
  collapsed,
  toggleCollapse,
  activeTabKey,
  openLeaf,
  openInstance,
}: {
  group: ExplorerGroup;
  leaf: ExplorerLeaf;
  collapsed: Record<string, boolean>;
  toggleCollapse: (id: string) => void;
  activeTabKey: string | null;
  openLeaf: (leaf: ExplorerLeaf) => void;
  openInstance: (leaf: ExplorerLeaf, inst: DynamicInstance) => void;
}): React.JSX.Element {
  const isLeafCollapsed = collapsed[`${group.id}/${leaf.id}`] ?? false;
  return (
    <>
      <div {...(leaf.kind === "static" ? { "data-testid": `explorer-leaf-${leaf.id}` } : {})}>
        <TreeItem
          label={leaf.title}
          active={activeTabKey === `module:${leaf.id}`}
          onClick={() => {
            openLeaf(leaf);
          }}
          collapsed={leaf.kind === "dynamic-group" ? isLeafCollapsed : undefined}
          onDoubleClick={() => {
            if (leaf.kind === "dynamic-group") toggleCollapse(`${group.id}/${leaf.id}`);
          }}
        />
      </div>
      {leaf.kind === "dynamic-group" &&
        !isLeafCollapsed &&
        (leaf.instances ?? []).map((inst) => (
          <TreeItem
            key={inst.id}
            indent={1}
            label={inst.title}
            trailing={<StatusDot tone={inst.tone ?? "idle"} />}
            active={activeTabKey === `${leaf.id === "workloads" ? "workload" : "node"}:${inst.id}`}
            onClick={() => {
              openInstance(leaf, inst);
            }}
          />
        ))}
    </>
  );
}
