import { recommendations } from '@llamactl/core';

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function formatRow(row: recommendations.RecommendationRow): string {
  const target = padRight(row.target, 9);
  const label = padRight(row.label, 24);
  const className = padRight(row.class, 11);
  const scope = padRight(row.scope, 16);
  const quant = padRight(row.quant, 6);
  const ctx = padRight(row.ctx, 6);
  const promotedNote =
    row.promoted === 'env'
      ? ' promoted=env'
      : row.promoted === 'file'
      ? ' promoted=file'
      : '';
  return `  ${target} ${label} class=${className} scope=${scope} quant=${quant} ctx=${ctx} model=${row.rel}${promotedNote}`;
}

const USAGE = `Usage: llamactl recommendations [current|all|<profile>]

Prints the recommended preset ladder (best, vision, balanced, fast, qwen,
qwen27) per machine profile, with class, scope, quant, ctx, rel, any
active env/file promotion, and a live Hugging Face summary when the
rel is catalogued and HF lookups are enabled.
`;

export async function runRecommendations(args: string[]): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const profiles = recommendations.expandRequestedProfile(args[0]);

  for (let i = 0; i < profiles.length; i += 1) {
    const profile = profiles[i];
    if (!profile) continue;
    const rows = await recommendations.recommendationsWithHf(profile);
    process.stdout.write(`profile=${profile}\n`);
    for (const row of rows) {
      process.stdout.write(`${formatRow(row)}\n`);
      if (row.hf) process.stdout.write(`             hf=${row.hf}\n`);
    }
    process.stdout.write('\n');
  }

  return 0;
}
