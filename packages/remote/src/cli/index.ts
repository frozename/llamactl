/**
 * Public surface for the CLI subscription backend module.
 * Consumers outside this folder import from here, not from the
 * individual files — keeps the refactor surface tight.
 */
export {
  createCliSubprocessProvider,
  messagesToPrompt,
  type CliProviderOptions,
  type SpawnFn,
  type SpawnResult,
  type SpawnStreamFn,
  type SpawnStreamResult,
} from './adapter.js';
export {
  CLI_PRESETS,
  resolvePreset,
  expandArgs,
  type ResolvedCliInvocation,
} from './presets.js';
export {
  appendCliJournal,
  cliJournalPathFor,
  defaultCliJournalDir,
  type CliJournalEntry,
} from './journal.js';
