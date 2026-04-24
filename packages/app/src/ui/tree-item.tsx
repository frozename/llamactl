import * as React from 'react';
import { cx } from './classes';

export interface TreeItemProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
  indent?: 0 | 1 | 2;
  active?: boolean;
  /** If true, render a chevron slot (collapsed); `undefined` = leaf; `false` = expanded. */
  collapsed?: boolean | undefined;
}

/**
 * One row in the Explorer tree. Indent is integer (0/1/2); deeper nesting
 * is intentionally not supported — if you need three levels, fold the
 * middle level into a section head instead.
 */
export function TreeItem({
  label,
  icon,
  trailing,
  indent = 0,
  active = false,
  collapsed,
  className,
  style,
  onClick,
  ...rest
}: TreeItemProps): React.JSX.Element {
  return (
    <div
      role="treeitem"
      aria-selected={active}
      onClick={onClick}
      {...rest}
      className={cx('bcn-tree-item', active && 'bcn-tree-item--active', className)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingTop: 4,
        paddingBottom: 4,
        paddingLeft: 14 + indent * 14,
        paddingRight: 18,
        fontSize: 13,
        color: active ? 'var(--color-text)' : 'var(--color-text-secondary)',
        background: active ? 'var(--color-brand-ghost)' : 'transparent',
        cursor: 'pointer',
        userSelect: 'none',
        position: 'relative',
        lineHeight: 1.4,
        ...style,
      }}
    >
      {active && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            top: 2,
            bottom: 2,
            width: 2,
            background: 'var(--color-brand)',
            borderRadius: 2,
          }}
        />
      )}
      <span
        aria-hidden="true"
        style={{
          width: 10,
          color: 'var(--color-text-ghost)',
          fontSize: 9,
          flexShrink: 0,
          visibility: collapsed === undefined ? 'hidden' : 'visible',
          transform: collapsed ? 'rotate(-90deg)' : 'none',
          transition: 'transform 160ms',
        }}
      >
        ▾
      </span>
      {icon && (
        <span
          aria-hidden="true"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14 }}
        >
          {icon}
        </span>
      )}
      <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </span>
      {trailing && <span style={{ flexShrink: 0 }}>{trailing}</span>}
    </div>
  );
}
