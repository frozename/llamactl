import {
  defaultFleetJournalPath,
  readLatestFleetSnapshotFromJournal,
} from '../../../fleet-supervisor/src/index.js';

export interface FleetSnapshotRouteOptions {
  journalPath?: string;
}

export async function handleFleetSnapshotRoute(
  _req: Request,
  opts: FleetSnapshotRouteOptions = {},
): Promise<Response> {
  const journalPath = opts.journalPath ?? defaultFleetJournalPath();
  const latest = readLatestFleetSnapshotFromJournal(journalPath);
  if (latest === null) return new Response(null, { status: 204 });
  return Response.json(latest, { status: 200 });
}
