/**
 * Public surface for the CLI subscription backend module.
 * Consumers outside this folder import from here, not from the
 * individual files — keeps the refactor surface tight.
 */
export {
  type CliProviderOptions,
  createCliSubprocessProvider,
  messagesToPrompt,
  type SpawnFn,
  type SpawnResult,
  type SpawnStreamFn,
  type SpawnStreamResult,
} from "./adapter.js";
export {
  appendCliJournal,
  type CliJournalEntry,
  cliJournalPathFor,
  defaultCliJournalDir,
} from "./journal.js";
export { CLI_PRESETS, expandArgs, type ResolvedCliInvocation, resolvePreset } from "./presets.js";
