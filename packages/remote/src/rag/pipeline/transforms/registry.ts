/**
 * Transform registry — mirror of the fetcher one. Keeps the runtime
 * unaware of specific transforms so a future `pdf-extract`,
 * `strip-boilerplate`, or `code-fence-split` plugs in by appending
 * a single entry here.
 */
import type { Transform } from '../types.js';
import { markdownChunkTransform } from './markdown-chunk.js';

export const TRANSFORMS: Record<string, Transform> = {
  'markdown-chunk': markdownChunkTransform,
};
