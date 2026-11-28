export interface IdleProfileWindow {
  from: string;
  to: string;
  signal: AbortSignal;
}

export interface OwnerAdmissionPause {
  signal: AbortSignal;
  isCurrent(): boolean;
  release(): void;
}

export interface OwnerActivity {
  allowDemand(): boolean;
  tryPause(
    verifyIngress: () => boolean,
    proveInitialIdle: () => boolean,
  ): OwnerAdmissionPause | undefined;
  stop(): void;
}

export function createOwnerActivity(): OwnerActivity {
  let current: AbortController | undefined;
  let stopped = false;
  return {
    allowDemand(): boolean {
      if (current === undefined) return !stopped;
      // Demand can cancel a transition without reopening admission
      // while its owner is still settling an actuator.
      current.abort();
      return false;
    },
    tryPause(verifyIngress, proveInitialIdle): OwnerAdmissionPause | undefined {
      if (stopped || current !== undefined) return undefined;
      const held = new AbortController();
      current = held;
      const ownsPause = (): boolean => current === held && !held.signal.aborted;
      const isCurrent = (): boolean => {
        if (!ownsPause()) return false;
        try {
          if (verifyIngress() && ownsPause()) return true;
        } catch {
          // An unavailable journal or ingress proof cannot authorize motion.
        }
        held.abort();
        return false;
      };
      const release = (): void => {
        if (current !== held) return;
        current = undefined;
        held.abort();
      };
      try {
        if (proveInitialIdle() && isCurrent())
          return Object.freeze({ signal: held.signal, isCurrent, release });
      } catch {
        // The initial persisted state may be unreadable.
      }
      release();
      return undefined;
    },
    stop(): void {
      stopped = true;
      current?.abort();
    },
  };
}
