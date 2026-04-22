import { discovery } from '@llamactl/core';
import { getNodeClient, isLocalDispatch } from '../dispatcher.js';

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

const USAGE = `Usage: llamactl discover [filter] [profile] [limit]

Queries Hugging Face for GGUF discovery candidates and classifies them
against your curated catalog.

Filters:
  all                     every row the feed returns
  other | new             (default) rows whose repo isn't already catalogued
  curated | known         rows whose repo is already catalogued
  reasoning | multimodal  filter by class
  general
  fits-16g | fits-32g     rows that fit the named memory envelope
  fits-48g                (forces the matching profile)
  <anything else>         accepted when it matches the class or appears
                          anywhere in the repo id (fallthrough)

Profile: current | all | mac-mini-16g | balanced | macbook-pro-48g.
Limit: number of HF repos to scan. Defaults to LOCAL_AI_DISCOVERY_LIMIT.
`;

export async function runDiscover(args: string[]): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const filter = args[0] ?? 'other';
  const requestedProfile = args[1];
  const limitArg = args[2];
  const limit = limitArg ? Number.parseInt(limitArg, 10) : undefined;

  // Honor --node: the agent's `discover` procedure scans HF + classifies
  // results against the target node's machine profile, so the
  // catalog/fit columns line up with the node where the model would
  // actually run. Local dispatch keeps the original in-process call.
  const result = !isLocalDispatch()
    ? await getNodeClient().discover.query({
        ...(filter !== undefined ? { filter } : {}),
        ...(requestedProfile !== undefined ? { profile: requestedProfile } : {}),
        ...(limit !== undefined ? { limit } : {}),
      })
    : await discovery.discover({
        filter,
        requestedProfile,
        limit,
      });

  if (!result) {
    process.stderr.write('Unable to fetch Hugging Face discovery feed\n');
    return 1;
  }

  process.stdout.write(
    `filter=${result.filter} profile=${result.profile} author=${result.author} limit=${result.limit}\n`,
  );

  if (result.rows.length === 0) {
    process.stdout.write('  no-discovery-results\n');
    return 0;
  }

  for (const row of result.rows) {
    const cls = padRight(row.class, 11);
    const fit = padRight(row.fit, 10);
    const status = padRight(row.catalogStatus, 11);
    const quant = padRight(row.quant, 6);
    const size = padRight(row.estimatedSize, 10);
    const vision = padRight(row.visionStatus, 11);
    process.stdout.write(
      `  ${cls} ${fit} status=${status} quant=${quant} size=${size} vision=${vision} repo=${row.repo}\n`,
    );
    process.stdout.write(
      `             file=${row.file} downloads=${row.downloads} likes=${row.likes} updated=${row.updated} task=${row.pipeline} rel=${row.rel}\n`,
    );
    if (row.catalogStatus === 'new') {
      // Keep the shell-compatible hint until `llamactl candidate test`
      // lands; today the user still has `llama-candidate-test` in zsh.
      process.stdout.write(`             try: llama-candidate-test ${row.repo}\n`);
    }
  }

  return 0;
}
