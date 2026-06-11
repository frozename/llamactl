// packages/app/src/modules/composites/types.ts
export type TabId = "list" | "apply" | "detail";
export type Phase = "Pending" | "Applying" | "Ready" | "Degraded" | "Failed";
export type ComponentState = "Pending" | "Applying" | "Ready" | "Failed";
export type ComponentKind = "service" | "workload" | "rag" | "gateway";

export interface ComponentRef {
  kind: ComponentKind;
  name: string;
}

export interface StatusComponent {
  ref: ComponentRef;
  state: ComponentState;
  message?: string;
}

export interface CompositeStatusShape {
  phase: Phase;
  appliedAt?: string;
  components: StatusComponent[];
}

export interface CompositeSpecShape {
  services: { kind: string; name: string; node: string }[];
  workloads: { node: string; target: { value: string; kind: string } }[];
  ragNodes: { name: string; node: string; backingService?: string }[];
  gateways: { name: string; node: string; provider: string; upstreamWorkloads: string[] }[];
  dependencies: { from: ComponentRef; to: ComponentRef }[];
  onFailure: "rollback" | "leave-partial";
}

export interface CompositeShape {
  apiVersion: "llamactl/v1";
  kind: "Composite";
  metadata: { name: string; labels?: Record<string, string> };
  spec: CompositeSpecShape;
  status?: CompositeStatusShape;
}

export interface DryRunResult {
  dryRun: true;
  manifest: CompositeShape;
  order: ComponentRef[];
  impliedEdges: { from: ComponentRef; to: ComponentRef }[];
}

export interface WetRunResult {
  dryRun: false;
  ok: boolean;
  status: CompositeStatusShape;
  rolledBack: boolean;
  componentResults: { ref: ComponentRef; state: "Ready" | "Failed"; message?: string }[];
}

export type ApplyResult = DryRunResult | WetRunResult;

export type ApplyEvent =
  | { type: "phase"; phase: Phase }
  | { type: "component-start"; ref: ComponentRef }
  | { type: "component-ready"; ref: ComponentRef; message?: string }
  | { type: "component-failed"; ref: ComponentRef; message: string }
  | { type: "rollback-start"; refs: ComponentRef[] }
  | { type: "rollback-complete" }
  | { type: "done"; ok: boolean };
