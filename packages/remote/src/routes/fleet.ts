import {
  defaultFleetJournalPath,
  readLatestFleetSnapshotFromJournal,
} from "@llamactl/fleet-supervisor";

export interface FleetSnapshotRouteOptions {
  journalPath?: string;
}

export function readFleetSnapshot(
  opts: FleetSnapshotRouteOptions = {},
): ReturnType<typeof readLatestFleetSnapshotFromJournal> {
  const journalPath = opts.journalPath ?? defaultFleetJournalPath();
  return readLatestFleetSnapshotFromJournal(journalPath);
}

export function handleFleetSnapshotRoute(
  _req: Request,
  opts: FleetSnapshotRouteOptions = {},
): Response {
  const latest = readFleetSnapshot(opts);
  if (latest === null) return new Response(null, { status: 204 });
  return Response.json(latest, { status: 200 });
}
