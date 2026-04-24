import * as React from 'react';
import { cx } from './classes';

export interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  onValueChange: (next: string) => void;
  children: React.ReactNode;
}

export interface TabProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

const TabsCtx = React.createContext<{
  value: string;
  onValueChange: (next: string) => void;
} | null>(null);

export function Tabs({ value, onValueChange, className, children, ...rest }: TabsProps): React.JSX.Element {
  return (
    <TabsCtx.Provider value={{ value, onValueChange }}>
      <div
        role="tablist"
        {...rest}
        className={cx('bcn-tabs', className)}
        style={{
          display: 'flex',
          gap: 2,
          borderBottom: '1px solid var(--color-border-subtle)',
          width: '100%',
        }}
      >
        {children}
      </div>
    </TabsCtx.Provider>
  );
}

export function Tab({ value, className, children, ...rest }: TabProps): React.JSX.Element {
  const ctx = React.useContext(TabsCtx);
  if (!ctx) throw new Error('Tab must be rendered inside Tabs');
  const active = ctx.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      {...rest}
      onClick={(e) => {
        rest.onClick?.(e);
        if (!e.defaultPrevented) ctx.onValueChange(value);
      }}
      className={cx('bcn-tab', active && 'bcn-tab--active', className)}
      style={{
        padding: '8px 14px',
        fontSize: 12,
        color: active ? 'var(--color-text)' : 'var(--color-text-tertiary)',
        borderBottom: active ? '1.5px solid var(--color-brand)' : '1.5px solid transparent',
        marginBottom: -1,
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        transition: 'color 160ms',
      }}
    >
      {children}
    </button>
  );
}
