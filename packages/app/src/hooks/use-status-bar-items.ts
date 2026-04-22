import { useEffect } from 'react';
import { useStatusBarStore, type StatusBarItem } from '@/stores/status-bar-store';

/**
 * Module-scoped status-bar contribution. Pass the active module id
 * + an array of items; items replace any prior contribution from
 * the same module. On unmount the items clear so stale state from
 * a different invocation doesn't linger.
 *
 * Example usage inside a module:
 *
 *   useStatusBarItems('chat', [
 *     { id: 'model', text: `model: ${modelName}`, tone: 'fg' },
 *     { id: 'tokens', text: `${tokensPerSec} tok/s`, tone: 'accent' },
 *   ]);
 */
export function useStatusBarItems(moduleId: string, items: StatusBarItem[]): void {
  const setItems = useStatusBarStore((s) => s.setModuleItems);
  const clearItems = useStatusBarStore((s) => s.clearModuleItems);
  useEffect(() => {
    setItems(moduleId, items);
    return () => clearItems(moduleId);
    // We intentionally serialize items so downstream consumers
    // only re-run on content change, not reference identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleId, JSON.stringify(items)]);
}
