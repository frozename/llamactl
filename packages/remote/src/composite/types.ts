import type { ComponentRef, CompositeStatus } from './schema.js';

/**
 * Events emitted by `applyComposite` as it walks the component DAG.
 * Consumers (tRPC subscription, Electron UI, CLI) subscribe to stream
 * progress in real time. Event ordering:
 *
 *   phase:Applying → [component-start, component-ready|failed]* →
 *   (on rollback) rollback-start → rollback-complete →
 *   phase:Ready|Degraded|Failed → done
 *
 * Emit via the optional `onEvent` callback on `applyComposite`. Never
 * block the apply loop on the consumer — the callback is best-effort.
 */
export type CompositeApplyEvent =
  | { type: 'phase'; phase: CompositeStatus['phase'] }
  | { type: 'component-start'; ref: ComponentRef }
  | { type: 'component-ready'; ref: ComponentRef; message?: string }
  | { type: 'component-failed'; ref: ComponentRef; message: string }
  | { type: 'rollback-start'; refs: ComponentRef[] }
  | { type: 'rollback-complete' }
  | { type: 'done'; ok: boolean };

export interface CompositeComponentResult {
  ref: ComponentRef;
  // 'Pending' surfaces both pipeline conflict states (PipelineNameCollision,
  // PipelineShapeMismatch) and downstream components that the topo loop
  // never tried because an earlier component halted on Pending.
  state: 'Ready' | 'Failed' | 'Pending';
  message?: string;
}

export interface CompositeApplyResult {
  ok: boolean;
  status: CompositeStatus;
  rolledBack: boolean;
  componentResults: CompositeComponentResult[];
}
