import * as React from 'react';
import { useThemeStore } from '@/stores/theme-store';
import { getTheme } from '@/themes';
import { NodeMap } from './NodeMap';
import { NodeMapTailscale, NodeMapCyberpunk, NodeMapDatadog, useMockNodes } from './NodeMapVariants';

/**
 * Cluster map that swaps its visual variant based on the active
 * theme. Each theme pairs with a map style (see `themes/index.ts`
 * → `mapVariant`); this component just reads the active choice
 * and dispatches. All variants share the same node data + active-node
 * semantics so the picker feels instantaneous.
 *
 * The original legacy `NodeMap` is kept as the fallback — future
 * themes can opt into it by setting `mapVariant: 'legacy'`.
 */
export function ThemedNodeMap(): React.JSX.Element {
  const themeId = useThemeStore((s) => s.themeId);
  const theme = getTheme(themeId);
  const nodes = useMockNodes();
  switch (theme.mapVariant) {
    case 'glass':
      return <NodeMapTailscale nodes={nodes} />;
    case 'neon':
      return <NodeMapCyberpunk nodes={nodes} />;
    case 'hex':
      return <NodeMapDatadog nodes={nodes} />;
    default:
      return <NodeMap />;
  }
}
