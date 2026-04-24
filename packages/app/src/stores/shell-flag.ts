import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Gates the Beacon shell (P2) against the legacy IDELayout. Default
 * `true` so new users land on Beacon; the Settings module gets a
 * toggle so users who need the old shell can opt out for one release
 * cycle. Removed at the end of P3.
 */
interface ShellFlagStore {
  beaconShell: boolean;
  setBeaconShell: (on: boolean) => void;
}

export const useShellFlag = create<ShellFlagStore>()(
  persist(
    (set) => ({
      beaconShell: true,
      setBeaconShell: (on) => set({ beaconShell: on }),
    }),
    { name: 'beacon-shell-flag' },
  ),
);
