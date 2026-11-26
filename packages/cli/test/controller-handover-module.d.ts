declare module "*/commands/controller-handover.js" {
  export interface HandoverLocalHost {
    name: string;
    specHash: string;
    enabled: boolean;
    managedBy: string | null;
  }

  export interface HandoverEngineRecord {
    pid: number;
    specHash?: string;
  }

  export type CentralLive =
    | { state: string; pid: number | null; specHash: string | null }
    | { error: string };

  export interface CentralHostView {
    found: boolean;
    node: string | null;
    managedBy: string | null;
    specHash: string | null;
    live: CentralLive;
    controllerPid: number | null;
  }

  export interface HandoverOptions {
    to: string;
    node: string;
    timeoutMs: number;
    pollMs: number;
    dryRun: boolean;
    controllerUnit: string | null;
  }

  export interface HandoverDeps {
    listLocalHosts: () => HandoverLocalHost[];
    listLocalModelRuns: () => string[];
    readLocalEngine: (name: string) => HandoverEngineRecord | null;
    queryCentral: (name: string) => Promise<CentralHostView>;
    labelHost: (name: string, manager: string) => void;
    unlabelHost: (name: string) => void;
    stopLocalController: () => Promise<{ ok: boolean; detail: string }>;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    stdout: (s: string) => void;
    stderr: (s: string) => void;
  }

  export function parseHandoverFlags(args: string[]): HandoverOptions | { error: string };

  export function adoptionProblem(
    host: HandoverLocalHost,
    engine: HandoverEngineRecord | null,
    view: CentralHostView,
    opts: Pick<HandoverOptions, "to" | "node">,
  ): string | null;

  export function runControllerHandover(opts: HandoverOptions, deps: HandoverDeps): Promise<number>;
}
