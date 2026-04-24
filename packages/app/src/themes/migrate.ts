/**
 * One-shot mapping from the pre-Beacon theme ids (glass/neon/ops) to
 * Beacon families. Called from the theme-store `migrate` hook on first
 * load after upgrading. Pure; no side-effects.
 */

export type LegacyThemeId = 'glass' | 'neon' | 'ops';
export type BeaconThemeId = 'sirius' | 'ember' | 'clinical' | 'scrubs';
export type AnyThemeId = LegacyThemeId | BeaconThemeId | string;

export interface MigrationExtras {
  /** True if the legacy theme had a decoration we want to preserve as
   *  an opt-in user preference (today only `neon` carries this — its
   *  scanlines overlay is kept as an opt-in decoration). */
  scanlines?: boolean;
}

export interface MigrationResult {
  themeId: BeaconThemeId;
  extras: MigrationExtras;
}

export function migrateLegacyThemeId(id: AnyThemeId): MigrationResult {
  switch (id) {
    case 'glass':
      return { themeId: 'sirius', extras: {} };
    case 'neon':
      return { themeId: 'sirius', extras: { scanlines: true } };
    case 'ops':
      return { themeId: 'scrubs', extras: {} };
    case 'sirius':
    case 'ember':
    case 'clinical':
    case 'scrubs':
      return { themeId: id, extras: {} };
    default:
      return { themeId: 'sirius', extras: {} };
  }
}
