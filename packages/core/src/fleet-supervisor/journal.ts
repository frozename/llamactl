import type { FleetSnapshot } from './types.js';

export interface JournalWriter {
  appendLine(line: string): Promise<void>;
}

export async function appendFleetSnapshot(
  snapshot: FleetSnapshot,
  writer: JournalWriter,
): Promise<void> {
  await writer.appendLine(JSON.stringify(snapshot));
}
