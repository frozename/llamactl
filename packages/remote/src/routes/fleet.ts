import {
  defaultFleetJournalPath,
  readLatestFleetSnapshotFromJournal,
} from "@llamactl/fleet-supervisor";

export interface FleetSnapshotRouteOptions {
  journalPath?: string;
}

export function handleFleetSnapshotRoute(
  _req: Request,
  opts: FleetSnapshotRouteOptions = {},
): Response {
  const journalPath = opts.journalPath ?? defaultFleetJournalPath();
  const latest = readLatestFleetSnapshotFromJournal(journalPath);
  if (latest === null) return new Response(null, { status: 204 });
  return Response.json(latest, { status: 200 });
}
